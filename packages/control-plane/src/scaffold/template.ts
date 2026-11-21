import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const skipped = new Set(["node_modules", ".alchemy", ".git", "dist", ".real-test"]);

/** The deployable source, not a workspace wrapper, is committed to each app repo. */
export const materializeCloudflareTemplate = async (
  templateRoot: string,
  name: string,
): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (skipped.has(entry.name) || entry.name.endsWith(".tsbuildinfo")) continue;
      const source = join(directory, entry.name);
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
    `STACK_NAME=terrarium-${name}`,
    "",
  ].join("\n");
  files["README.md"] = `# ${name}\n\n${files["README.md"]}`;
  return files;
};
