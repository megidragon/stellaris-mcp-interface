#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { LogWatcher } from "./watcher/log-watcher.js";
import { SaveWatcher } from "./watcher/save-watcher.js";
import { CommandWriter } from "./commands/command-writer.js";
import {
  getGameState,
  getGameStateFromSave,
  formatGameState,
} from "./tools/get-game-state.js";
import { RESOURCE_KEYS } from "./parser/types.js";

const config = loadConfig();
const logWatcher = new LogWatcher(config.gameLogPath);
const saveWatcher = new SaveWatcher(config.saveGamesPath, config.saveProfile);
const commandWriter = new CommandWriter(config.stellarisDocumentsPath);

const server = new McpServer({
  name: "stellaris-ai",
  version: "0.1.0",
});

// ─── Tool: get_game_state ───────────────────────────────────────
server.tool(
  "get_game_state",
  "Read a Stellaris snapshot from the latest save or a partial monthly mod report. Returns the source and game date; unavailable fields are not current measurements.",
  {
    source: z
      .enum(["auto", "save", "log"])
      .optional()
      .describe("Data source: auto (best available), save (parse .sav file), log (real-time mod log)"),
    save_profile: z
      .string()
      .optional()
      .describe("Save game profile folder name (e.g. 'ia')"),
  },
  async ({ source, save_profile }) => {
    const effectiveConfig = save_profile
      ? { ...config, saveProfile: save_profile }
      : config;

    let result;
    if (source === "save") {
      result = await getGameStateFromSave(effectiveConfig);
    } else if (source === "log") {
      await logWatcher.refresh();
      const logState = logWatcher.latestState;
      result = { source: "game_log", state: logState };
    } else {
      result = await getGameState(effectiveConfig, logWatcher);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: formatGameState(result.state, result.source) +
            ("error" in result && result.error ? `\nError: ${result.error}` : ""),
        },
      ],
    };
  }
);

// ─── Tool: get_resources ────────────────────────────────────────
server.tool(
  "get_resources",
  "Get current resource stockpiles and monthly income for the player's empire.",
  {
    save_profile: z.string().optional(),
  },
  async ({ save_profile }) => {
    const effectiveConfig = save_profile
      ? { ...config, saveProfile: save_profile }
      : config;

    const { state, source, error } = await getGameState(effectiveConfig, logWatcher);
    if (!state) {
      return { content: [{ type: "text" as const, text: error || "No game state available." }] };
    }

    let text: string;
    if ("player" in state) {
      const { resources, resourceIncome } = state.player;
      const lines = [`# Resources (source: ${source}, date: ${state.meta.date})\n| Resource | Stockpile | Monthly |`, "|----------|-----------|---------|"];
      for (const k of new Set([...RESOURCE_KEYS, ...Object.keys(resources), ...Object.keys(resourceIncome)])) {
        const s = resources[k] ?? 0;
        const i = resourceIncome[k] ?? 0;
        if (s > 0 || i !== 0) {
          lines.push(`| ${k} | ${s.toFixed(0)} | ${i >= 0 ? "+" : ""}${i.toFixed(1)} |`);
        }
      }
      text = lines.join("\n") + diagnosticNotice(state.diagnostics);
    } else {
      text = `Resource report (source: ${source}, date: ${state.date}):\n` + JSON.stringify({ stockpiles: state.resources, monthlyIncome: state.resourceIncome }, null, 2);
    }

    return { content: [{ type: "text" as const, text }] };
  }
);

