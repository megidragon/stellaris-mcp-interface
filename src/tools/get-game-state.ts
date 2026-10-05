import type { GameState, LogGameState } from "../parser/types.js";
import { RESOURCE_KEYS } from "../parser/types.js";
import { parseSaveFile, findLatestSave } from "../parser/save-parser.js";
import type { LogWatcher } from "../watcher/log-watcher.js";
import type { StellarisMcpConfig } from "../config.js";
import { stat } from "node:fs/promises";

export interface StateResult<T = GameState | LogGameState> {
  source: string;
  state: T | null;
  error?: string;
  savePath?: string;
}

/**
 * Get the current game state from the best available source.
 * Prefer the newest snapshot. A selected save profile is read from that profile,
 * since the global game log does not identify which save profile produced it.
 */
export async function getGameState(
  config: StellarisMcpConfig,
  logWatcher: Pick<LogWatcher, "latestState" | "lastSnapshotAt">
): Promise<StateResult> {
  if (config.saveProfile) return getGameStateFromSave(config);

  const logState = logWatcher.latestState;
  const savePath = await findLatestSave(config.saveGamesPath);
  if (logState?.date && logWatcher.lastSnapshotAt !== null) {
    const savedAt = savePath ? await stat(savePath).then((info) => info.mtimeMs).catch(() => Infinity) : -Infinity;
    if (logWatcher.lastSnapshotAt >= savedAt) {
      return { source: "game_log", state: logState };
    }
  }
  return readSaveState(savePath);
}

export async function getGameStateFromSave(
  config: StellarisMcpConfig
): Promise<StateResult<GameState>> {
  const savePath = await findLatestSave(
    config.saveGamesPath,
    config.saveProfile
  );

  return readSaveState(savePath);
}

