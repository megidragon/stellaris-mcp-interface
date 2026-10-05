import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import AdmZip from "adm-zip";
import { findLatestSave, parseSaveFile, SaveParseError } from "../src/parser/save-parser.js";

// Synthetic examples of shapes observed in local 3.0.4 and 3.4 saves.
// No real game save or player data is copied into the repository.
const LEGACY_STATE = `
version="Dick v3.0.4" date=2200.01.01
player={ {name="test" country=0} }
country={
  0={
    name="Test Empire" type=default fleet_size=3
    owned_planets={5} owned_fleets={0 2} owned_leaders={0}
    modules={ standard_economy_module={ resources={
      energy=0 minerals=17 alloys=8 sr_dark_matter=5 sr_tibanna_gas=578
    } } }
    budget={ current_month={ balance={
      country_base={energy=20 physics_research=10}
      planet_technicians={energy=9.5}
      ships={energy=-3 alloys=-1}
      mod_jobs={sr_tibanna_gas=2}
    } } }
    tech_status={
      technology="tech_mod_weapon"
      physics_queue={ {technology="tech_mod_shield" progress=12.5} }
    }
    active_policies={ {policy="mod_policy" selected="mod_selected"} }
    relations_manager={relation={country=7 opinion=-10 is_rival="no" defensive_pact="no"}}
  }
  7={name="Mod Nation" type="mod_country_type" owned_planets={} sapient=0
    military_power=0 tech_power=5 economy_power=9 federation=0
    ethos={ethic="ethic_mod_value"}}
}
planets={planet={5={
  name={key="NAME_ModWorld"} planet_class="pc_mod_world" planet_size=20
  pop={0 1} buildings={0 9} district="district_mod_city" district="district_mod_city"
  stability=60 free_amenities=14 amenities=42 total_housing=53 free_housing=26 crime=0
  jobs_cache={ {max_employed=4 num_employed=2} {max_employed=1 num_employed=1} }
  timed_modifier={modifier="mod_planet_bonus" days=12}
}}}
buildings={0={type="building_capital"} 9={type="building_mod_factory"}}
fleet={
  0={name="Station" ships={0} military_power=20 station=yes}
  2={name="Defenders" ships={1 2} military_power=80 military=yes civilian="no" mia="no"
    movement_manager={coordinate={origin=0}}}
}
leaders={0={name={first_name="Ada" second_name="Test"} class="scientist" age=44 level=2
  roles={scientist={trait="leader_trait_mod_science"} ruler={trait="latent_ruler_trait"}}}}
war={0={name="Test War" attackers={ {country=0} } defenders={ {country=7} }
  war_goal={type="wg_mod_goal"} start_date=2200.01.01}}
`;

const META = `version="Dick v3.0.4" name="Fixture" date="2200.01.01" required_dlcs={"Test DLC"}`;

