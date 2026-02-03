import type { Home, Job, NPC, TileType, Village, WorldState } from "./types";

const JOBS: Job[] = ["farmer", "woodcutter", "builder", "guard"];

const TILE_WEIGHTS: Array<{ type: TileType; weight: number }> = [
  { type: "grass", weight: 0.45 },
  { type: "forest", weight: 0.25 },
  { type: "water", weight: 0.2 },
  { type: "mountain", weight: 0.1 }
];

export const createWorld = (size: number, npcCount: number, tickRate: number): WorldState => {
  const tiles = createTiles(size);
  const npcs = createNPCs(size, npcCount);
  return {
    tick: 0,
    size,
    tiles,
    npcs,
    homes: [],
    villages: [],
    events: [],
    paused: false,
    tickRate
  };
};

const createTiles = (size: number): TileType[][] => {
  const tiles: TileType[][] = [];
  for (let y = 0; y < size; y += 1) {
    const row: TileType[] = [];
    for (let x = 0; x < size; x += 1) {
      row.push(weightedTile());
    }
    tiles.push(row);
  }
  return tiles;
};

const weightedTile = (): TileType => {
  const roll = Math.random();
  let cumulative = 0;
  for (const item of TILE_WEIGHTS) {
    cumulative += item.weight;
    if (roll <= cumulative) {
      return item.type;
    }
  }
  return "grass";
};

const createNPCs = (size: number, npcCount: number): NPC[] => {
  const npcs: NPC[] = [];
  for (let i = 0; i < npcCount; i += 1) {
    npcs.push({
      id: crypto.randomUUID(),
      hp: 100,
      hunger: Math.floor(Math.random() * 50),
      position: {
        x: Math.floor(Math.random() * size),
        y: Math.floor(Math.random() * size)
      },
      inventory: { food: 2, wood: 0 },
      job: JOBS[i % JOBS.length],
      alive: true
    });
  }
  return npcs;
};

export const createHome = (ownerId: string, x: number, y: number): Home => ({
  id: crypto.randomUUID(),
  ownerId,
  position: { x, y }
});

export const createVillage = (centerX: number, centerY: number, homeIds: string[]): Village => {
  const name = `Village-${Math.floor(Math.random() * 9999)}`;
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    center: { x: centerX, y: centerY },
    storage: { food: 20, wood: 10 },
    taxRate: 0.05,
    homeIds
  };
};

