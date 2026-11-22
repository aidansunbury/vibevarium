import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * SecretsProvider seam (see docs/providers.md): integrations never store token
 * values in the database — only a reference (the env var name). v1 resolves
 * references from process env; AWS Secrets Manager / Infisical / 1Password are
 * drop-in replacements for this one service.
 */
export class SecretsProvider extends Context.Service<SecretsProvider, {
  readonly resolve: (reference: string) => Effect.Effect<Option.Option<string>>;
}>()("@terrarium/control-plane/integrations/SecretsProvider") {
  static readonly envLayer = Layer.succeed(SecretsProvider, SecretsProvider.of({
    resolve: (reference) => Effect.sync(() => Option.fromUndefinedOr(process.env[reference])),
  }));
}
