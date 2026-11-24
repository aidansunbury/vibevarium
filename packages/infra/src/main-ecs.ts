import * as AWS from "@alchemy.run/aws";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";
import { EcsInfra } from "./ecs.ts";

// ECS Fargate stack for the Vibevarium auth server + control plane.
// Deploy alongside the EC2 stack, verify healthy, cut DNS over, retire EC2.
//
//   TERRARIUM_DOMAIN       — root domain (e.g. vibevarium.com)
//   ACM_CERTIFICATE_ARN    — ACM cert covering api.<domain> + auth.<domain>
//   DATABASE_URL_ARN       — full SM ARN of the control-plane DATABASE_URL secret
//   CASDOOR_ADMIN_PASSWORD_ARN — full SM ARN of the casdoor admin password secret
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

export default Alchemy.Stack(
  "VibevariumEcs",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const domain = yield* requireEnv("TERRARIUM_DOMAIN");
    const certificateArn = yield* requireEnv("ACM_CERTIFICATE_ARN");

    // The monorepo root is the Docker build context (the control-plane
    // Dockerfile copies packages/ from it). From src/main-ecs.ts, up 3 levels.
    const controlPlaneContext = fileURLToPath(new URL("../../../", import.meta.url));
    const controlPlaneDockerfile = fileURLToPath(new URL("../../control-plane/Dockerfile", import.meta.url));

    const ecsDatabaseUrlArn = yield* requireEnv("ECS_DATABASE_URL_ARN");
    const casdoorDatabaseUrlArn = yield* requireEnv("CASDOOR_DATABASE_URL_ARN");
    const casdoorAdminPasswordArn = yield* requireEnv("CASDOOR_ADMIN_PASSWORD_ARN");
    const cloudflareApiTokenArn = yield* requireEnv("CLOUDFLARE_API_TOKEN_ARN");

    const ecs = yield* EcsInfra({
      controlPlaneContext,
      controlPlaneDockerfile,
      domain,
      certificateArn,
      ecsDatabaseUrlArn,
      casdoorDatabaseUrlArn,
      casdoorAdminPasswordArn,
      cloudflareApiTokenArn,
    });

    return {
      domain,
      albDnsName: ecs.albDnsName,
      clusterArn: ecs.clusterArn,
      dbEndpoint: ecs.dbEndpoint,
      apiUrl: `https://api.${domain}`,
      authUrl: `https://auth.${domain}`,
    };
  }),
);
