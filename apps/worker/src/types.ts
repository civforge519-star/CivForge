export type TileType = "grass" | "forest" | "water" | "mountain";

export type Position = {
  x: number;
  y: number;
};

export type Inventory = {
  food: number;
  wood: number;
};

export type Job = "farmer" | "woodcutter" | "builder" | "guard";

export type NPC = {
  id: string;
  hp: number;
  hunger: number;
  position: Position;
  inventory: Inventory;
  job: Job;
  homeId?: string;
  villageId?: string;
  alive: boolean;
  respawnTick?: number;
};

export type Home = {
  id: string;
  ownerId: string;
  position: Position;
  villageId?: string;
};

export type Village = {
  id: string;
  name: string;
  createdAt: string;
  center: Position;
  storage: Inventory;
  taxRate: number;
  homeIds: string[];
};

export type WorldState = {
  tick: number;
  size: number;
  tiles: TileType[][];
  npcs: NPC[];
  homes: Home[];
  villages: Village[];
  events: string[];
  paused: boolean;
  tickRate: number;
};