// ─── Tool: get_planets ──────────────────────────────────────────
server.tool(
  "get_planets",
  "Get details about all owned planets (pops, buildings, districts, stability, jobs).",
  {
    save_profile: z.string().optional(),
  },
  async ({ save_profile }) => {
    const effectiveConfig = save_profile
      ? { ...config, saveProfile: save_profile }
      : config;

    const { state, source, error } = await getGameState(effectiveConfig, logWatcher);
    if (!state) {
      return { content: [{ type: "text" as const, text: error || "No game state available." }] };
    }

    let text: string;
    if ("player" in state) {
      const planets = state.player.planets;
      const lines = [`# Owned Planets (${planets.length}, source: ${source}, date: ${state.meta.date})\n`];
      for (const p of planets) {
        lines.push(`## ${p.name} (ID: ${p.id})`);
        lines.push(`- Class: ${p.planetClass}, Size: ${p.size}`);
        lines.push(`- Pops: ${p.pops}, Stability: ${p.stability.toFixed(1)}, Crime: ${p.crime.toFixed(1)}`);
        lines.push(`- Housing: ${p.housing.toFixed(0)} (free: ${p.freeHousing}), Free Jobs: ${p.freeJobs}`);
        lines.push(`- Designation: ${p.designation || "none"}`);
        if (p.buildings.length > 0) {
          lines.push(`- Buildings: ${p.buildings.join(", ")}`);
        }
        if (Object.keys(p.districts).length > 0) {
          const distStr = Object.entries(p.districts)
            .map(([k, v]) => `${k}×${v}`)
            .join(", ");
          lines.push(`- Districts: ${distStr}`);
        }
        lines.push("");
      }
      text = lines.join("\n") + diagnosticNotice(state.diagnostics);
    } else {
      text = state.planets ? JSON.stringify({ source, date: state.date, planets: state.planets }, null, 2) :
        "No planet details in this monthly report. Save data provides stable planet IDs and additional details.";
    }

    return { content: [{ type: "text" as const, text }] };
  }
);

// ─── Tool: get_fleets ───────────────────────────────────────────
server.tool(
  "get_fleets",
  "Get details about all owned fleets (ships, power, location).",
  {
    save_profile: z.string().optional(),
  },
  async ({ save_profile }) => {
    const effectiveConfig = save_profile
      ? { ...config, saveProfile: save_profile }
      : config;

    const { state, source, error } = await getGameState(effectiveConfig, logWatcher);
    if (!state) {
      return { content: [{ type: "text" as const, text: error || "No game state available." }] };
    }

    let text: string;
    if ("player" in state) {
      const { fleets, navySize, navyCap } = state.player;
      const military = fleets.filter((f) => f.militaryPower > 0);
      const civilian = fleets.filter((f) => f.militaryPower === 0);

      const lines = [`# Fleets - Navy: ${navySize}/${navyCap} (source: ${source}, date: ${state.meta.date})\n`];
      lines.push(`## Military Fleets (${military.length})`);
      for (const f of military) {
        lines.push(`- **${f.name}** (ID: ${f.id}): ${f.ships} ships, ${f.militaryPower.toFixed(0)} power, location: ${f.location || "unknown"}${f.mia ? " [MIA]" : ""}`);
      }
      lines.push(`\n## Civilian Fleets (${civilian.length})`);
      for (const f of civilian) {
        lines.push(`- **${f.name}** (ID: ${f.id}): ${f.ships} ships`);
      }
      text = lines.join("\n") + diagnosticNotice(state.diagnostics);
    } else {
      text = state.fleets ? JSON.stringify({ source, date: state.date, fleets: state.fleets }, null, 2) :
        "No fleet details in this monthly report. Save data provides stable fleet IDs and additional details.";
    }

    return { content: [{ type: "text" as const, text }] };
  }
);

// ─── Tool: get_technologies ─────────────────────────────────────
server.tool(
  "get_technologies",
  "Read selected research and completed technologies from the latest save. The monthly log reports output only, so this tool uses save data.",
  {
    save_profile: z.string().optional(),
  },
  async ({ save_profile }) => {
    const effectiveConfig = save_profile
      ? { ...config, saveProfile: save_profile }
      : config;

    const { state, source, error } = await getGameStateFromSave(effectiveConfig);
    if (!state || !("player" in state)) {
      return { content: [{ type: "text" as const, text: error || "No tech data available." }] };
    }

    const { technologies } = state.player;
    const lines = [
      `# Research Status (source: ${source}, date: ${state.meta.date})\n`,
      `## Currently Researching`,
      `- **Physics:** ${technologies.physics.current || "none"} (progress: ${technologies.physics.progress.toFixed(0)})`,
      `- **Society:** ${technologies.society.current || "none"} (progress: ${technologies.society.progress.toFixed(0)})`,
      `- **Engineering:** ${technologies.engineering.current || "none"} (progress: ${technologies.engineering.progress.toFixed(0)})`,
      "",
      `## Completed Technologies (${technologies.completed.length})`,
      technologies.completed.join(", "),
    ];

    return { content: [{ type: "text" as const, text: lines.join("\n") + diagnosticNotice(state.diagnostics) }] };
  }
);

