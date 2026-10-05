import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";

export interface StellarisMcpConfig {
  /** Path to Documents/Paradox Interactive/Stellaris/ */
  stellarisDocumentsPath: string;
  /** Path to Stellaris installation */
  stellarisInstallPath: string;
  /** Path to game.log */
  gameLogPath: string;
  /** Path to save games directory */
  saveGamesPath: string;
  /** Path to the mod directory in documents */
  modDocumentsPath: string;
  /** Active save game profile name */
  saveProfile: string;
  /** How often (in game months) to do a full state dump */
  fullDumpInterval: number;
  /** Advice style; this does not automate or change the player's country type. */
  advisorStyle?: "standard" | "fallen_empire";
}

export function loadConfig(): StellarisMcpConfig {
  const documentsPath = resolveDocumentsPath();

  const installPath =
    process.env.STELLARIS_INSTALL_PATH ||
    join(process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)", "Steam", "steamapps", "common", "Stellaris");

  const saveProfile = process.env.STELLARIS_SAVE_PROFILE || "";

  return {
    stellarisDocumentsPath: documentsPath,
    stellarisInstallPath: installPath,
    gameLogPath: join(documentsPath, "logs", "game.log"),
    saveGamesPath: join(documentsPath, "save games"),
    modDocumentsPath: join(documentsPath, "mod"),
    saveProfile,
    fullDumpInterval: 1,
    advisorStyle: process.env.STELLARIS_ADVISOR_STYLE === "fallen_empire" ? "fallen_empire" : "standard",
  };
}

/** Discover standard/OneDrive Documents, with an explicit override taking priority. */
export function resolveDocumentsPath(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): string {
  if (env.STELLARIS_DOCUMENTS_PATH) return env.STELLARIS_DOCUMENTS_PATH;
  const standard = join(userHome, "Documents", "Paradox Interactive", "Stellaris");
  const roots = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial, join(userHome, "OneDrive")];
  const candidates = [...new Set([standard, ...roots
    .filter((root): root is string => Boolean(root))
    .map((root) => join(root, "Documents", "Paradox Interactive", "Stellaris"))])];
  let best = standard;
  let newest = -Infinity;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const log = join(candidate, "logs", "game.log");
      const modified = statSync(existsSync(log) ? log : candidate).mtimeMs;
      if (modified > newest) {
        newest = modified;
        best = candidate;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return best;
}
