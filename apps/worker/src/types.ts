export type Biome =
  | "ocean"
  | "coast"
  | "plains"
  | "forest"
  | "desert"
  | "tundra"
  | "snow"
  | "mountain"
  | "river";

// Biome ID enum for compact payloads
export enum BiomeId {
  OCEAN = 0,
  COAST = 1,
  PLAINS = 2,
  FOREST = 3,
  DESERT = 4,
  TUNDRA = 5,
  SNOW = 6,
  MOUNTAIN = 7,
  RIVER = 8
}

// Biome string to ID mapping
export const BIOME_TO_ID: Record<Biome, BiomeId> = {
  ocean: BiomeId.OCEAN,
  coast: BiomeId.COAST,
  plains: BiomeId.PLAINS,
  forest: BiomeId.FOREST,
  desert: BiomeId.DESERT,
  tundra: BiomeId.TUNDRA,
  snow: BiomeId.SNOW,
  mountain: BiomeId.MOUNTAIN,
  river: BiomeId.RIVER
};

// Biome ID to string mapping
export const ID_TO_BIOME: Record<BiomeId, Biome> = {
  [BiomeId.OCEAN]: "ocean",
  [BiomeId.COAST]: "coast",
  [BiomeId.PLAINS]: "plains",
  [BiomeId.FOREST]: "forest",
  [BiomeId.DESERT]: "desert",
  [BiomeId.TUNDRA]: "tundra",
  [BiomeId.SNOW]: "snow",
  [BiomeId.MOUNTAIN]: "mountain",
  [BiomeId.RIVER]: "river"
};

export type Position = {
  x: number;
  y: number;
};

export type Inventory = {
  food: number;
  wood: number;
  stone: number;
  iron: number;
  tools: number;
  weapons: number;
  gold: number;
};

export type Role = "citizen" | "tribe" | "state";

export type Job =
  | "farmer"
  | "miner"
  | "woodcutter"
  | "builder"
  | "blacksmith"
  | "trader"
  | "guard"
  | "soldier"
  | "clerk";

export type Tile = {
  x: number;
  y: number;
  elevation: number;
  temperature: number;
  humidity: number;
  biome: Biome;
  river: boolean;
  ownerCityId?: string;
  ownerStateId?: string;
  contested?: boolean;
};

export type Agent = {
  id: string;
  name: string;
  role: Role;
  apiKeyHash: string;
  pullUrl?: string;
  mode: "push" | "pull";
  units: string[];
  reputation: number;
  lastActionTick: number;
  actionQuota: number;
  minuteQuota: number;
  banned: boolean;
  worldId: string;
};

export type Unit = {
  id: string;
  agentId: string;
  role: Role;
  position: Position;
  hp: number;
  stamina: number;
  inventory: Inventory;
  job?: Job;
  cityId?: string;
  stateId?: string;
  alive: boolean;
};

export type City = {
  id: string;
  name: string;
  center: Position;
  population: number;
  storage: Inventory;
  taxRate: number;
  buildings: Record<string, number>;
  buildQueue: Array<{ id: string; type: string; progress: number; required: number }>;
  policies: Record<string, number>;
  security: number;
  housingCapacity: number;
  attraction: number;
  level: "village" | "town" | "city";
  territoryRadius: number;
  stateId?: string;
};

export type State = {
  id: string;
  name: string;
  capitalCityId: string;
  treasury: Inventory;
  policies: Record<string, number>;
  diplomacy: Record<string, string>;
  laws: Record<string, number>;
  relations: Record<string, string>;
};

export type Army = {
  id: string;
  ownerStateId: string;
  units: string[];
  position: Position;
  morale: number;
  supplies: Inventory;
};

export type Market = {
  cityId: string;
  prices: Record<keyof Inventory, number>;
};

export type WorldConfig = {
  seed: string;
  size: number;
  tickRate: number;
  visionRadius: number;
  fogOfWar: boolean;
  towerBonus: number;
  forestPenalty: number;
  mountainBlocks: boolean;
  maxAgents: number;
  maxUnitsPerAgent: number;
  actionsPerTick: number;
  actionsPerMinute: number;
  sandbox: boolean;
  allowRoles: Role[];
};

export type ActionType =
  | "move"
  | "gather"
  | "craft"
  | "build"
  | "trade"
  | "join_city"
  | "found_city"
  | "form_state"
  | "tax_policy_vote"
  | "attack"
  | "defend"
  | "negotiate"
  | "apply_job"
  | "enlist"
  | "vote_policy"
  | "coordinate_alliance"
  | "coordinate_war"
  | "coordinate_trade";

export type Action = {
  id: string;
  type: ActionType;
  agentId: string;
  unitId?: string;
  targetId?: string;
  payload?: Record<string, unknown>;
  createdAt: number;
};

export type AgentObservation = {
  protocolVersion: string;
  worldId: string;
  tick: number;
  unit: Unit;
  nearbyTiles: Tile[];
  nearbyUnits: Unit[];
  city?: City;
  recentEvents: string[];
};

export type DramaEventSeverity = "minor" | "major" | "global";

export type DramaEvent = {
  id: string;
  type: "famine" | "city_collapse" | "war_declared" | "war_ended" | "revolt" | "alliance" | "migration" | "capital_fallen" | "peace_treaty" | "city_captured";
  severity: DramaEventSeverity;
  tick: number;
  timestamp: number;
  location?: Position;
  cityId?: string;
  stateId?: string;
  targetStateId?: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export type AgentStory = {
  agentId: string;
  birthTick: number;
  citiesLived: string[];
  warsJoined: string[];
  migrations: Array<{ from: string; to: string; tick: number }>;
  majorEvents: Array<{ tick: number; event: string }>;
  lastUpdated: number;
};

export type War = {
  id: string;
  stateA: string;
  stateB: string;
  startTick: number;
  endTick?: number;
  frontLines: Position[];
  casualties: number;
  exhaustion: number;
};

export type WorldState = {
  worldId: string;
  tick: number;
  type: "public" | "sandbox";
  config: WorldConfig;
  tiles: Tile[];
  chunkOwnership: Record<string, { cityId?: string; stateId?: string; contested?: boolean }>;
  regions: { id: string; name: string; type: "continent" | "sea"; center: Position }[];
  agents: Record<string, Agent>;
  units: Record<string, Unit>;
  cities: Record<string, City>;
  states: Record<string, State>;
  treaties: Array<{ id: string; stateA: string; stateB: string; status: string; expiresAt: number }>;
  armies: Record<string, Army>;
  markets: Record<string, Market>;
  actionQueues: Record<string, Action[]>;
  fog: Record<string, { exploredChunks: string[]; visibleChunks: string[] }>;
  heatmaps: Record<string, { updatedAt: number; chunks: Record<string, number[]> }>;
  agentLogs: Record<string, { actions: Array<{ action: Action; status: "accepted" | "rejected"; reason?: string }>; lastObservationSize: number }>;
  lastEventsHash: string[];
  events: string[];
  snapshots: Array<{ tick: number; units: Record<string, Unit>; cities: Record<string, City>; states: Record<string, State> }>;
  diagnostics: { lastTickMs: number; avgTickMs: number; lastPayloadBytes: number };
  lastGoodSnapshotTick: number;
  paused: boolean;
  lastTickTime: number;
  // Drama system
  dramaEvents: DramaEvent[];
  agentStories: Record<string, AgentStory>;
  wars: Record<string, War>;
  cityCooldowns: Record<string, number>; // cityId -> last event tick
  coordinationLogs: Array<{ tick: number; agentId: string; type: string; targetId?: string }>; // Internal only, not broadcast
};