// ─── Tool: get_diplomacy ────────────────────────────────────────
server.tool(
  "get_diplomacy",
  "Read available diplomatic records. Monthly reports cover contacted default empires; saves can include unexplored country records. Missing relation fields appear in diagnostics.",
  {
    save_profile: z.string().optional(),
  },
  async ({ save_profile }) => {
    const effectiveConfig = save_profile
      ? { ...config, saveProfile: save_profile }
      : config;

    const { state, source, error } = await getGameState(effectiveConfig, logWatcher);
    if (!state) {
      return { content: [{ type: "text" as const, text: error || "No diplomacy data available." }] };
    }

    let text: string;
    if ("player" in state) {
      const lines = [`# Diplomatic Relations (source: ${source}, date: ${state.meta.date})\n`];
      for (const c of state.countries) {
        const tags: string[] = [];
        if (c.isRival) tags.push("RIVAL");
        if (c.hasDefensivePact) tags.push("DEFENSIVE PACT");
        if (c.hasFederation) tags.push("FEDERATION");
        if (c.isAtWar) tags.push("AT WAR");
        lines.push(`## ${c.name} (${c.type})`);
        lines.push(`- Government: ${c.government}`);
        lines.push(`- Ethics: ${c.ethics.join(", ")}`);
        lines.push(`- Opinion: ${c.opinion} | Attitude: ${c.attitude}`);
        lines.push(`- Military: ${c.militaryPower.toFixed(0)} | Tech: ${c.techPower.toFixed(0)} | Economy: ${c.economyPower.toFixed(0)}`);
        lines.push(`- Planets: ${c.numPlanets} | Pops: ${c.numPops}`);
        if (tags.length) lines.push(`- Status: ${tags.join(", ")}`);
        lines.push("");
      }

      if (state.wars && state.wars.length > 0) {
        lines.push("## Active Wars");
        for (const w of state.wars) {
          lines.push(`- **${w.name}**: ${w.warGoal} (started ${w.startDate})`);
        }
      }

      text = lines.join("\n") + diagnosticNotice(state.diagnostics);
    } else {
      text = JSON.stringify({ source, date: state.date, diplomacy: state.diplomacy ?? "unavailable" }, null, 2);
    }

    return { content: [{ type: "text" as const, text }] };
  }
);

// ─── Tool: execute_command ──────────────────────────────────────
server.tool(
  "execute_command",
  "Write a console command to a unique batch file. This does not execute it: the player must run the exact returned `run <filename>` command in the Stellaris console.",
  {
    command: z.string().describe("Console command to execute (e.g. 'cash 1000', 'research_technology tech_lasers_2')"),
  },
  async ({ command }) => {
    commandWriter.queueCommand(command);
    const result = await commandWriter.flush();
    return { content: [{ type: "text" as const, text: result }] };
  }
);

// ─── Tool: execute_effect ───────────────────────────────────────
server.tool(
  "execute_effect",
  "Write PDXScript prefixed with `effect` to a unique batch file for manual execution. The returned filename must be run in the game console; writing is not execution.",
  {
    effect: z.string().describe("PDXScript effect code (e.g. 'add_resource = { energy = 500 }')"),
  },
  async ({ effect }) => {
    commandWriter.queueEffect(effect);
    const result = await commandWriter.flush();
    return { content: [{ type: "text" as const, text: result }] };
  }
);

// ─── Tool: queue_commands ───────────────────────────────────────
server.tool(
  "queue_commands",
  "Write multiple console commands to a unique batch file and return the exact console command needed to execute it manually.",
  {
    commands: z
      .array(z.string())
      .describe("Array of console commands to queue"),
  },
  async ({ commands }) => {
    for (const cmd of commands) {
      commandWriter.queueCommand(cmd);
    }
    const result = await commandWriter.flush();
    return { content: [{ type: "text" as const, text: result }] };
  }
);

