import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as HttpServer from "effect/http/HttpServer";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it, vi } from "vitest";
import { Registry } from "./registry/index.ts";
import { controlPlaneServer } from "./server.ts";
import { Database } from "./store/database.ts";
import { connectionGrants, connections } from "./store/schema.ts";

it("derives the app from a signed token and checks the OAuth grant for the verified user", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "fixture" };
  let issuer: string;
  const upstream = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/.well-known/openid-configuration") {
      response.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
    } else if (request.url === "/jwks") {
      response.end(JSON.stringify({ keys: [jwk] }));
    } else {
      response.end(JSON.stringify({
        authorization: request.headers.authorization,
        delegatedTokenForwarded: "x-vibevarium-user-authorization" in request.headers,
      }));
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (address === null || typeof address === "string") throw new Error("Missing upstream port");
  issuer = `http://127.0.0.1:${address.port}`;

  const scope = await Effect.runPromise(Scope.make());
  vi.stubEnv("TEST_SHARED_PROXY_TOKEN", "shared-upstream");
  try {
    const audience = "https://api.example.test/mcp";
    const context = await Effect.runPromise(Effect.provideService(Layer.build(controlPlaneServer({
      discoveryIntervalMs: 0,
      oidc: { issuer, audience },
      appSecrets: { tickets: "legacy-secret" },
      connectionsConfig: {
        secrets: {
          shared: { ref: "TEST_SHARED_PROXY_TOKEN" },
          provider: { ref: "TEST_PROVIDER_SECRET" },
          encryption: { ref: "TEST_OAUTH_ENCRYPTION_KEY" },
        },
        oauthTokenEncryption: "encryption",
        proxiedSecrets: {
          shared: { displayName: "Shared", baseUrl: issuer, secret: "shared", authHeader: "authorization_bearer" },
        },
        oauthProviders: {
          oauth: {
            displayName: "OAuth",
            authorizeUrl: `${issuer}/authorize`,
            tokenUrl: `${issuer}/token`,
            userinfoUrl: `${issuer}/userinfo`,
            apiBaseUrl: issuer,
            clientIdRef: "TEST_PROVIDER_CLIENT",
            clientSecret: "provider",
            defaultScopes: ["read"],
          },
        },
        webhooks: {},
        webhookDeliverySecrets: {},
      },
    })), Scope.Scope, scope));
    const base = HttpServer.formatAddress(Context.get(context, HttpServer.HttpServer).address).replace(/\/$/, "");
    const database = Context.get(context, Database);
    const clientId = "tickets-client";
    const appSubject = `admin/vibevarium-m2m-${clientId}`;
    const mint = (sub: string, aud: string, azp?: string) =>
      new SignJWT({ azp, tokenType: "access-token" }).setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .setIssuer(issuer).setAudience(aud).setSubject(sub).setExpirationTime("1h").sign(privateKey);
    const bearer = `Bearer ${await mint(appSubject, `${audience}/app`, clientId)}`;
    const alice = `Bearer ${await mint("alice", audience)}`;
    const bob = `Bearer ${await mint("bob", audience)}`;
    const request = (path: string, authorization: string, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { headers: { authorization, ...headers } });

    const registryEffect = <A>(run: (registry: Registry["Service"]) => Effect.Effect<A>) =>
      Effect.runPromise(Effect.flatMap(Registry, run).pipe(
        Effect.provide(Registry.layer),
        Effect.provideService(Database, database),
      ));

    expect((await request("/proxy/shared/status", bearer)).status).toBe(401);
    await registryEffect((registry) => registry.register(
      { name: "tickets", url: `${issuer}/mcp` },
      { m2mClientId: clientId, oidcRegistrationToken: "private-registration-token" },
    ));
    expect((await request("/proxy/shared/status", bearer)).status).toBe(403);
    expect((await request("/proxy/shared/status", alice, {
      "x-vibevarium-app": "tickets",
      "x-vibevarium-app-secret": "legacy-secret",
      "x-vibevarium-on-behalf-of-app": "tickets",
    })).status).toBe(401);
    expect((await request("/whoami", `Bearer ${await mint(appSubject, audience, clientId)}`)).status).toBe(401);

    const grant = await fetch(`${base}/integrations/shared/grants`, {
      method: "POST",
      headers: { authorization: alice, "content-type": "application/json" },
      body: JSON.stringify({ app: "tickets" }),
    });
    expect(grant.status).toBe(201);
    const shared = await request("/proxy/shared/status", bearer, { "x-vibevarium-app": "some-other-app" });
    expect(shared.status).toBe(200);
    expect(await shared.json()).toEqual({ authorization: "Bearer shared-upstream", delegatedTokenForwarded: false });

    const connectionId = randomUUID();
    await database.db.insert(connections).values({
      id: connectionId,
      userSub: "alice",
      provider: "oauth",
      providerAccountSub: "alice-upstream",
      providerAccountLabel: "Alice",
      accessToken: "alice-upstream",
      grantedScopes: "read",
    });
    await database.db.insert(connectionGrants).values({
      id: randomUUID(),
      appId: "tickets",
      provider: "oauth",
      connectionId,
      ownerSub: "alice",
      scopes: "read",
      status: "approved",
    });
    expect((await request("/proxy/oauth/status", bearer)).status).toBe(401);
    expect((await request("/proxy/oauth/status", bearer, { "x-vibevarium-user-authorization": bob })).status).toBe(403);
    const oauth = await request("/proxy/oauth/status", bearer, { "x-vibevarium-user-authorization": alice });
    expect(oauth.status).toBe(200);
    expect(await oauth.json()).toEqual({ authorization: "Bearer alice-upstream", delegatedTokenForwarded: false });

    const vend = (user?: string) => fetch(`${base}/vend`, {
      method: "POST",
      headers: {
        authorization: bearer,
        "content-type": "application/json",
        ...(user === undefined ? {} : { "x-vibevarium-user-authorization": user }),
      },
      body: JSON.stringify({ provider: "oauth" }),
    });
    expect((await vend()).status).toBe(401);
    expect((await vend(bob)).status).toBe(403);
    const vended = await vend(alice);
    expect(vended.status).toBe(200);
    expect(await vended.json()).toMatchObject({ access_token: "alice-upstream" });

    await registryEffect((registry) => registry.remove("tickets"));
    expect((await request("/proxy/shared/status", bearer)).status).toBe(401);
  } finally {
    vi.unstubAllEnvs();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
}, 30_000);
