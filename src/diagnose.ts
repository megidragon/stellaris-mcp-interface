import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { parseGameLog } from "./parser/log-parser.js";
import { findLatestSave, parseSaveFile } from "./parser/save-parser.js";

/** Read-only local check; does not install a mod or write to the game directory. */
async function main(): Promise<void> {
  const config = loadConfig();
  const savePath = process.argv[2] || await findLatestSave(config.saveGamesPath, config.saveProfile);
  const report: Record<string, unknown> = {
    documentsPath: config.stellarisDocumentsPath,
    installPath: config.stellarisInstallPath,
    commandExecution: "manual console run; no execution acknowledgement",
  };
  try {
    const settings: unknown = JSON.parse(await readFile(join(config.stellarisInstallPath, "launcher-settings.json"), "utf8"));
    if (typeof settings === "object" && settings !== null && "version" in settings) {
      report.installedVersion = settings.version;
    }
  } catch (error) {
    report.installationDiagnostic = String(error);
  }
  try {
    const state = await parseGameLog(config.gameLogPath);
    report.liveReport = state ? { date: state.date, empire: state.empireName, summary: state.summary } : null;
  } catch (error) {
    report.logError = String(error);
  }
  if (savePath) {
    try {
      const state = await parseSaveFile(savePath);
      report.save = {
        path: savePath, version: state.meta.version, date: state.meta.date,
        empire: state.player.name, countryId: state.player.countryId,
        planets: state.player.planets.length, fleets: state.player.fleets.length,
        resources: state.player.resources, monthlyIncome: state.player.resourceIncome,
        diagnostics: state.diagnostics,
      };
    } catch (error) {
      report.save = { path: savePath, error: String(error) };
      process.exitCode = 1;
    }
  } else {
    report.save = null;
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  console.error("Diagnosis failed:", error);
  process.exitCode = 1;
});
