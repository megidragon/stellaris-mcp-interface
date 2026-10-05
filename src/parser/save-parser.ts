import AdmZip from "adm-zip";
import { Jomini } from "jomini";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  Country, Fleet, GameMeta, GameState, Leader, Planet, PlayerState,
  Policy, Resources, TechState, War,
} from "./types.js";
import { RESOURCE_KEYS } from "./types.js";

type SaveObject = Record<string, unknown>;
type Diagnostics = NonNullable<GameState["diagnostics"]>;

export class SaveParseError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SaveParseError";
  }
}

let jominiInstance: Promise<Jomini> | undefined;

async function getJomini(): Promise<Jomini> {
  jominiInstance ??= Jomini.initialize();
  return jominiInstance;
}

function errorCode(error: unknown): string | undefined {
  return object(error)?.code as string | undefined;
}

/** Search the save root and campaign subdirectories, without following symlinks. */
export async function findLatestSave(saveDir: string, profile?: string): Promise<string | null> {
  const root = resolve(saveDir);
  const searchDir = profile ? resolve(root, profile) : root;
  const profilePath = relative(root, searchDir);
  if (isAbsolute(profilePath) || profilePath === ".." || profilePath.startsWith("..\\") || profilePath.startsWith("../")) {
    throw new Error("Save profile must be inside the configured save directory");
  }
  const directories = [searchDir];
  let latest: string | null = null;
  let latestTime = -Infinity;
  while (directories.length > 0) {
    const directory = directories.pop();
    if (!directory) continue;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") continue;
      throw new Error(`Cannot inspect save directory: ${directory}`, { cause: error });
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".sav")) {
        try {
          const info = await stat(path);
          if (info.mtimeMs > latestTime || (info.mtimeMs === latestTime && (!latest || path < latest))) {
            latest = path;
            latestTime = info.mtimeMs;
          }
        } catch (error: unknown) {
          // An autosave may be replaced between listing and statting it.
          if (errorCode(error) !== "ENOENT") throw new Error(`Cannot inspect save file: ${path}`, { cause: error });
        }
      }
    }
  }
  return latest;
}

/** Read a compressed plaintext Stellaris save. Does not change the save or game. */
export async function parseSaveFile(savePath: string): Promise<GameState> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(await readFile(savePath));
  } catch (error: unknown) {
    throw new SaveParseError("SAVE_READ_FAILED", `Cannot read Stellaris save archive: ${savePath}`, { cause: error });
  }
  const gamestateEntry = zip.getEntry("gamestate");
  const metaEntry = zip.getEntry("meta");
  if (!gamestateEntry) throw new SaveParseError("GAMESTATE_MISSING", `Save archive has no gamestate entry: ${savePath}`);
  const parser = await getJomini();
  let gs: SaveObject;
  let meta: SaveObject;
  try {
    gs = object(parser.parseText(gamestateEntry.getData(), { typeNarrowing: "unquoted" })) ?? {};
  } catch (error: unknown) {
    throw new SaveParseError("GAMESTATE_PARSE_FAILED", `Cannot parse plaintext gamestate in ${savePath}`, { cause: error });
  }
  try {
    meta = metaEntry ? object(parser.parseText(metaEntry.getData(), { typeNarrowing: "unquoted" })) ?? {} : {};
  } catch (error: unknown) {
    throw new SaveParseError("META_PARSE_FAILED", `Cannot parse save metadata in ${savePath}`, { cause: error });
  }
  const diagnostics: Diagnostics = {
    source: "save", savePath,
    warnings: ["This is a partial save snapshot. Fields listed as missing are unknown; compatibility defaults are not measured values."],
    missingFields: [],
  };
  if (!metaEntry) diagnostics.warnings.push("The archive has no meta entry; metadata is read from gamestate.");
  const gameMeta = extractMeta(meta, gs);
  const version = /(?:^|\s)v?(\d+)\.(\d+)/i.exec(gameMeta.version);
  if (version && Number(version[1]) < 4) {
    diagnostics.warnings.push(`Legacy save version ${gameMeta.version}; it does not establish compatibility with the running Stellaris version.`);
  } else {
    diagnostics.warnings.push(`Save version ${gameMeta.version} is parsed with best-effort field extraction; current 4.x schemas have not been validated with a live campaign save.`);
  }
  if (meta.version !== undefined && gs.version !== undefined && str(meta.version) !== str(gs.version)) {
    diagnostics.warnings.push("Metadata and gamestate report different versions; the metadata version is displayed.");
  }
  const playerId = extractPlayerId(gs);
  const playerData = object(findInObject(gs.country, playerId));
  if (!playerData) throw new SaveParseError("PLAYER_COUNTRY_MISSING", `Player country ${playerId} does not exist in the save country table`);
  return {
    meta: gameMeta,
    player: extractPlayerState(gs, playerData, playerId, diagnostics),
    countries: extractCountries(gs, playerId, diagnostics),
    wars: extractWars(gs), timestamp: new Date().toISOString(), diagnostics,
  };
}