async function readSaveState(savePath: string | null): Promise<StateResult<GameState>> {
  if (!savePath) {
    return { source: "none", state: null };
  }

  try {
    const state = await parseSaveFile(savePath);
    return { source: `save_file:${savePath}`, state };
  } catch (error) {
    return {
      source: "error",
      state: null,
      savePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Format game state for display to the AI
 */
export function formatGameState(
  state: GameState | LogGameState | null,
  source: string
): string {
  if (!state) {
    return `No game state available (source: ${source}). Is Stellaris running with the AI Player mod enabled?`;
  }

  if ("meta" in state) {
    return `**Source:** ${source}\n\n${formatFullGameState(state)}`;
  }

  return `**Source:** ${source}\n\n${formatLogState(state)}`;
}

function formatFullGameState(state: GameState): string {
  const { meta, player, countries, wars } = state;
  const lines: string[] = [];

  lines.push(`# Stellaris Game State`);
  lines.push(`**Date:** ${meta.date} | **Version:** ${meta.version} | **Empire:** ${player.name}`);
  lines.push("");
  if (state.diagnostics) {
    for (const warning of state.diagnostics.warnings) lines.push(`**Warning:** ${warning}`);
    if (state.diagnostics.missingFields.length > 0) {
      lines.push(`**Unavailable fields:** ${state.diagnostics.missingFields.join(", ")}`);
      lines.push("Numeric defaults for unavailable fields are unverified; a zero in those fields does not establish an observed zero.");
    }
    lines.push("");
  }

  // Resources
  lines.push("## Resources");
  lines.push("| Resource | Stockpile | Monthly Income |");
  lines.push("|----------|-----------|----------------|");
  const importantResources = new Set([...RESOURCE_KEYS, ...Object.keys(player.resources), ...Object.keys(player.resourceIncome)]);
  for (const r of importantResources) {
    const stock = player.resources[r] ?? 0;
    const inc = player.resourceIncome[r] ?? 0;
    if (stock !== 0 || inc !== 0) {
      lines.push(
        `| ${r} | ${stock.toFixed(0)} | ${inc >= 0 ? "+" : ""}${inc.toFixed(1)} |`
      );
    }
  }
  lines.push("");

  // Research
  lines.push("## Research");
  const { technologies } = player;
  lines.push(
    `- **Physics:** ${technologies.physics.current || "none"} (${technologies.physics.progress.toFixed(0)})`
  );
  lines.push(
    `- **Society:** ${technologies.society.current || "none"} (${technologies.society.progress.toFixed(0)})`
  );
  lines.push(
    `- **Engineering:** ${technologies.engineering.current || "none"} (${technologies.engineering.progress.toFixed(0)})`
  );
  lines.push(`- **Completed:** ${technologies.completed.length} technologies`);
  lines.push("");

  // Planets
  lines.push(`## Planets (${player.planets.length})`);
  for (const p of player.planets) {
    lines.push(
      `- **${p.name}** (${p.planetClass}, size ${p.size}): ${p.pops} pops, stability ${p.stability.toFixed(0)}, crime ${p.crime.toFixed(0)}, free jobs ${p.freeJobs}`
    );
  }
  lines.push("");

  // Fleets
  lines.push(
    `## Fleets (${player.fleets.length}) - Navy: ${player.navySize}/${player.navyCap}`
  );
  for (const f of player.fleets) {
    if (f.militaryPower > 0) {
      lines.push(
        `- **${f.name}**: ${f.ships} ships, ${f.militaryPower.toFixed(0)} power${f.mia ? " [MIA]" : ""}`
      );
    }
  }
  lines.push("");

  // Diplomacy
  if (countries.length > 0) {
    lines.push(`## Save Country Records (${countries.length}; may include unexplored empires)`);
    for (const c of countries.slice(0, 15)) {
      const tags: string[] = [];
      if (c.isRival) tags.push("RIVAL");
      if (c.hasDefensivePact) tags.push("DEF_PACT");
      if (c.isAtWar) tags.push("AT_WAR");
      if (c.hasFederation) tags.push("FEDERATION");
      lines.push(
        `- **${c.name}** (${c.type}): opinion ${c.opinion}, mil ${c.militaryPower.toFixed(0)}${tags.length ? " [" + tags.join(", ") + "]" : ""}`
      );
    }
    lines.push("");
  }

  // Wars
  if (wars.length > 0) {
    lines.push("## Active Wars");
    for (const w of wars) {
      lines.push(`- **${w.name}**: ${w.warGoal} (started ${w.startDate})`);
    }
  }

  return lines.join("\n");
}

function formatLogState(state: LogGameState): string {
  const lines: string[] = [];
  lines.push(`# Monthly Game Snapshot (from log)`);
  lines.push(`**Date:** ${state.date}${state.empireName ? ` | **Empire:** ${state.empireName}` : ""}`);
  lines.push("");

  if (state.summary) {
    lines.push("## Summary");
    lines.push(`- Planets: ${state.summary.numPlanets}`);
    lines.push(`- Pops: ${state.summary.numPops}`);
    lines.push(`- Navy: ${state.summary.navySize ?? "unknown"}/${state.summary.navyCap}`);
    lines.push(`- Fleet Power: ${state.summary.fleetPower}`);
    lines.push("");
  }

  if (state.resources || state.resourceIncome) {
    lines.push("## Resources");
    lines.push("| Resource | Stockpile | Income |");
    lines.push("|----------|-----------|--------|");
    const keys = new Set([...Object.keys(state.resources ?? {}), ...Object.keys(state.resourceIncome ?? {})]);
    for (const k of keys) {
      const stockpile = state.resources?.[k];
      const inc = state.resourceIncome?.[k];
      lines.push(`| ${k} | ${stockpile ?? "unknown"} | ${inc === undefined ? "unknown" : `${inc >= 0 ? "+" : ""}${inc}`} |`);
    }
    lines.push("");
  }

  if (state.planets && state.planets.length > 0) {
    lines.push(`## Planets (${state.planets.length})`);
    for (const p of state.planets) {
      lines.push(
        `- **${p.name ?? "unknown"}** (${p.planetClass ?? "unknown"}): ${p.pops ?? "unknown"} pops, stability ${p.stability ?? "unknown"}`
      );
    }
    lines.push("");
  }

  if (state.fleets && state.fleets.length > 0) {
    lines.push(`## Fleets (${state.fleets.length})`);
    for (const f of state.fleets) {
      lines.push(`- **${f.name ?? "unknown"}**: ${f.ships ?? "unknown"} ships, ${f.militaryPower ?? "unknown"} power${f.mia ? " [MIA]" : ""}`);
    }
  }

  if (state.researchOutput) {
    lines.push("", "## Monthly Research Output");
    for (const [area, output] of Object.entries(state.researchOutput)) lines.push(`- ${area}: ${output}`);
  }
  if (state.diplomacy?.length) {
    lines.push("", "## Diplomatic Relations");
    for (const country of state.diplomacy) {
      const tags = [country.isRival ? "RIVAL" : "", country.hasDefensivePact ? "DEF_PACT" : "", country.isAtWar ? "AT_WAR" : ""].filter(Boolean);
      lines.push(`- **${country.name ?? "unknown"}**: opinion ${country.opinion ?? "unknown"}${tags.length ? ` [${tags.join(", ")}]` : ""}`);
    }
  }
  return lines.join("\n");
}
