/**
 * The CLI's name: its root command, its binary name, its release artifacts.
 * Default `vibevarium`; forks rebrand by setting `TERRARIUM_CLI_NAME` at build
 * time (and in the release workflow) — one knob, whole CLI renames.
 */
export const cliName = process.env.TERRARIUM_CLI_NAME ?? "vibevarium";
