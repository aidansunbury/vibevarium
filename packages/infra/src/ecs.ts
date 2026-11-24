import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";

export interface EcsInfraOptions {
  /** Docker build context for the control-plane image (the monorepo root). */
  readonly controlPlaneContext: string;
  /** The domain (e.g. vibevarium.com) — drives the api./auth. hostnames. */
  readonly domain: string;
  /** ACM certificate ARN for the shared 443 listener (covers api. + auth.). */
  readonly certificateArn: string;
  /** RDS instance class. */
  readonly dbInstanceClass?: string;
}

/**
 * ECS Fargate infrastructure for the Vibevarium auth server + control plane.
 *
 * Replaces the single-EC2 docker-compose stack:
 * - One VPC (2 AZs, public + private subnets, no NAT).
 * - One RDS Postgres in the private subnets (control_plane + casdoor DBs).
 * - One ECS Fargate cluster. Two services, each a pre-built registry image:
 *     - casdoor (casbin/casdoor image) → auth.<domain>
 *     - control-plane (our ECR image)   → api.<domain>
 * - A stack-owned shared public ALB with a 443/HTTPS listener (ACM cert);
 *   each service attaches a host rule for its domain. TLS terminates at the
 *   ALB — the EC2 stack's Caddy is dropped.
 * - A task IAM role with Secrets Manager read+write on /vibevarium/prod/*.
 * - The RDS SG allows Postgres from the ECS tasks' SG.
 */
