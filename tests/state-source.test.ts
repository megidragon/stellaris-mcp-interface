import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import AdmZip from "adm-zip";
import type { StellarisMcpConfig } from "../src/config.js";
import { formatGameState, getGameState, getGameStateFromSave } from "../src/tools/get-game-state.js";

async function configuration(t: TestContext): Promise<StellarisMcpConfig> {
  const directory = await mkdtemp(join(tmpdir(), "stellaris-state-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("stellaris-state-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  const config = {
    stellarisDocumentsPath: directory,
    stellarisInstallPath: directory,
    gameLogPath: join(directory, "game.log"),
    saveGamesPath: join(directory, "saves"),
    modDocumentsPath: join(directory, "mod"),
    saveProfile: "",
    fullDumpInterval: 1,
  };
  await mkdir(config.saveGamesPath);
  return config;
}

async function writeSave(path: string): Promise<void> {
  const zip = new AdmZip();
  zip.addFile("meta", Buffer.from('version="Cygnus v4.5.1" date=2200.01.01'));
  zip.addFile("gamestate", Buffer.from('player={country=0} country={0={name="Test Empire" type=default}}'));
  await writeFile(path, zip.toBuffer());
}

test("a recent save beats stale log data, while a newer complete log snapshot remains live", async (t) => {
  const config = await configuration(t);
  const path = join(config.saveGamesPath, "latest.sav");
  await writeSave(path);
  await utimes(path, new Date(2000), new Date(2000));
  const latestState = { date: "2100.01.01", empireName: "Other Empire" };
  const stale = await getGameState(config, { latestState, lastSnapshotAt: 1000 });
  assert.equal(stale.source, `save_file:${path}`);
  assert.ok(stale.state && "player" in stale.state);
  assert.equal(stale.state.player.name, "Test Empire");
  const live = await getGameState(config, { latestState, lastSnapshotAt: 3000 });
  assert.equal(live.source, "game_log");
  assert.equal(live.state, latestState);
});

test("an explicit save profile is never answered with the global log from another game", async (t) => {
  const config = await configuration(t);
  config.saveProfile = "chosen";
  await mkdir(join(config.saveGamesPath, config.saveProfile));
  const path = join(config.saveGamesPath, config.saveProfile, "latest.sav");
  await writeSave(path);
  const result = await getGameState(config, {
    latestState: { date: "2500.01.01", empireName: "Other Empire" },
    lastSnapshotAt: Date.now() + 10000,
  });
  assert.equal(result.source, `save_file:${path}`);
  assert.ok(result.state && "player" in result.state);
  assert.equal(result.state.player.name, "Test Empire");
});

test("a corrupt selected save returns its path and actual parse error", async (t) => {
  const config = await configuration(t);
  const path = join(config.saveGamesPath, "broken.sav");
  await writeFile(path, "not a ZIP save");
  const result = await getGameStateFromSave(config);
  assert.equal(result.source, "error");
  assert.equal(result.state, null);
  assert.equal(result.savePath, path);
  assert.ok(result.error);
});

test("formatting keeps custom resources, diagnostics, and partial live fields distinct", async (t) => {
  const config = await configuration(t);
  await writeSave(join(config.saveGamesPath, "latest.sav"));
  const result = await getGameStateFromSave(config);
  assert.ok(result.state);
  result.state.player.resources.dark_energy = 7;
  result.state.diagnostics = { source: "save", warnings: ["Missing telemetry"], missingFields: ["planet.freeJobs"] };
  const formattedSave = formatGameState(result.state, result.source);
  assert.match(formattedSave, /dark_energy \| 7/);
  assert.match(formattedSave, /Missing telemetry/);
  assert.match(formattedSave, /planet.freeJobs/);
  assert.match(formattedSave, /unverified/);

  const formattedLog = formatGameState({
    date: "2200.01.01", empireName: "Test Empire",
    summary: { numPlanets: 1, numPops: 100, navySize: 20, navyCap: 30, fleetPower: 400 },
    resources: { dark_energy: 7 }, resourceIncome: { dark_energy: 2, custom_income: 3 },
    fleets: [{ name: "Lost", mia: true }],
    researchOutput: { physics: 1, society: 2, engineering: 3 },
    diplomacy: [{ name: "Neighbor", opinion: -10, isAtWar: true }],
  }, "game_log");
  assert.match(formattedLog, /Navy: 20\/30/);
  assert.match(formattedLog, /custom_income \| unknown \| \+3/);
  assert.match(formattedLog, /Monthly Research Output/);
  assert.match(formattedLog, /AT_WAR/);
  assert.match(formattedLog, /MIA/);
  assert.doesNotMatch(formattedLog, /undefined/);
});
