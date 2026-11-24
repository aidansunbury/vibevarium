import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

// node_modules/.alchemy/.git/.tsbuildinfo are never shipped. `dist` dirs are
// skipped EXCEPT the built SPA (web/dist): the worker's assets.directory
// points at ./web/dist, so a generated app must carry its built frontend. The
// deploy rebuilds the worker's own dist, so that stays skipped.
const ALWAYS_SKIPPED = new Set(["node_modules", ".alchemy", ".git", ".real-test"]);
const SPA_DIST_SUFFIX = join("web", "dist");

/** The deployable source, not a workspace wrapper, is committed to each app repo. */
export const materializeCloudflareTemplate = async (
  templateRoot: string,
  name: string,
): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ALWAYS_SKIPPED.has(entry.name) || entry.name.endsWith(".tsbuildinfo")) continue;
      const source = join(directory, entry.name);
      // Skip `dist` dirs unless this one IS the built SPA.
      if (entry.name === "dist" && !source.endsWith(SPA_DIST_SUFFIX)) continue;
      if (entry.isDirectory()) {
        await visit(source);
        continue;
      }
      const filePath = relative(templateRoot, source).replaceAll("\\", "/");
      files[filePath] = await readFile(source, "utf8");
    }
  };
  await visit(templateRoot);

  const packageJson = JSON.parse(files["package.json"]!) as {
    name: string;
    private: boolean;
    devDependencies?: Record<string, string>;
  };
  packageJson.name = name;
  packageJson.private = true;
  files["package.json"] = `${JSON.stringify(packageJson, null, 2)}\n`;
  files["tsconfig.json"] = `${JSON.stringify({
    compilerOptions: {
      target: "ES2023",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      exactOptionalPropertyTypes: true,
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      types: ["node"],
      lib: ["ES2023", "DOM", "DOM.Iterable"],
    },
    include: ["src", "alchemy.run.ts"],
  }, null, 2)}\n`;
  files[".env.example"] = [
    "CLOUDFLARE_ACCOUNT_ID=7bbaa8f97d6ababf1a5e29eb79491ce3",
    `WORKER_NAME=${name}`,
    `D1_DATABASE_NAME=${name}-data`,
    `STACK_NAME=vibevarium-${name}`,
    "",
  ].join("\n");
  files["README.md"] = `# ${name}\n\n${files["README.md"]}`;
  return files;
};
