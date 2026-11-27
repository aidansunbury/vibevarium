import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { materializeCloudflareTemplate, r2BucketName } from "./template.ts";

const withTemplate = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "vibevarium-template-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "template", private: true }));
    await writeFile(join(root, "README.md"), "Template\n");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("Cloudflare template features", () => {
  it("writes the selected per-app R2 bucket into the generated deploy config", async () => {
    await withTemplate(async (root) => {
      const withoutR2 = await materializeCloudflareTemplate(root, "demo");
      expect(withoutR2[".env.example"]).not.toContain("R2_BUCKET_NAME");

      const withR2 = await materializeCloudflareTemplate(root, "demo", ["r2"]);
      expect(withR2[".env.example"]).toContain(`R2_BUCKET_NAME=${r2BucketName("demo")}\n`);
    });
  });

  it("keeps generated bucket names within R2's 63-character limit", () => {
    const prefix = "a".repeat(62);
    const bucket = r2BucketName(`${prefix}a`);
    expect(bucket).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
    expect(r2BucketName(`${prefix}a`)).toBe(bucket);
    expect(r2BucketName(`${prefix}b`)).not.toBe(bucket);
  });
});
