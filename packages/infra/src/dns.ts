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
      comment: "Vibevarium Casdoor OIDC server",
    });

    // The control-plane API. The GUI SPA is served from Cloudflare at
    // platform.<domain> (proxied — not a grey-cloud A record here, so Cloudflare
    // can route it to the SPA); the API lives on the box at api.<domain>.
    const api = yield* Cloudflare.DNS.Record("ApiA", {
      zoneId: options.zoneId,
      name: `api.${options.domain}`,
      type: "A",
      content: options.ip,
      proxied: false,
      ttl: 300,
      comment: "Vibevarium control-plane API",
    });

    // Casdoor serves the API, OIDC/discovery endpoints, and the admin console
    // from a single port on one origin — no separate admin origin needed
    // (unlike Logto's split-core/admin setup).
    return {
      authRecordId: auth.recordId,
      apiRecordId: api.recordId,
      authHostname: `auth.${options.domain}`,
      apiHostname: `api.${options.domain}`,
    };
  });
