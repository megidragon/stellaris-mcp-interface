import assert from "node:assert/strict";
import test from "node:test";
import { parseLogContent } from "../src/parser/log-parser.js";

const summary = "[19:00:00][effect_impl.cpp:1]: AI_SUMMARY|2200.02.01|Keepers|3|900|12|40|1450";
const end = "AI_STATE_END|2200.02.01";

test("parses separate navy usage/capacity and fleet power from the mod protocol", () => {
  const state = parseLogContent([summary,
    "AI_RESOURCES|2200.02.01|energy|125.5|-2.25",
    "AI_TECH_OUTPUT|2200.02.01|12|13|14",
    "AI_DIPLO|Neighbors|-50|1|0|1",
    "AI_FLEET|Guardians|4|1450|yes", end].join("\n"));
  assert.deepEqual(state?.summary, { numPlanets: 3, numPops: 900, navySize: 12, navyCap: 40, fleetPower: 1450 });
  assert.equal(state?.resourceIncome?.energy, -2.25);
  assert.deepEqual(state?.researchOutput, { physics: 12, society: 13, engineering: 14 });
  assert.equal(state?.diplomacy?.[0].isAtWar, true);
  assert.equal(state?.fleets?.[0].mia, true);
});

test("incomplete or mismatched reports never overwrite the last complete report", () => {
  assert.equal(parseLogContent(`${summary}\n${end}\nAI_SUMMARY|2200.03.01|Keepers|3|900|12|40|1600`)?.date, "2200.02.01");
  assert.equal(parseLogContent(`${summary}\nAI_STATE_END|2200.03.01`), null);
  assert.equal(parseLogContent(`AI_RESOURCES|2200.02.01|energy|200|5\n${end}`), null);
});

test("initialization resets previous session data and malformed numbers stay unknown", () => {
  assert.equal(parseLogContent(`${summary}\n${end}\nAI_INIT|2200.01.01|New Empire|initialized`), null);
  const state = parseLogContent(`${summary}\nAI_RESOURCES|2200.02.01|energy|[This.unresolved]|NaN\nAI_FLEET|Fleet|[This.ships]|10|unknown\n${end}`);
  assert.equal(state?.resources?.energy, undefined);
  assert.equal(state?.fleets?.[0].ships, undefined);
  assert.equal(state?.fleets?.[0].mia, undefined);
  assert.equal(parseLogContent(`AI_SUMMARY|[GetDate]|Keepers|3|900|12|40|1450\n${end}`), null);
});
