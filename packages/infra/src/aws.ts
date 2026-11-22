import * as AWS from "@alchemy.run/aws";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export interface AwsInfraOptions {
  /** CIDR allowed to SSH into the EC2 instance. Document your office/home IP here. */
  readonly sshCidr?: string;
  /** EC2 instance type. */
  readonly instanceType?: string;
  /** RDS instance class. */
  readonly dbInstanceClass?: string;
  /** Postgres master password. If omitted, RDS manages it in Secrets Manager. */
  readonly dbPassword?: Redacted.Redacted<string>;
  /**
   * EC2 user-data script (scripts/bootstrap.sh contents). Changes force
   * instance replacement — EC2 never re-runs user data in place.
   */
  readonly userData?: string;
}

/**
 * AWS infrastructure for the Terrarium auth server + control plane.
 *
 * Layout: one small VPC (2 AZs) with public + private subnets, no NAT gateway
 * (the single EC2 lives in a public subnet with an Elastic IP; RDS sits in the
 * private subnets and is only reachable from the EC2 security group).
 *
 * One EC2 (Ubuntu 24.04, t3.small) runs Docker; one RDS Postgres (db.t4g.micro)
 * hosts the `logto` database (initial) and `control_plane` (created by the
 * bootstrap script on the box — RDS only creates one initial database).
 *
 * The Elastic IP is allocated here; the association to the instance is done by
 * `scripts/deploy.sh` (alchemy beta.87 has no EIPAssociation resource).
 */
export const AwsInfra = (options: AwsInfraOptions = {}) =>
  Effect.gen(function* () {
    const sshCidr = options.sshCidr ?? "0.0.0.0/0"; // TODO: restrict to your IP
    const instanceType = options.instanceType ?? "t3.small";
    const dbInstanceClass = options.dbInstanceClass ?? "db.t4g.micro";

    // --- Network -----------------------------------------------------------
    const network = yield* AWS.EC2.Network("Network", {
      cidrBlock: "10.0.0.0/16",
      availabilityZones: 2,
      nat: "none", // EC2 is public; RDS needs no outbound internet
    });

    // --- Security groups ---------------------------------------------------
    const ec2Sg = yield* AWS.EC2.SecurityGroup("Ec2Sg", {
      vpcId: network.vpcId,
      description: "Terrarium control-plane EC2",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 22,
          toPort: 22,
          cidrIpv4: sshCidr,
          description: "SSH (restrict via sshCidr)",
        },
        {
          ipProtocol: "tcp",
          fromPort: 80,
          toPort: 80,
          cidrIpv4: "0.0.0.0/0",
          description: "HTTP (Caddy ACME + redirect)",
        },
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "0.0.0.0/0",
          description: "HTTPS",
        },
      ],
      tags: { Name: "terrarium-ec2" },
    });

    const rdsSg = yield* AWS.EC2.SecurityGroup("RdsSg", {
      vpcId: network.vpcId,
      description: "Terrarium RDS - reachable from EC2 only",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 5432,
          toPort: 5432,
          referencedGroupId: ec2Sg.groupId,
          description: "Postgres from EC2 SG",
        },
      ],
      tags: { Name: "terrarium-rds" },
    });

    // --- SSH key pair ------------------------------------------------------
    const keyPair = yield* AWS.EC2.KeyPair("SshKey", {
      keyType: "ed25519",
      tags: { Name: "terrarium-ssh" },
    });

    // --- RDS Postgres ------------------------------------------------------
    const subnetGroup = yield* AWS.RDS.DBSubnetGroup("DbSubnets", {
      description: "Terrarium private subnets",
      subnetIds: network.privateSubnetIds,
    });

    const db = yield* AWS.RDS.DBInstance("Postgres", {
      engine: "postgres",
      engineVersion: "16",
      dbInstanceClass,
      dbName: "logto", // initial database; control_plane is created by bootstrap
      masterUsername: "postgres",
      ...(options.dbPassword === undefined
        ? { manageMasterUserPassword: true }
        : { masterUserPassword: options.dbPassword }),
      allocatedStorage: 20,
      storageType: "gp3",
      publiclyAccessible: false,
      dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
      vpcSecurityGroupIds: [rdsSg.groupId],
      backupRetentionPeriod: "7 days",
      skipFinalSnapshot: false, // take a final snapshot on destroy — cheap insurance
      tags: { Name: "terrarium-postgres" },
    });

    // --- Elastic IP (stable DNS target) ------------------------------------
    const eip = yield* AWS.EC2.EIP("PublicIp", {
      tags: { Name: "terrarium-ec2-eip" },
    });

    // --- IAM: EC2 instance role with read access to /terrarium/prod/* ------
    // The control plane resolves its runtime config from AWS Secrets Manager
    // (SECRETS_PROVIDER=aws) via the instance profile — no static AWS keys.
    const instanceRole = yield* AWS.IAM.Role("Ec2Role", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "ec2.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        }],
      },
      inlinePolicies: {
        TerrariumSecretsRead: {
          Version: "2012-10-17",
          Statement: [{
            Effect: "Allow",
            Action: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
            Resource: ["arn:aws:secretsmanager:us-east-1:412215357683:secret:/terrarium/prod/*"],
          }],
        },
      },
      tags: { Name: "terrarium-ec2-role" },
    });

    const instanceProfile = yield* AWS.IAM.InstanceProfile("Ec2Profile", {
      roleName: instanceRole.roleName,
      tags: { Name: "terrarium-ec2-profile" },
    });

    // --- EC2 instance ------------------------------------------------------
    const instance = yield* AWS.EC2.Instance("Server", {
      imageId: AWS.EC2.ubuntu2404(),
      instanceType,
      subnetId: network.publicSubnetIds[0],
      securityGroupIds: [ec2Sg.groupId],
      keyName: keyPair.keyName,
      instanceProfileName: instanceProfile.instanceProfileName,
      ...(options.userData === undefined ? {} : { userData: options.userData }),
      associatePublicIpAddress: true, // ephemeral until EIP is associated
      metadataOptions: {
        httpTokens: "required", // IMDSv2
      },
      // userData: bootstrap.sh is piped in by the caller (see main.ts) so the
      // script lives in a real file we can lint/read, not an inline string.
      tags: { Name: "terrarium-server" },
    });

    return {
      vpcId: network.vpcId,
      publicSubnetIds: network.publicSubnetIds,
      privateSubnetIds: network.privateSubnetIds,
      ec2SecurityGroupId: ec2Sg.groupId,
      rdsSecurityGroupId: rdsSg.groupId,
      keyPairName: keyPair.keyName,
      // Redacted PEM — written to .secrets/ by main.ts.
      sshPrivateKey: keyPair.privateKey,
      ec2RoleArn: instanceRole.roleArn,
      instanceProfileName: instanceProfile.instanceProfileName,
      instanceId: instance.instanceId,
      instancePublicDns: instance.publicDnsName,
      elasticIp: eip.publicIp,
      elasticIpAllocationId: eip.allocationId,
      dbEndpoint: db.endpointAddress,
      dbPort: db.endpointPort ?? 5432,
      dbMasterSecretArn: db.masterUserSecretArn,
      logtoDatabase: "logto",
      controlPlaneDatabase: "control_plane",
      // URL-shaped helpers for downstream consumers (password resolved at
      // deploy time by the bootstrap script from Secrets Manager).
      dbHost: Output.interpolate`${db.endpointAddress}`,
    };
  });