async function temporaryDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stellaris-save-parser-"));
  context.after(async () => {
    // Only delete the exact directory created by this test.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("stellaris-save-parser-"));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function writeSave(directory: string, gamestate: string, meta?: string): string {
  const path = join(directory, "fixture.sav");
  const zip = new AdmZip();
  zip.addFile("gamestate", Buffer.from(gamestate));
  if (meta !== undefined) zip.addFile("meta", Buffer.from(meta));
  zip.writeZip(path);
  return path;
}

test("latest save discovery traverses campaigns and compares modification times", async context => {
  const root = await temporaryDirectory(context);
  await mkdir(join(root, "campaign-a"));
  await mkdir(join(root, "campaign-b", "nested"), { recursive: true });
  const oldSave = join(root, "campaign-a", "autosave_9999.sav");
  const newSave = join(root, "campaign-b", "nested", "autosave_2200.SAV");
  await writeFile(oldSave, "old");
  await writeFile(newSave, "new");
  await writeFile(join(root, "campaign-a", "ignore.sav.tmp"), "temporary");
  await mkdir(join(root, "not-a-file.sav"));
  await utimes(oldSave, 100, 100);
  await utimes(newSave, 200, 200);
  assert.equal(await findLatestSave(root), newSave);
  assert.equal(await findLatestSave(root, "campaign-a"), oldSave);
  assert.equal(await findLatestSave(root, "missing"), null);
  await assert.rejects(findLatestSave(root, "../outside"), /inside the configured save directory/);
});

test("directory access errors are distinguishable from an empty save folder", async context => {
  const root = await temporaryDirectory(context);
  assert.equal(await findLatestSave(root), null);
  const file = join(root, "a-file");
  await writeFile(file, "text");
  await assert.rejects(findLatestSave(file), /Cannot inspect save directory/);
});

test("parses observed legacy reference tables, net budgets and unknown mod identifiers", async context => {
  const root = await temporaryDirectory(context);
  const path = writeSave(root, LEGACY_STATE, META);
  const state = await parseSaveFile(path);
  assert.equal(state.meta.version, "Dick v3.0.4");
  assert.equal(state.meta.date, "2200.01.01");
  assert.deepEqual(state.meta.requiredDlcs, ["Test DLC"]);
  assert.equal(state.player.countryId, 0);
  assert.equal(state.player.resources.energy, 0);
  assert.equal(state.player.resources.dark_matter, 5);
  assert.equal(state.player.resources.sr_dark_matter, 5);
  assert.equal(state.player.resources.sr_tibanna_gas, 578);
  assert.equal(state.player.resourceIncome.energy, 26.5);
  assert.equal(state.player.resourceIncome.alloys, -1);
  assert.equal(state.player.resourceIncome.sr_tibanna_gas, 2);
  assert.deepEqual(state.player.planets[0].buildings, ["building_capital", "building_mod_factory"]);
  assert.equal(state.player.planets[0].districts.district_mod_city, 2);
  assert.equal(state.player.planets[0].planetClass, "pc_mod_world");
  assert.equal(state.player.planets[0].name, "NAME_ModWorld");
  assert.equal(state.player.planets[0].pops, 2);
  assert.equal(state.player.planets[0].housing, 53);
  assert.equal(state.player.planets[0].amenities, 14);
  assert.equal(state.player.planets[0].freeJobs, 2);
  assert.deepEqual(state.player.planets[0].modifiers, ["mod_planet_bonus"]);
  assert.deepEqual(state.player.fleets.map(fleet => fleet.id), [0, 2]);
  assert.equal(state.player.fleets[0].isMilitary, false);
  assert.equal(state.player.fleets[1].isCivilian, false);
  assert.equal(state.player.fleets[1].mia, false);
  assert.equal(state.player.fleets[1].location, "0");
  assert.equal(state.player.leaders[0].name, "Ada Test");
  assert.deepEqual(state.player.leaders[0].traits, ["leader_trait_mod_science"]);
  assert.equal(state.player.technologies.physics.current, "tech_mod_shield");
  assert.equal(state.player.technologies.physics.progress, 12.5);
  assert.equal(state.player.technologies.physics.output, 10);
  assert.deepEqual(state.player.technologies.completed, ["tech_mod_weapon"]);
  assert.deepEqual(state.player.policies, [{ name: "mod_policy", selected: "mod_selected" }]);
  assert.equal(state.countries[0].type, "mod_country_type");
  assert.deepEqual(state.countries[0].ethics, ["ethic_mod_value"]);
  assert.equal(state.countries[0].isRival, false);
  assert.equal(state.countries[0].hasFederation, true);
  assert.deepEqual(state.wars[0].attackers, ["0"]);
  assert.deepEqual(state.wars[0].defenders, ["7"]);
  assert.equal(state.wars[0].warGoal, "wg_mod_goal");
  assert.ok(state.diagnostics?.warnings.some(warning => warning.includes("Legacy save")));
  assert.equal(state.diagnostics?.savePath, path);
  assert.ok(state.diagnostics?.missingFields.includes("player.navyCap"));
  assert.ok(state.diagnostics?.missingFields.includes("player.resources.food"));
  assert.ok(!state.diagnostics?.missingFields.includes("player.resources.energy"));
});

test("supports the observed newer fleet ownership object shape", async context => {
  const root = await temporaryDirectory(context);
  const stateText = LEGACY_STATE.replace("owned_fleets={0 2}", "fleets_manager={owned_fleets={ {fleet=0} {fleet=2} }}");
  const state = await parseSaveFile(writeSave(root, stateText, META));
  assert.deepEqual(state.player.fleets.map(fleet => fleet.id), [0, 2]);
});

test("computes net flow from nested income minus expenses when no balance exists", async context => {
  const root = await temporaryDirectory(context);
  const text = `player={country=0} country={0={name="Budget Test" budget={current_month={
    income={country_base={energy=20} planet_jobs={energy=15}}
    expenses={ships={energy=9} planet_jobs={energy=6}}
  }}}}`;
  const state = await parseSaveFile(writeSave(root, text));
  assert.equal(state.player.resourceIncome.energy, 20);
  assert.ok(state.diagnostics?.warnings.some(warning => warning.includes("no meta entry")));
});

test("does not assume the first country is the player or conceal ambiguous players", async context => {
  const root = await temporaryDirectory(context);
  for (const [text, code] of [
    ['country={0={name="Wrong Empire"}}', "PLAYER_MISSING"],
    ['player={country=9} country={0={name="Wrong Empire"}}', "PLAYER_COUNTRY_MISSING"],
    ['player={{country=0}{country=1}} country={0={name="A"}1={name="B"}}', "PLAYER_AMBIGUOUS"],
  ]) {
    await assert.rejects(parseSaveFile(writeSave(root, text)), error => error instanceof SaveParseError && error.code === code);
  }
});

test("archive and plaintext failures identify the failed stage", async context => {
  const root = await temporaryDirectory(context);
  const missing = join(root, "missing.sav");
  await assert.rejects(parseSaveFile(missing), error => error instanceof SaveParseError && error.code === "SAVE_READ_FAILED" && error.cause !== undefined);
  const archive = new AdmZip();
  archive.addFile("meta", Buffer.from(META));
  const noState = join(root, "no-state.sav");
  archive.writeZip(noState);
  await assert.rejects(parseSaveFile(noState), error => error instanceof SaveParseError && error.code === "GAMESTATE_MISSING");
  await assert.rejects(parseSaveFile(writeSave(root, 'player={ country="unterminated')), error => error instanceof SaveParseError && error.code === "GAMESTATE_PARSE_FAILED" && error.cause !== undefined);
});

test("4.x fixture parsing explicitly reports that a live 4.x save remains unvalidated", async context => {
  const root = await temporaryDirectory(context);
  const state = await parseSaveFile(writeSave(root, 'version="Cygnus v4.5.1" player={country=0} country={0={name="Synthetic Fixture"}}'));
  assert.ok(state.diagnostics?.warnings.some(warning => warning.includes("current 4.x schemas have not been validated")));
  assert.ok(state.diagnostics?.missingFields.includes("player.resourceIncome.energy"));
  assert.ok(state.diagnostics?.missingFields.includes("player.technologies.physics.output"));
});