// ─── Tool: list_save_profiles ───────────────────────────────────
server.tool(
  "list_save_profiles",
  "List available save game profiles and their save files.",
  {},
  async () => {
    const { readdir, stat } = await import("fs/promises");
    const { join } = await import("path");

    try {
      const entries = await readdir(config.saveGamesPath);
      const lines = ["# Save Game Profiles\n"];

      for (const entry of entries) {
        const entryPath = join(config.saveGamesPath, entry);
        const s = await stat(entryPath);
        if (s.isDirectory()) {
          const files = await readdir(entryPath);
          const saves = files.filter((f) => f.endsWith(".sav"));
          lines.push(`- **${entry}**: ${saves.length} save(s) — ${saves.join(", ")}`);
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error reading save directory: ${error}`,
          },
        ],
      };
    }
  }
);

// ─── Tool: analyze_situation ────────────────────────────────────
server.tool(
  "analyze_situation",
  "Get a comprehensive strategic analysis of the current game situation, combining all available data sources.",
  {
    save_profile: z.string().optional(),
    style: z.enum(["standard", "fallen_empire"]).optional()
      .describe("fallen_empire favors a dormant, defensive empire with minimal expansion; it changes advice only"),
  },
  async ({ save_profile, style }) => {
    const effectiveConfig = save_profile
      ? { ...config, saveProfile: save_profile }
      : config;

    const { state, source, error } = await getGameState(effectiveConfig, logWatcher);
    if (!state) {
      return {
        content: [
          {
            type: "text" as const,
            text: error || "No game data available. Ensure Stellaris is running with autosave enabled, or specify a save_profile.",
          },
        ],
      };
    }

    const formattedState = formatGameState(state, source);

    const dormant = (style ?? config.advisorStyle) === "fallen_empire";
    const doctrine = dormant ? [
      "Roleplay a dormant Fallen Empire using the player's normal empire mechanics.",
      "Maintain the economy, repair losses and defend existing borders. Avoid routine colonization, annexation, claims or offensive wars.",
      "Prioritize resource solvency, stable planets, research, fleet readiness and reserves. Use measured net monthly deficits to estimate reserve runway; do not invent missing values.",
      "Identify an awakening trigger only when the snapshot shows invasion, an imminent existential threat or a galactic crisis. Report the evidence and a defensive response.",
      "Use normal legal game actions. Do not suggest resource grants, instant construction/research or changing country type as routine management.",
    ] : [];
    const analysis = [
      formattedState,
      "",
      "---",
      "## Instructions for AI Advisor",
      "",
      "This is a dated snapshot. Check source, game version and missing-field diagnostics before recommending actions. Log reports are partial and contain no stable object IDs.",
      "Analyze the observed data and provide strategic advice covering:",
      ...doctrine,
      "1. **Economic Assessment** — Are resources balanced? Any critical shortages?",
      "2. **Military Assessment** — Fleet strength relative to neighbors. Vulnerabilities?",
      dormant ? "3. **Territorial Discipline** — Can the existing empire remain stable without expansion?" :
        "3. **Expansion Opportunities** — Available colonization targets, claims worth pressing?",
      "4. **Diplomatic Landscape** — Threats, potential allies, federation opportunities?",
      "5. **Technology Priorities** — What should be researched next given current situation?",
      "6. **Recommended Actions** — Top 3-5 concrete actions to take this decade.",
      "",
      "If you want to execute actions, use the `execute_command` or `queue_commands` tools.",
      "The player must run the exact `run <filename>` returned by each tool in the Stellaris console. Writing a batch is not confirmation it was executed.",
    ];

    return { content: [{ type: "text" as const, text: analysis.join("\n") }] };
  }
);

// ─── Start the server ───────────────────────────────────────────
async function main() {
  // Start watchers
  try {
    await logWatcher.start();
  } catch (error) {
    console.error("Unable to start game-log monitoring:", error);
  }

  try {
    await saveWatcher.start();
  } catch (error) {
    console.error("Unable to start save monitoring:", error);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

function diagnosticNotice(diagnostics: import("./parser/types.js").GameState["diagnostics"]): string {
  if (!diagnostics) return "";
  const messages = [...diagnostics.warnings];
  if (diagnostics.missingFields.length) {
    messages.push(`Unavailable fields (numeric defaults are not measurements): ${diagnostics.missingFields.join(", ")}`);
  }
  return messages.length ? "\n\nData diagnostics:\n" + messages.map((message) => `- ${message}`).join("\n") : "";
}
