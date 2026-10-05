import { readFile } from "node:fs/promises";
import type { LogGameState } from "./types.js";

/** Return the latest complete monthly report; never combine separate dumps. */
export async function parseGameLog(logPath: string): Promise<LogGameState | null> {
  try {
    return parseLogContent(await readFile(logPath, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function parseLogContent(content: string): LogGameState | null {
  let latest: LogGameState | null = null;
  let pending: LogGameState | null = null;

  for (const line of content.split("\n")) {
    const record = extractAiLine(line);
    if (!record) continue;
    const { type, fields } = record;
    if (type === "AI_INIT") {
      latest = null;
      pending = null;
      continue;
    }
    if (type === "AI_SUMMARY") {
      pending = null;
      if (!/^\d+\.\d{2}\.\d{2}$/.test(fields[0] ?? "")) continue;
      const counts = fields.slice(2, 7).map(number);
      if (counts.length !== 5 || counts.some((value) => value === undefined)) continue;
      const [numPlanets, numPops, navySize, navyCap, fleetPower] = counts as number[];
      pending = {
        date: fields[0],
        empireName: fields[1],
        summary: { numPlanets, numPops, navySize, navyCap, fleetPower },
      };
      continue;
    }
    if (!pending) continue;
    if (type === "AI_STATE_END") {
      if (fields[0] === pending.date) latest = pending;
      pending = null;
      continue;
    }
    switch (type) {
      case "AI_RESOURCES": {
        if (fields[0] !== pending.date) break;
        const stockpile = number(fields[2]);
        const income = number(fields[3]);
        // Resource IDs are extensible so total conversions can report their IDs.
        if (fields[1] && stockpile !== undefined) (pending.resources ??= {})[fields[1]] = stockpile;
        if (fields[1] && income !== undefined) (pending.resourceIncome ??= {})[fields[1]] = income;
        break;
      }
      case "AI_PLANET":
        (pending.planets ??= []).push({
          name: fields[0], planetClass: fields[1],
          pops: number(fields[2]), size: number(fields[3]),
          stability: number(fields[4]), amenities: number(fields[5]),
          freeHousing: number(fields[6]), freeJobs: number(fields[7]), crime: number(fields[8]),
        });
        break;
      case "AI_FLEET":
        (pending.fleets ??= []).push({
          name: fields[0], ships: number(fields[1]), militaryPower: number(fields[2]), mia: boolean(fields[3]),
        });
        break;
      case "AI_DIPLO":
        (pending.diplomacy ??= []).push({
          name: fields[0], opinion: number(fields[1]), isRival: boolean(fields[2]),
          hasDefensivePact: boolean(fields[3]), isAtWar: boolean(fields[4]),
        });
        break;
      case "AI_TECH_OUTPUT": {
        if (fields[0] !== pending.date) break;
        const physics = number(fields[1]);
        const society = number(fields[2]);
        const engineering = number(fields[3]);
        if (physics !== undefined && society !== undefined && engineering !== undefined) {
          pending.researchOutput = { physics, society, engineering };
        }
        break;
      }
    }
  }
  return latest;
}

function extractAiLine(line: string): { type: string; fields: string[] } | null {
  const match = /(?:^|\s)(AI_[A-Z_]+)\|(.+)$/.exec(line.trim());
  if (!match) return null;
  return { type: match[1], fields: match[2].split("|").map((field) => field.trim()) };
}

function number(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolean(value: string | undefined): boolean | undefined {
  if (value === "yes") return true;
  if (value === "no") return false;
  const parsed = number(value);
  if (parsed === 1) return true;
  if (parsed === 0) return false;
  return undefined;
}
