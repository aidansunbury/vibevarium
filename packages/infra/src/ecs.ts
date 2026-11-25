import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";

export interface EcsInfraOptions {
  /** Docker build context for the control-plane image (the monorepo root). */
  readonly controlPlaneContext: string;
  /** Absolute path to the control-plane Dockerfile (dockerfile resolves cwd-relative). */
  readonly controlPlaneDockerfile: string;
  /** The domain (e.g. vibevarium.com) — drives the api./auth. hostnames. */
  readonly domain: string;
  /** ACM certificate ARN for the shared 443 listener (covers api. + auth.). */
  readonly certificateArn: string;
  /** Full SM ARN of THIS stack's control-plane DATABASE_URL (written at deploy). */
  readonly ecsDatabaseUrlArn: string;
  /** Full SM ARN of THIS stack's casdoor dataSourceName (written at deploy). */
  readonly casdoorDatabaseUrlArn: string;
  /** Full SM ARN of the casdoor admin password secret. */
  readonly casdoorAdminPasswordArn: string;
  /** Full SM ARN of the Cloudflare API token. */
  readonly cloudflareApiTokenArn: string;
  /** Managed policy ARN granting the task role SM read+write on /vibevarium/prod/*. */
  readonly secretsPolicyArn: string;
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
    // The Service synthesizes its own task + execution roles; SM access comes
    // from the execution-role secrets policy built from the `secrets` prop.
    const casdoorService = yield* AWS.ECS.Service("CasdoorService", {
      cluster,
      image: "casbin/casdoor:latest",
      port: 8000,
      desiredCount: 1,
      deploymentConfiguration: {
        deploymentCircuitBreaker: { enable: true, rollback: true },
      },
      vpcId: network.vpcId,
      subnets: network.publicSubnetIds,
      securityGroups: [tasksSg.groupId],
      assignPublicIp: true,
      env: {
        RUNNING_IN_DOCKER: "true",
        runmode: "prod",
        driverName: "postgres",
        dbName: "casdoor",
        origin: `https://auth.${options.domain}`,
      },
      secrets: {
        dataSourceName: options.casdoorDatabaseUrlArn,
        initAdminPassword: options.casdoorAdminPasswordArn,
      },
      // The synthesized task role needs broad SM read for boot-time secret
      // resolution (loadBootSecrets fetches every boot secret via the task role).
      taskRoleManagedPolicyArns: [options.secretsPolicyArn],
      healthCheckPath: "/api/health",
      loadBalancer: {
        listener,
        rules: [{ host: `auth.${options.domain}`, priority: 100 }],
      },
    });

    // --- control-plane service (built from our Dockerfile → ECR) → api.<domain>
    const controlPlaneService = yield* AWS.ECS.Service("ControlPlaneService", {
      cluster,
      context: options.controlPlaneContext,
      dockerfile: options.controlPlaneDockerfile,
      port: 4100,
      desiredCount: 1,
      deploymentConfiguration: {
        deploymentCircuitBreaker: { enable: true, rollback: true },
      },
      vpcId: network.vpcId,
      subnets: network.publicSubnetIds,
      securityGroups: [tasksSg.groupId],
      assignPublicIp: true,
      env: {
        PORT: "4100",
        HOST: "0.0.0.0",
        TERRARIUM_AUTH_PROVIDER: "casdoor",
        TERRARIUM_ISSUER: `https://auth.${options.domain}`,
        CONTROL_PLANE_BASE_URL: `https://api.${options.domain}`,
        GUI_ORIGIN: `https://platform.${options.domain}`,
        COOKIE_DOMAIN: `.${options.domain}`,
        PLATFORM_OIDC_AUDIENCE: `https://mcp.${options.domain}`,
        TERRARIUM_CONNECTION_PROVIDERS: "github,linear",
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
        // Full postgres:// DSN for THIS stack's RDS (deploy script reads the
        // master password from the RDS-managed secret and writes this).
        DATABASE_URL: options.ecsDatabaseUrlArn,
        // RouterDirectory reads CLOUDFLARE_API_TOKEN from env (Fargate has no
        // Alchemy profile file).
        CLOUDFLARE_API_TOKEN: options.cloudflareApiTokenArn,
      },
      taskRoleManagedPolicyArns: [options.secretsPolicyArn],
      healthCheckPath: "/health",
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
      clusterArn: cluster.clusterArn,
      casdoorServiceArn: casdoorService.serviceArn,
      controlPlaneServiceArn: controlPlaneService.serviceArn,
    };
  });
