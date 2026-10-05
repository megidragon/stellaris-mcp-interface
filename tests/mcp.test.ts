import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

test("built MCP speaks stdio, reads snapshots and preserves separate command batches", { timeout: 20000 }, async () => {
  const documents = await mkdtemp(join(tmpdir(), "stellaris-mcp-"));
  const client = new Client({ name: "stellaris-test", version: "1.0.0" });
  try {
    await mkdir(join(documents, "logs"));
    await mkdir(join(documents, "save games", "test"), { recursive: true });
    const archive = new AdmZip();
    archive.addFile("meta", Buffer.from('version="Cygnus v4.5.1" name="Test Keepers" date="2200.01.01"'));
    archive.addFile("gamestate", Buffer.from(`
      player={ { country=0 } }
      country={ 0={ name="Test Keepers" owned_planets={} owned_fleets={}
        modules={ standard_economy_module={ resources={ energy=100 } } }
        budget={ current_month={ balance={ country_base={ energy=5 } } } }
        tech_status={ technology={ tech_lasers_1 } physics_queue={ tech_lasers_2 } }
      } }
    `));
    archive.writeZip(join(documents, "save games", "test", "test.sav"));
    await writeFile(join(documents, "logs", "game.log"), [
      "AI_SUMMARY|2200.02.01|Test Keepers|1|1000|12|40|1200",
      "AI_RESOURCES|2200.02.01|energy|125|5", "AI_STATE_END|2200.02.01", "",
    ].join("\n"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/index.js")],
      env: { ...getDefaultEnvironment(), STELLARIS_DOCUMENTS_PATH: documents },
      stderr: "pipe",
    });
    const errors: string[] = [];
    transport.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 11);
    const logState = await client.callTool({ name: "get_game_state", arguments: { source: "log" } });
    assert.match(JSON.stringify(logState), /2200\.02\.01/);
    assert.match(JSON.stringify(logState), /game_log/);
    assert.match(JSON.stringify(logState), /1200/);
    const saveState = await client.callTool({ name: "get_game_state", arguments: { source: "save", save_profile: "test" } });
    assert.match(JSON.stringify(saveState), /Cygnus v4\.5\.1/);
    assert.match(JSON.stringify(saveState), /save_file/);
    const research = await client.callTool({ name: "get_technologies", arguments: { save_profile: "test" } });
    assert.match(JSON.stringify(research), /tech_lasers_1/);
    for (const name of ["get_resources", "get_planets", "get_fleets", "get_diplomacy", "list_save_profiles", "analyze_situation"]) {
      const response = await client.callTool({ name, arguments: {} });
      assert.notEqual(response.isError, true, `${name}: ${JSON.stringify(response)}`);
    }
    for (const command of ["help", "version"]) {
      const response = await client.callTool({ name: "execute_command", arguments: { command } });
      assert.notEqual(response.isError, true);
      assert.match(JSON.stringify(response), /run ai_commands_[a-z0-9-]+\.txt/);
    }
    for (const request of [
      { name: "execute_effect", arguments: { effect: "log = \"test\"" } },
      { name: "queue_commands", arguments: { commands: ["help", "version"] } },
    ]) {
      const response = await client.callTool(request);
      assert.notEqual(response.isError, true);
    }
    const batches = (await readdir(documents)).filter((name) => /^ai_commands_.*\.txt$/.test(name));
    assert.equal(batches.length, 4);
    const contents = await Promise.all(batches.map((name) => readFile(join(documents, name), "utf8")));
    assert.deepEqual(contents.sort(), ['effect log = "test"\n', "help\n", "help\nversion\n", "version\n"]);
    assert.deepEqual(errors, []);
  } finally {
    await client.close();
    assert.equal(dirname(documents), resolve(tmpdir()));
    await rm(documents, { recursive: true, force: true });
  }
});
