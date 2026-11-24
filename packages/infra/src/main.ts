import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AwsInfra } from "./aws.ts";
import { Dns } from "./dns.ts";

// ── Configuration ─────────────────────────────────────────────────────────
// All values come from env vars; nothing is hardcoded.
//
//   TERRARIUM_DOMAIN       — root domain (e.g. vibevarium.com)
//   CLOUDFLARE_ZONE_ID     — zone ID for the domain
//   CLOUDFLARE_ACCOUNT_ID  — Cloudflare account ID
//   TERRARIUM_SSH_CIDR     — CIDR allowed to SSH (default 0.0.0.0/0, tighten!)
//   TERRARIUM_EC2_TYPE     — EC2 instance type (default t3.small)
//   TERRARIUM_RDS_TYPE     — RDS instance class (default db.t4g.micro)
//   AWS_PROFILE            — AWS CLI profile (e.g. givefront-dev)
//   AWS_REGION             — AWS region (e.g. us-east-1)

const requireEnv = (name: string) =>
  Effect.gen(function* () {
    const value = process.env[name];
    if (!value) {
      return yield* Effect.die(new Error(`Missing required env var: ${name}`));
    }
    return value;
  });

const optionalEnv = (name: string, fallback: string) => process.env[name] ?? fallback;

export default Alchemy.Stack(
  "VibevariumInfra",
  {
    providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const domain = yield* requireEnv("TERRARIUM_DOMAIN");
    const zoneId = yield* requireEnv("CLOUDFLARE_ZONE_ID");

    // 1. AWS infrastructure (bootstrap.sh installs Docker/AWS CLI on the box)
    const bootstrap = readFileSync(fileURLToPath(new URL("../scripts/bootstrap.sh", import.meta.url)), "utf8");
    const aws = yield* AwsInfra({
      sshCidr: optionalEnv("TERRARIUM_SSH_CIDR", "0.0.0.0/0"),
      instanceType: optionalEnv("TERRARIUM_EC2_TYPE", "t3.small"),
      dbInstanceClass: optionalEnv("TERRARIUM_RDS_TYPE", "db.t4g.micro"),
      userData: bootstrap,
    });

    // 2. DNS records pointing at the Elastic IP
    const dns = yield* Dns({
      zoneId,
      domain,
      ip: aws.elasticIp,
    });

    return {
      domain,
      authUrl: `https://auth.${domain}`,
      platformUrl: `https://platform.${domain}`,
      elasticIp: aws.elasticIp,
      elasticIpAllocationId: aws.elasticIpAllocationId,
      instanceId: aws.instanceId,
      instancePublicDns: aws.instancePublicDns,
      dbEndpoint: aws.dbEndpoint,
      dbPort: aws.dbPort,
      dbMasterSecretArn: aws.dbMasterSecretArn,
      casdoorDatabase: aws.casdoorDatabase,
      controlPlaneDatabase: aws.controlPlaneDatabase,
      keyPairName: aws.keyPairName,
      sshPrivateKey: aws.sshPrivateKey,
      ec2SecurityGroupId: aws.ec2SecurityGroupId,
      rdsSecurityGroupId: aws.rdsSecurityGroupId,
      authRecordId: dns.authRecordId,
      platformRecordId: dns.platformRecordId,
    };
  }),
);
