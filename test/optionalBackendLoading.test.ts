import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("the extension entry loads when optional durable and chord packages are unavailable", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-task-optional-load-"));
  const loaderPath = join(tempDir, "block-optional-packages.mjs");
  const extensionPath = pathToFileURL(join(repoRoot, "src/index.ts")).href;
  writeFileSync(
    loaderPath,
    `export async function resolve(specifier, context, nextResolve) {
      if (specifier === "@earendil-works/pi-durable" ||
          specifier.startsWith("@earendil-works/pi-durable/") ||
          specifier === "@earendil-works/chord" ||
          specifier.startsWith("@earendil-works/chord/")) {
        throw Object.assign(new Error("optional package blocked by test loader: " + specifier), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      }
      return nextResolve(specifier, context);
    }\n`,
    "utf8",
  );

  try {
    const child = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--loader",
        pathToFileURL(loaderPath).href,
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(extensionPath)});`,
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(
      child.status,
      0,
      `extension import failed with optional packages blocked:\n${child.stderr}\n${child.stdout}`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
