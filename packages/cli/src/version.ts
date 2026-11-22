/**
 * Single source of truth for the CLI version. `scripts/build.ts` asserts this
 * matches package.json, and release binaries are stamped from the git tag, so
 * keep all three in sync when cutting a release.
 */
export const cliVersion = "0.0.1";
