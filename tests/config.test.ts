import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveDocumentsPath } from "../src/config.js";

test("explicit user data path overrides automatic discovery", () => {
  assert.equal(resolveDocumentsPath({ STELLARIS_DOCUMENTS_PATH: "custom-data" }, "unused"), "custom-data");
});

test("discovers redirected Documents and prefers the active log", async () => {
  const home = await mkdtemp(join(tmpdir(), "stellaris-config-"));
  try {
    const standard = join(home, "Documents", "Paradox Interactive", "Stellaris");
    const cloud = join(home, "OneDrive", "Documents", "Paradox Interactive", "Stellaris");
    for (const path of [standard, cloud]) {
      await mkdir(join(path, "logs"), { recursive: true });
      await writeFile(join(path, "logs", "game.log"), "");
    }
    await utimes(join(standard, "logs", "game.log"), 1, 1);
    await utimes(join(cloud, "logs", "game.log"), 2, 2);
    assert.equal(resolveDocumentsPath({}, home), cloud);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
