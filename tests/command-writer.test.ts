import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { CommandWriter } from "../src/commands/command-writer.js";

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stellaris-command-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("stellaris-command-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function batchName(message: string): string {
  const match = /console: run (ai_commands_[\w-]+\.txt)/.exec(message);
  assert.ok(match, message);
  return match[1];
}

test("separate batches remain available and return their exact manual run names", async (t) => {
  const directory = await temporaryDirectory(t);
  const writer = new CommandWriter(directory);
  writer.queueCommand("energy 10");
  const first = batchName(await writer.flush());
  writer.queueEffect("add_resource = { minerals = 20 }");
  const second = batchName(await writer.flush());
  assert.notEqual(first, second);
  assert.equal(await readFile(join(directory, first), "utf8"), "energy 10\n");
  assert.equal(await readFile(join(directory, second), "utf8"), "effect add_resource = { minerals = 20 }\n");
  assert.deepEqual((await readdir(directory)).sort(), [first, second].sort());
  assert.deepEqual(writer.getPendingCommands(), []);
});

test("a failed batch write remains queued and can be retried", async (t) => {
  const directory = await temporaryDirectory(t);
  const destination = join(directory, "not-created-yet");
  const writer = new CommandWriter(destination);
  writer.queueCommand("influence 1");
  await assert.rejects(writer.flush(), /Cannot write Stellaris command batch/);
  assert.deepEqual(writer.getPendingCommands(), ["influence 1"]);
  await mkdir(destination);
  const filename = batchName(await writer.flush());
  assert.equal(await readFile(join(destination, filename), "utf8"), "influence 1\n");
  assert.deepEqual(writer.getPendingCommands(), []);
});

test("commands queued during a write are preserved for the next serialized flush", async (t) => {
  const directory = await temporaryDirectory(t);
  const writer = new CommandWriter(directory);
  writer.queueCommand("energy 1");
  const firstWrite = writer.flush();
  await Promise.resolve(); // The first flush has captured its batch and started I/O.
  writer.queueCommand("minerals 2");
  const secondWrite = writer.flush();
  const [first, second] = (await Promise.all([firstWrite, secondWrite])).map(batchName);
  assert.equal(await readFile(join(directory, first), "utf8"), "energy 1\n");
  assert.equal(await readFile(join(directory, second), "utf8"), "minerals 2\n");
  assert.deepEqual(writer.getPendingCommands(), []);
});
