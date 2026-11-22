import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

import type * as Output from "alchemy/Output";

export interface DnsOptions {
  /** Cloudflare zone ID for the domain. */
  readonly zoneId: string;
  /** Root domain, e.g. `vibevarium.com`. */
  readonly domain: string;
  /** IPv4 address the A-records point at (the EC2 Elastic IP). */
  readonly ip: Output.Output<string>;
}

/**
 * DNS-only (grey cloud) A-records for the auth server and control plane.
 * Grey cloud so Caddy on the box terminates TLS itself (Let's Encrypt via
 * HTTP-01 through port 80).
 */
export const Dns = (options: DnsOptions) =>
  Effect.gen(function* () {
    const auth = yield* Cloudflare.DNS.Record("AuthA", {
      zoneId: options.zoneId,
      name: `auth.${options.domain}`,
      type: "A",
      content: options.ip,
      proxied: false,
      ttl: 300,
      comment: "Terrarium Logto OIDC server",
    });

    const platform = yield* Cloudflare.DNS.Record("PlatformA", {
      zoneId: options.zoneId,
      name: `platform.${options.domain}`,
      type: "A",
      content: options.ip,
      proxied: false,
      ttl: 300,
      comment: "Terrarium control plane",
    });

    return {
      authRecordId: auth.recordId,
      platformRecordId: platform.recordId,
      authHostname: `auth.${options.domain}`,
      platformHostname: `platform.${options.domain}`,
    };
  });