function object(value: unknown): SaveObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
    ? value as SaveObject : undefined;
}

function list(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function numeric(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function missing(diagnostics: Diagnostics, field: string): void {
  if (!diagnostics.missingFields.includes(field)) diagnostics.missingFields.push(field);
}

function measured(value: unknown, field: string, diagnostics: Diagnostics): number {
  const result = numeric(value);
  if (result !== undefined) return result;
  missing(diagnostics, field);
  return 0;
}

function bool(value: unknown): boolean {
  return value === true || value === "yes" || value === 1;
}

function str(value: unknown, fallback = ""): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  const data = object(value);
  if (data?.key !== undefined) return str(data.key, fallback);
  if (data?.name !== undefined) return str(data.name, fallback);
  return fallback;
}

/** Preserve localization/mod keys; no localization is guessed from an identifier. */
function name(value: unknown): string {
  const data = object(value);
  if (data?.first_name !== undefined || data?.second_name !== undefined) {
    return [str(data.first_name), str(data.second_name)].filter(Boolean).join(" ") || "Unknown";
  }
  return str(value, "Unknown");
}

function formatDate(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}.${String(value.getUTCMonth() + 1).padStart(2, "0")}.${String(value.getUTCDate()).padStart(2, "0")}`;
  }
  return str(value, "unknown");
}

function extractMeta(meta: SaveObject, gs: SaveObject): GameMeta {
  return {
    version: str(meta.version ?? gs.version, "unknown"), name: name(meta.name ?? gs.name),
    date: formatDate(meta.date ?? gs.date), requiredDlcs: strings(meta.required_dlcs ?? gs.required_dlcs),
  };
}

function extractPlayerId(gs: SaveObject): number {
  const ids = new Set(list(gs.player).map(p => numeric(object(p)?.country)).filter((id): id is number => id !== undefined && Number.isInteger(id) && id >= 0 && id !== 4294967295));
  if (ids.size === 0) throw new SaveParseError("PLAYER_MISSING", "Save has no resolvable player country; refusing to assume country 0");
  if (ids.size > 1) throw new SaveParseError("PLAYER_AMBIGUOUS", "Save contains multiple player countries; select a single-player or cooperative empire save");
  return [...ids][0];
}

function emptyResources(): Resources {
  return Object.fromEntries(RESOURCE_KEYS.map(key => [key, 0])) as unknown as Resources;
}

const RESOURCE_ALIASES: Record<string, string> = {
  sr_dark_matter: "dark_matter", sr_living_metal: "living_metal", sr_zro: "zro",
};

/** Budgets are either direct resource maps or nested maps of economic categories. */
function resourceMap(value: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, amount] of Object.entries(object(value) ?? {})) {
    const number = numeric(amount);
    if (number !== undefined) result[key] = (result[key] ?? 0) + number;
    else if (object(amount)) {
      for (const [resource, quantity] of Object.entries(resourceMap(amount))) result[resource] = (result[resource] ?? 0) + quantity;
    }
  }
  return result;
}

function resources(value: Record<string, number>, field: string, diagnostics: Diagnostics): Resources {
  const result = Object.assign(emptyResources(), value);
  for (const [raw, canonical] of Object.entries(RESOURCE_ALIASES)) {
    if (value[raw] !== undefined && value[canonical] === undefined) result[canonical] = value[raw];
  }
  for (const key of RESOURCE_KEYS) {
    const alias = Object.entries(RESOURCE_ALIASES).find(([, canonical]) => canonical === key)?.[0];
    if (value[key] === undefined && (!alias || value[alias] === undefined)) missing(diagnostics, `${field}.${key}`);
  }
  return result;
}

function extractResources(country: SaveObject, diagnostics: Diagnostics): { stockpile: Resources; income: Resources } {
  const modules = object(country.modules);
  const economy = object(modules?.standard_economy_module ?? modules?.economy_module);
  const current = object(object(country.budget)?.current_month);
  let net = resourceMap(current?.balance);
  if (current?.balance === undefined && current?.income !== undefined && current?.expenses !== undefined) {
    net = resourceMap(current.income);
    for (const [key, expense] of Object.entries(resourceMap(current.expenses))) net[key] = (net[key] ?? 0) - expense;
  } else if (!current && economy?.last_month !== undefined) {
    net = resourceMap(economy.last_month);
    diagnostics.warnings.push("Resource income uses the economy module's last_month values rather than the current budget.");
  }
  return {
    stockpile: resources(resourceMap(economy?.resources), "player.resources", diagnostics),
    income: resources(net, "player.resourceIncome", diagnostics),
  };
}

function extractPlayerState(gs: SaveObject, country: SaveObject, playerId: number, diagnostics: Diagnostics): PlayerState {
  const { stockpile, income } = extractResources(country, diagnostics);
  missing(diagnostics, "player.starbases");
  return {
    countryId: playerId, name: name(country.name), resources: stockpile, resourceIncome: income,
    planets: extractPlanets(gs, country, diagnostics), fleets: extractFleets(gs, country, diagnostics),
    technologies: extractTech(country, income, diagnostics), leaders: extractLeaders(gs, country, diagnostics), starbases: [],
    traditions: strings(country.traditions), ascensionPerks: strings(country.ascension_perks),
    edicts: strings(country.active_edicts), policies: extractPolicies(country),
    navySize: measured(country.used_naval_capacity ?? country.fleet_size, "player.navySize", diagnostics),
    navyCap: measured(country.navy_cap, "player.navyCap", diagnostics),
    empireCohesion: measured(country.empire_cohesion, "player.empireCohesion", diagnostics),
  };
}

function extractPlanets(gs: SaveObject, country: SaveObject, diagnostics: Diagnostics): Planet[] {
  const planetMap = object(gs.planets)?.planet ?? gs.planet;
  if (country.owned_planets === undefined) missing(diagnostics, "player.planets");
  return ids(country.owned_planets).flatMap(id => {
    const data = object(findInObject(planetMap, id));
    const field = `player.planets[${id}]`;
    if (!data) { missing(diagnostics, field); return []; }
    if (data.buildings === undefined) missing(diagnostics, `${field}.buildings`);
    if (data.district === undefined) missing(diagnostics, `${field}.districts`);
    if (data.designation === undefined && data.planet_designation === undefined && data.colony_type === undefined) {
      missing(diagnostics, `${field}.designation`);
    }
    const buildings: string[] = [];
    for (const entry of list(data.buildings)) {
      const reference = numeric(entry);
      const type = reference !== undefined ? str(object(findInObject(gs.buildings, reference))?.type) : str(object(entry)?.type ?? entry);
      if (type) buildings.push(type);
      else missing(diagnostics, `${field}.buildings[${str(entry)}]`);
    }
    const districts: Record<string, number> = {};
    for (const entry of list(data.district)) {
      const type = str(object(entry)?.type ?? entry);
      if (type) districts[type] = (districts[type] ?? 0) + 1;
    }
    let freeJobs = data.free_jobs;
    if (freeJobs === undefined && Array.isArray(data.jobs_cache)) {
      const jobs = data.jobs_cache.map(object).filter((job): job is SaveObject => job !== undefined);
      if (jobs.length > 0 && jobs.every(job => numeric(job.max_employed) !== undefined && numeric(job.num_employed) !== undefined)) {
        freeJobs = jobs.reduce((total, job) => total + (numeric(job.max_employed) ?? 0) - (numeric(job.num_employed) ?? 0), 0);
      }
    }
    return [{
      id, name: name(data.name), planetClass: str(data.planet_class),
      size: measured(data.planet_size, `${field}.size`, diagnostics),
      pops: measured(Array.isArray(data.pop) ? data.pop.length : data.num_pops ?? data.num_sapient_pops, `${field}.pops`, diagnostics),
      buildings, districts, stability: measured(data.stability, `${field}.stability`, diagnostics),
      amenities: measured(data.free_amenities ?? data.amenities, `${field}.amenities`, diagnostics),
      housing: measured(data.total_housing ?? data.housing, `${field}.housing`, diagnostics),
      freeHousing: measured(data.free_housing, `${field}.freeHousing`, diagnostics),
      crime: measured(data.crime, `${field}.crime`, diagnostics), freeJobs: measured(freeJobs, `${field}.freeJobs`, diagnostics),
      designation: str(data.designation ?? data.planet_designation ?? data.colony_type),
      modifiers: list(data.timed_modifier).flatMap(modifier => strings(object(modifier)?.modifier)).concat(strings(data.modifier)),
    }];
  });
}

function extractFleets(gs: SaveObject, country: SaveObject, diagnostics: Diagnostics): Fleet[] {
  const references = object(country.fleets_manager)?.owned_fleets ?? country.owned_fleets;
  if (references === undefined) missing(diagnostics, "player.fleets");
  return ids(references, "fleet").flatMap(id => {
    const data = object(findInObject(gs.fleet, id));
    const field = `player.fleets[${id}]`;
    if (!data) { missing(diagnostics, field); return []; }
    const civilian = bool(data.civilian);
    return [{
      id, name: name(data.name), ships: measured(Array.isArray(data.ships) ? data.ships.length : data.num_ships, `${field}.ships`, diagnostics),
      militaryPower: measured(data.military_power, `${field}.militaryPower`, diagnostics),
      isMilitary: data.military !== undefined ? bool(data.military) : !civilian && !bool(data.station), isCivilian: civilian,
      location: str(object(object(data.movement_manager)?.coordinate)?.origin), mia: bool(data.mia),
    }];
  });
}

function extractTech(country: SaveObject, income: Resources, diagnostics: Diagnostics): TechState {
  const status = object(country.tech_status);
  const active = object(status?.active_research);
  function area(areaName: "physics" | "society" | "engineering") {
    const data = object(active?.[areaName]) ?? object(list(status?.[`${areaName}_queue`])[0]);
    if (!data) missing(diagnostics, `player.technologies.${areaName}.current`);
    if (diagnostics.missingFields.includes(`player.resourceIncome.${areaName}_research`)) {
      missing(diagnostics, `player.technologies.${areaName}.output`);
    }
    return {
      current: str(data?.technology), progress: measured(data?.progress, `player.technologies.${areaName}.progress`, diagnostics),
      output: income[`${areaName}_research`],
    };
  }
  return { physics: area("physics"), society: area("society"), engineering: area("engineering"), completed: strings(status?.technology, "technology") };
}

function extractLeaders(gs: SaveObject, country: SaveObject, diagnostics: Diagnostics): Leader[] {
  const references = country.owned_leaders ?? country.leaders;
  if (references === undefined) missing(diagnostics, "player.leaders");
  return list(references).flatMap(reference => {
    const id = numeric(object(reference)?.id ?? reference);
    const data = object(reference) ?? (id === undefined ? undefined : object(findInObject(gs.leaders ?? gs.leader, id)));
    if (!data || id === undefined) { missing(diagnostics, `player.leaders[${str(reference)}]`); return []; }
    const field = `player.leaders[${id}]`;
    const role = object(object(data.roles)?.[str(data.class)]);
    return [{
      id, name: name(data.name), class: str(data.class), level: measured(data.level, `${field}.level`, diagnostics),
      age: measured(data.age, `${field}.age`, diagnostics), traits: strings(data.traits ?? role?.trait),
    }];
  });
}

function extractCountries(gs: SaveObject, playerId: number, diagnostics: Diagnostics): Country[] {
  const player = object(findInObject(gs.country, playerId));
  const relations = list(object(player?.relations_manager)?.relation).map(object);
  return Object.entries(object(gs.country) ?? {}).flatMap(([idText, value]) => {
    const id = numeric(idText);
    const data = object(value);
    if (id === undefined || id === playerId || !data) return [];
    const type = str(data.type ?? data.country_type);
    if (!type) return [];
    const relation = relations.find(item => numeric(item?.country) === id);
    const field = `countries[${id}]`;
    return [{
      id, name: name(data.name), type, government: str(object(data.government)?.type), ethics: strings(object(data.ethos)?.ethic),
      militaryPower: measured(data.military_power, `${field}.militaryPower`, diagnostics),
      techPower: measured(data.tech_power, `${field}.techPower`, diagnostics), economyPower: measured(data.economy_power, `${field}.economyPower`, diagnostics),
      numPlanets: measured(Array.isArray(data.owned_planets) ? data.owned_planets.length : data.num_owned_planets, `${field}.numPlanets`, diagnostics),
      numPops: measured(data.num_pops ?? data.sapient, `${field}.numPops`, diagnostics), opinion: measured(relation?.opinion, `${field}.opinion`, diagnostics),
      isRival: bool(relation?.is_rival), hasDefensivePact: bool(relation?.defensive_pact),
      hasFederation: data.federation !== undefined && numeric(data.federation) !== 4294967295,
      isAtWar: bool(data.at_war), attitude: str(relation?.attitude, "unknown"),
    }];
  });
}

function extractWars(gs: SaveObject): War[] {
  const entries = Array.isArray(gs.war) ? gs.war : Object.values(object(gs.war) ?? {});
  return entries.flatMap(value => {
    const data = object(value);
    if (!data) return [];
    return [{
      name: name(data.name), attackers: ids(data.attackers, "country").map(String), defenders: ids(data.defenders, "country").map(String),
      warGoal: str(object(data.war_goal)?.type), startDate: formatDate(data.start_date),
    }];
  });
}

function extractPolicies(country: SaveObject): Policy[] {
  const raw = country.active_policies ?? country.policies;
  const values = object(raw)?.policy !== undefined ? [raw] : Array.isArray(raw) ? raw : Object.values(object(raw) ?? {});
  return values.flatMap(value => {
    const data = object(value);
    return data?.policy !== undefined ? [{ name: str(data.policy), selected: str(data.selected) }] : [];
  });
}

function findInObject(value: unknown, id: number): unknown {
  return Array.isArray(value) ? value[id] : object(value)?.[String(id)];
}

function strings(value: unknown, key?: string): string[] {
  return list(value).map(item => str(key ? object(item)?.[key] ?? item : item)).filter(Boolean);
}

function ids(value: unknown, key?: string): number[] {
  return list(value).map(item => numeric(key ? object(item)?.[key] ?? item : item)).filter((id): id is number => id !== undefined && Number.isInteger(id) && id >= 0 && id !== 4294967295);
}
