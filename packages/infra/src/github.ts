import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const owner = "aidansunbury";
const repository = "vibevarium";

/** One-shot, admin-run stack for the credentials and variables used by GitHub Actions. */
export default Alchemy.Stack(
  "VibevariumCi",
  {
    providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers(), GitHub.providers()),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
    const zoneId = yield* Config.String("CLOUDFLARE_ZONE_ID");
    const region = yield* Config.String("AWS_REGION");

    const oidc = yield* AWS.IAM.OpenIDConnectProvider("GitHubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIDList: ["sts.amazonaws.com"],
      thumbprintList: ["6938fd4d98bab03faadb97b34396831e3780aea1"],
    });

    const role = yield* AWS.IAM.Role("GitHubActionsRole", {
      roleName: "vibevarium-github-actions",
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Federated: oidc.openIDConnectProviderArn },
          Action: ["sts:AssumeRoleWithWebIdentity"],
          Condition: {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            },
            StringLike: {
              "token.actions.githubusercontent.com:sub": [
                `repo:${owner}/${repository}:*`,
                // GitHub's current OIDC subject format uses stable numeric owner/repo IDs.
                "repo:aidansunbury@64103161/vibevarium@1465974306:*",
              ],
            },
          },
        }],
      },
      managedPolicyArns: ["arn:aws:iam::aws:policy/AdministratorAccess"],
    });

    const apiToken = yield* Cloudflare.ApiToken.AccountApiToken("GitHubActionsToken", {
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Account Settings Write",
            "D1 Write",
            "Pages Write",
            "Queues Write",
            "Secrets Store Write",
            "Workers KV Storage Write",
            "Workers R2 Storage Write",
            "Workers Scripts Write",
            "Workers Tail Read",
          ],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
        {
          effect: "allow",
          permissionGroups: ["DNS Write", "Workers Routes Write"],
          resources: { [`com.cloudflare.api.account.zone.${zoneId}`]: "*" },
        },
      ],
    });

    yield* GitHub.Secret("CloudflareApiToken", {
      owner,
      repository,
      name: "CLOUDFLARE_API_TOKEN",
      value: apiToken.value,
    });

    const variables = {
      AWS_ROLE_ARN: role.roleArn,
      AWS_REGION: region,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_ZONE_ID: zoneId,
      TERRARIUM_DOMAIN: yield* Config.String("TERRARIUM_DOMAIN"),
      ACM_CERTIFICATE_ARN: yield* Config.String("ACM_CERTIFICATE_ARN"),
      ECS_DATABASE_URL_ARN: yield* Config.String("ECS_DATABASE_URL_ARN"),
      CASDOOR_DATABASE_URL_ARN: yield* Config.String("CASDOOR_DATABASE_URL_ARN"),
      CASDOOR_ADMIN_PASSWORD_ARN: yield* Config.String("CASDOOR_ADMIN_PASSWORD_ARN"),
      CLOUDFLARE_API_TOKEN_ARN: yield* Config.String("CLOUDFLARE_API_TOKEN_ARN"),
      SECRETS_POLICY_ARN: yield* Config.String("SECRETS_POLICY_ARN"),
    };

    yield* Effect.forEach(
      Object.entries(variables),
      ([name, value]) => GitHub.Variable(name, { owner, repository, name, value }),
      { discard: true },
    );

    return { roleArn: role.roleArn };
  }),
);
