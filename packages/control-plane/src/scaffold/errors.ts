import * as Effect from "effect/Effect";

export class ScaffoldError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScaffoldError";
    this.status = status;
  }
}

export const asScaffoldError = (cause: unknown, status = 500) =>
  cause instanceof ScaffoldError
    ? cause
    : new ScaffoldError(status, cause instanceof Error ? cause.message : String(cause), { cause });

export const attempt = <A>(run: () => Promise<A>, status = 500) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => asScaffoldError(cause, status),
  });