export const EcsInfra = (options: EcsInfraOptions) =>
  Effect.gen(function* () {
    const dbInstanceClass = options.dbInstanceClass ?? "db.t4g.micro";

    // --- Network -----------------------------------------------------------
    const network = yield* AWS.EC2.Network("Network", {
      cidrBlock: "10.0.0.0/16",
      availabilityZones: 2,
      nat: "none",
    });

    // --- Security groups ----------------------------------------------------
    const albSg = yield* AWS.EC2.SecurityGroup("AlbSg", {
      vpcId: network.vpcId,
      description: "Vibevarium ALB ingress",
      ingress: [
        { ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIpv4: "0.0.0.0/0", description: "HTTPS" },
      ],
      tags: { Name: "vibevarium-alb" },
    });

    const tasksSg = yield* AWS.EC2.SecurityGroup("TasksSg", {
      vpcId: network.vpcId,
      description: "Vibevarium ECS tasks",
      ingress: [
        { ipProtocol: "tcp", fromPort: 8000, toPort: 8000, referencedGroupId: albSg.groupId, description: "casdoor from ALB" },
        { ipProtocol: "tcp", fromPort: 4100, toPort: 4100, referencedGroupId: albSg.groupId, description: "control-plane from ALB" },
      ],
      tags: { Name: "vibevarium-ecs-tasks" },
    });

    const rdsSg = yield* AWS.EC2.SecurityGroup("RdsSg", {
      vpcId: network.vpcId,
      description: "Vibevarium RDS - reachable from ECS tasks only",
      ingress: [
        { ipProtocol: "tcp", fromPort: 5432, toPort: 5432, referencedGroupId: tasksSg.groupId, description: "Postgres from ECS tasks" },
      ],
      tags: { Name: "vibevarium-rds" },
    });

    // --- RDS Postgres -------------------------------------------------------
    const subnetGroup = yield* AWS.RDS.DBSubnetGroup("DbSubnets", {
      description: "Vibevarium private subnets",
      subnetIds: network.privateSubnetIds,
    });

    const db = yield* AWS.RDS.DBInstance("Postgres", {
      engine: "postgres",
      engineVersion: "16",
      dbInstanceClass,
      dbName: "postgres",
      masterUsername: "postgres",
      manageMasterUserPassword: true,
      allocatedStorage: 20,
      storageType: "gp3",
      publiclyAccessible: false,
      dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
      vpcSecurityGroupIds: [rdsSg.groupId],
      backupRetentionPeriod: "7 days",
      skipFinalSnapshot: false,
      tags: { Name: "vibevarium-postgres" },
    });

    // --- IAM: task role with SM read+write on /vibevarium/prod/* ------------
    const taskRole = yield* AWS.IAM.Role("TaskRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: ["sts:AssumeRole"] }],
      },
      inlinePolicies: {
        VibevariumSecrets: {
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "SecretsRead",
              Effect: "Allow",
              Action: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
              Resource: ["arn:aws:secretsmanager:us-east-1:412215357683:secret:/vibevarium/prod/*"],
            },
            {
              Sid: "SecretsGuiWrite",
              Effect: "Allow",
              Action: ["secretsmanager:PutSecretValue", "secretsmanager:CreateSecret", "secretsmanager:DeleteSecret", "secretsmanager:TagResource"],
              Resource: [
                "arn:aws:secretsmanager:us-east-1:412215357683:secret:/vibevarium/prod/*",
                "arn:aws:secretsmanager:us-east-1:412215357683:secret:/vibevarium/prod/*-??????",
              ],
            },
            { Sid: "SecretsGuiListAll", Effect: "Allow", Action: ["secretsmanager:ListSecrets"], Resource: "*" },
          ],
        },
      },
      tags: { Name: "vibevarium-ecs-task-role" },
    });

    // --- ECS cluster ---------------------------------------------------------
    const cluster = yield* AWS.ECS.Cluster("Cluster", {
      tags: { Name: "vibevarium" },
    });

    // --- Shared public ALB + 443 listener ------------------------------------
    const alb = yield* AWS.ELBv2.LoadBalancer("Alb", {
      type: "application",
      scheme: "internet-facing",
      subnets: network.publicSubnetIds,
      securityGroups: [albSg.groupId],
    });

    const listener = yield* AWS.ELBv2.Listener("HttpsListener", {
      loadBalancerArn: alb.loadBalancerArn,
      port: 443,
      protocol: "HTTPS",
      certificates: [options.certificateArn],
      defaultActions: [
        { type: "fixedResponse", statusCode: "404", contentType: "text/plain", messageBody: "no route" },
      ],
    });

    // --- casdoor service (registry image) → auth.<domain> ---------------------
    const casdoorService = yield* AWS.ECS.Service("CasdoorService", {
      cluster,
      image: "casbin/casdoor:latest",
      port: 8000,
      desiredCount: 1,
      vpcId: network.vpcId,
      subnets: network.publicSubnetIds,
      securityGroups: [tasksSg.groupId],
      assignPublicIp: true,
      role: taskRole.roleArn,
      env: {
        RUNNING_IN_DOCKER: "true",
        runmode: "prod",
        driverName: "postgres",
        dbName: "casdoor",
        origin: `https://auth.${options.domain}`,
      },
      secrets: {
        // dataSourceName: full postgres DSN for the casdoor db. The deploy
        // script writes this (RDS endpoint + master password, dbname=casdoor)
        // to SM at /vibevarium/prod/casdoor-database-url.
        dataSourceName: "/vibevarium/prod/casdoor-database-url",
        initAdminPassword: "/vibevarium/prod/casdoor-admin-password",
      },
      loadBalancer: {
        listener,
        rules: [{ host: `auth.${options.domain}`, priority: 100 }],
      },
    });

    // --- control-plane service (built from our Dockerfile → ECR) → api.<domain>
    const controlPlaneService = yield* AWS.ECS.Service("ControlPlaneService", {
      cluster,
      context: options.controlPlaneContext,
      dockerfile: "packages/control-plane/Dockerfile",
      port: 4100,
      desiredCount: 1,
      vpcId: network.vpcId,
      subnets: network.publicSubnetIds,
      securityGroups: [tasksSg.groupId],
      assignPublicIp: true,
      role: taskRole.roleArn,
      env: {
        PORT: "4100",
        HOST: "0.0.0.0",
        TERRARIUM_AUTH_PROVIDER: "casdoor",
        TERRARIUM_ISSUER: `https://auth.${options.domain}`,
        CONTROL_PLANE_BASE_URL: `https://api.${options.domain}`,
        GUI_ORIGIN: `https://platform.${options.domain}`,
        COOKIE_DOMAIN: `.${options.domain}`,
        PLATFORM_OIDC_AUDIENCE: `https://mcp.${options.domain}`,
        GIT_PROVIDER: "github",
        GITHUB_APP_INSTALLATION_ID: "184285119",
        GITHUB_ORG: "terrarium-sandbox",
        CLOUDFLARE_ACCOUNT_ID: "7bbaa8f97d6ababf1a5e29eb79491ce3",
        CLOUDFLARE_WORKERS_SUBDOMAIN: "modal-opencode-test",
        CLOUDFLARE_ZONE_ID: "c6ae3b555628f3c6c0fb3883c479dcc4",
        ROUTER_KV_NAMESPACE_ID: "7953882922294f5b84298ba7d8794fe4",
        ALCHEMY_HOME: "/data/alchemy-home",
        TERRARIUM_DOMAIN: options.domain,
        SECRETS_PROVIDER: "aws",
        AWS_REGION: "us-east-1",
        SECRETS_PREFIX: "/vibevarium/prod/",
        DISCOVERY_INTERVAL_MS: "30000",
      },
      secrets: {
        DATABASE_URL: "vibevarium/prod/database-url",
      },
      loadBalancer: {
        listener,
        rules: [{ host: `api.${options.domain}`, priority: 200 }],
      },
    });

    return {
      vpcId: network.vpcId,
      publicSubnetIds: network.publicSubnetIds,
      privateSubnetIds: network.privateSubnetIds,
      albSecurityGroupId: albSg.groupId,
      tasksSecurityGroupId: tasksSg.groupId,
      rdsSecurityGroupId: rdsSg.groupId,
      albDnsName: alb.dnsName,
      dbEndpoint: db.endpointAddress,
      dbPort: db.endpointPort ?? 5432,
      dbMasterSecretArn: db.masterUserSecretArn,
      taskRoleArn: taskRole.roleArn,
      clusterArn: cluster.clusterArn,
      casdoorServiceArn: casdoorService.serviceArn,
      controlPlaneServiceArn: controlPlaneService.serviceArn,
    };
  });
