import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { LogWatcher } from "../src/watcher/log-watcher.js";
import { SaveWatcher } from "../src/watcher/save-watcher.js";

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stellaris-watcher-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("stellaris-watcher-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function snapshot(empire = "Old", date = "2200.01.01"): string {
  return `AI_SUMMARY|${date}|${empire}|1|100|20|30|400\nAI_STATE_END|${date}\n`;
}

test("log watcher discards old state after truncation, removal, and same-size rewriting", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "game.log");
  const watcher = new LogWatcher(path);
  await writeFile(path, snapshot());
  await watcher.refresh();
  assert.equal(watcher.latestState?.empireName, "Old");
  await writeFile(path, snapshot("New"));
  await utimes(path, new Date(), new Date(Date.now() + 1000));
  await watcher.refresh();
  assert.equal(watcher.latestState?.empireName, "New");
  await writeFile(path, "A new game is starting\n");
  await watcher.refresh();
  assert.equal(watcher.latestState, null);
  assert.equal(watcher.lastSnapshotAt, null);
  await writeFile(path, snapshot());
  await watcher.refresh();
  await unlink(path);
  await watcher.refresh();
  assert.equal(watcher.latestState, null);
});

test("log watcher detects a restart that rewrites and grows past the previous size", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "game.log");
  const watcher = new LogWatcher(path);
  await writeFile(path, snapshot());
  await watcher.refresh();
  await writeFile(path, "New session\n" + "ordinary log output\n".repeat(100));
  await watcher.refresh();
  assert.equal(watcher.latestState, null);
  await appendFile(path, snapshot("New"));
  await watcher.refresh();
  assert.equal(watcher.latestState?.empireName, "New");
});

test("split markers and split UTF-8 names are read without corrupting a completed dump", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "game.log");
  const watcher = new LogWatcher(path);
  const bytes = Buffer.from(snapshot("Émpire"));
  const split = bytes.indexOf(Buffer.from("É")) + 1;
  await writeFile(path, bytes.subarray(0, split));
  await watcher.refresh();
  assert.equal(watcher.latestState, null);
  const markerSplit = bytes.indexOf("AI_STATE_END") + 5;
  await appendFile(path, bytes.subarray(split, markerSplit));
  await watcher.refresh();
  assert.equal(watcher.latestState, null);
  await appendFile(path, bytes.subarray(markerSplit));
  await watcher.refresh();
  assert.equal(watcher.latestState?.empireName, "Émpire");
});

test("unrelated log messages do not refresh the age of an old monthly snapshot", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "game.log");
  const watcher = new LogWatcher(path);
  await writeFile(path, snapshot());
  await watcher.refresh();
  const observedAt = watcher.lastSnapshotAt;
  await appendFile(path, "ordinary log output\n");
  await utimes(path, new Date(), new Date(Date.now() + 5000));
  await watcher.refresh();
  assert.equal(watcher.lastSnapshotAt, observedAt);
  await appendFile(path, "AI_INIT|2200.01.01|New|initialized\n");
  await watcher.refresh();
  assert.equal(watcher.latestState, null);
});

test("a partial or malformed next dump preserves the last completed monthly state", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "game.log");
  const watcher = new LogWatcher(path);
  await writeFile(path, snapshot());
  await watcher.refresh();
  const observedAt = watcher.lastSnapshotAt;
  await appendFile(path, "AI_SUMMARY|2200.02.01|New|1|100|20|30|400\n");
  await watcher.refresh();
  assert.equal(watcher.latestState?.empireName, "Old");
  assert.equal(watcher.lastSnapshotAt, observedAt);
  await appendFile(path, "AI_STATE_END|wrong-date\n");
  await watcher.refresh();
  assert.equal(watcher.latestState?.empireName, "Old");
  await appendFile(path, snapshot("New", "2200.02.01"));
  await watcher.refresh();
  assert.equal(watcher.latestState?.date, "2200.02.01");
});

test("save watcher follows profile directories with Chokidar 5 and chooses newest mtime", async (t) => {
  const directory = await temporaryDirectory(t);
  const profile = join(directory, "profile");
  await mkdir(profile);
  const oldSave = join(profile, "z-old.sav");
  const newSave = join(profile, "a-new.sav");
  await writeFile(oldSave, "old");
  await writeFile(newSave, "new");
  await writeFile(join(profile, "ignored.txt"), "not a save");
  await utimes(oldSave, new Date(1000), new Date(1000));
  await utimes(newSave, new Date(2000), new Date(2000));
  const watcher = new SaveWatcher(directory);
  try {
    await watcher.start();
    assert.equal(watcher.latestSave, newSave);
    await unlink(newSave);
    const deadline = Date.now() + 5000;
    while (watcher.latestSave !== oldSave && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(watcher.latestSave, oldSave);
  } finally {
    await watcher.stop();
  }
});
