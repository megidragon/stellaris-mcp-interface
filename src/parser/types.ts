/** Core game state extracted from save files or log parsing */
export interface GameState {
  meta: GameMeta;
  player: PlayerState;
  countries: Country[];
  wars: War[];
  timestamp: string;
  diagnostics?: {
    source: "save";
    warnings: string[];
    missingFields: string[];
    savePath?: string;
  };
}

export interface GameMeta {
  version: string;
  name: string;
  date: string;
  requiredDlcs: string[];
}

export interface PlayerState {
  countryId: number;
  name: string;
  resources: Resources;
  resourceIncome: Resources;
  planets: Planet[];
  fleets: Fleet[];
  technologies: TechState;
  leaders: Leader[];
  starbases: Starbase[];
  traditions: string[];
  ascensionPerks: string[];
  edicts: string[];
  policies: Policy[];
  navySize: number;
  navyCap: number;
  empireCohesion: number;
}

export interface Resources {
  [key: string]: number;
  energy: number;
  minerals: number;
  food: number;
  consumer_goods: number;
  alloys: number;
  volatile_motes: number;
  exotic_gases: number;
  rare_crystals: number;
  dark_matter: number;
  living_metal: number;
  zro: number;
  nanites: number;
  minor_artifacts: number;
  influence: number;
  unity: number;
  physics_research: number;
  society_research: number;
  engineering_research: number;
}

export const RESOURCE_KEYS: (keyof Resources & string)[] = [
  "energy",
  "minerals",
  "food",
  "consumer_goods",
  "alloys",
  "volatile_motes",
  "exotic_gases",
  "rare_crystals",
  "dark_matter",
  "living_metal",
  "zro",
  "nanites",
  "minor_artifacts",
  "influence",
  "unity",
  "physics_research",
  "society_research",
  "engineering_research",
];

export interface Planet {
  id: number;
  name: string;
  planetClass: string;
  size: number;
  pops: number;
  buildings: string[];
  districts: Record<string, number>;
  stability: number;
  amenities: number;
  housing: number;
  freeHousing: number;
  crime: number;
  freeJobs: number;
  designation: string;
  modifiers: string[];
}

export interface Fleet {
  id: number;
  name: string;
  ships: number;
  militaryPower: number;
  isMilitary: boolean;
  isCivilian: boolean;
  location: string;
  mia: boolean;
}

export interface TechState {
  physics: TechResearch;
  society: TechResearch;
  engineering: TechResearch;
  completed: string[];
}

export interface TechResearch {
  current: string;
  progress: number;
  output: number;
}

export interface Leader {
  id: number;
  name: string;
  class: string;
  level: number;
  age: number;
  traits: string[];
}

export interface Starbase {
  id: number;
  systemName: string;
  level: string;
  modules: string[];
  buildings: string[];
}

export interface Policy {
  name: string;
  selected: string;
}

export interface Country {
  id: number;
  name: string;
  type: string;
  government: string;
  ethics: string[];
  militaryPower: number;
  techPower: number;
  economyPower: number;
  numPlanets: number;
  numPops: number;
  opinion: number;
  isRival: boolean;
  hasDefensivePact: boolean;
  hasFederation: boolean;
  isAtWar: boolean;
  attitude: string;
}

export interface War {
  name: string;
  attackers: string[];
  defenders: string[];
  warGoal: string;
  startDate: string;
}

/** Log-parsed partial state (from mod output in game.log) */
export interface LogGameState {
  date: string;
  empireName?: string;
  resources?: Partial<Resources>;
  resourceIncome?: Partial<Resources>;
  planets?: Partial<Planet>[];
  fleets?: Partial<Fleet>[];
  diplomacy?: Partial<Country>[];
  researchOutput?: {
    physics: number;
    society: number;
    engineering: number;
  };
  summary?: {
    numPlanets: number;
    numPops: number;
    navyCap: number;
    navySize?: number;
    fleetPower: number;
  };
}
