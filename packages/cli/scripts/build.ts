/**
 * Builds the publishable `platform` binaries with `bun build --compile`.
 *
 * Usage:
 *   node --experimental-strip-types scripts/build.ts [--version X.Y.Z]
 *
 * The version defaults to package.json's version and must match
 * src/version.ts, so a release binary never disagrees with `--version`.
 * Artifacts land in packages/cli/dist/ as platform-<target> (+ .sha256),
 * named for GitHub Releases and install.sh.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { cliName } from "../src/name.ts";
import { cliVersion } from "../src/version.ts";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const outDirectory = join(packageDirectory, "dist");

const versionFlagIndex = process.argv.indexOf("--version");
const stampedVersion =
  versionFlagIndex === -1 ? undefined : process.argv[versionFlagIndex + 1];

const parsedPackageJson: unknown = JSON.parse(
  await readFile(join(packageDirectory, "package.json"), "utf8"),
);
const packageVersion =
  typeof parsedPackageJson === "object" &&
  parsedPackageJson !== null &&
  "version" in parsedPackageJson &&
  typeof parsedPackageJson.version === "string"
    ? parsedPackageJson.version
    : undefined;
if (packageVersion === undefined) {
  console.error("package.json has no string version field");
  process.exit(1);
}

const version = stampedVersion ?? packageVersion;
if (version !== cliVersion || version !== packageVersion) {
  console.error(
    `Version mismatch: --version=${stampedVersion ?? "(unset)"}, package.json=${packageVersion}, src/version.ts=${cliVersion}`,
  );
  console.error("Bump all three together (release tags must match: cli-v$(src/version.ts)).");
  process.exit(1);
}

// Published decision: the dynamic, manifest-driven CLI is the only shipped
// binary; the composed variant stays a workspace dev tool (see SPIKE.md).
const targets = ["bun-linux-x64", "bun-darwin-arm64", "bun-darwin-x64"] as const;

const artifactName = (target: string) => `${cliName}-${target.replace(/^bun-/, "")}`;

const run = (args: ReadonlyArray<string>) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("bun", args, { cwd: packageDirectory, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`bun ${args.join(" ")} exited ${String(code)}`)),
    );
  });

for (const target of targets) {
  const outfile = join(outDirectory, artifactName(target));
  await run([
    "build",
    "--compile",
    `--target=${target}`,
    `--outfile=${outfile}`,
    "src/dynamic.ts",
  ]);
  const binary = await readFile(outfile);
  const digest = createHash("sha256").update(binary).digest("hex");
  await writeFile(`${outfile}.sha256`, `${digest}  ${artifactName(target)}\n`);
  console.log(`built ${artifactName(target)} (v${version}) sha256=${digest}`);
}
