import { Auth } from "@vibevarium/auth";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import type { Registry } from "./registry/index.ts";
import { m2mApplicationName } from "./scaffold/casdoor.ts";

interface AppAuthOptions {
  readonly authEnabled: boolean;
  readonly appSecrets: Readonly<Record<string, string>>;
}

export const authenticatedApp = (options: AppAuthOptions, registry: Registry["Service"]) =>
  Effect.gen(function*() {
    const { headers } = yield* HttpServerRequest;
    if (!options.authEnabled) {
      const name = headers["x-vibevarium-app"];
      const secret = headers["x-vibevarium-app-secret"];
      return name && secret && Object.hasOwn(options.appSecrets, name) && options.appSecrets[name] === secret
        ? name
        : undefined;
    }

    const token = headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (token === undefined) return;
    const auth = yield* Auth;
    const verified = yield* Effect.result(auth.verify(token, `${auth.audience.replace(/\/$/, "")}/app`));
    if (verified._tag === "Failure") return;

    const { azp, sub, tokenType } = verified.success;
    if (!azp || tokenType !== "access-token" || sub !== `admin/${m2mApplicationName(azp)}`) return;
    return yield* registry.appForM2mClient(azp);
  });

export const delegatedUser = Effect.gen(function*() {
  const { headers } = yield* HttpServerRequest;
  const token = headers["x-vibevarium-user-authorization"]?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (token === undefined) return;
  const auth = yield* Auth;
  const verified = yield* Effect.result(auth.verify(token));
  if (verified._tag === "Success" &&
      (verified.success.tokenType === undefined || verified.success.tokenType === "access-token")) {
    return verified.success;
  }
});
