import type { Inventory, Position, WorldConfig, WorldState, Tile } from "./types";
import { generateWorldMap, generateRegions } from "./worldgen";
import { ChunkWorldGenerator, generateWorldTilesFromChunks } from "./chunkgen";

/**
 * Get or generate tiles deterministically from seed
 * Tiles are derived data, do not persist - always generate on demand
 */
export const getOrGenerateTiles = (seed: string, size: number): WorldState["tiles"] => {
  // For small worlds (<=256), use legacy generation for compatibility
  if (size <= 256) {
    return generateWorldMap(seed, size);
  }
  // For larger worlds, use chunk-based generation
  const generator = new ChunkWorldGenerator(seed, 100);
  return generateWorldTilesFromChunks(generator, size);
};

const defaultInventory = (): Inventory => ({
  food: 0,
  wood: 0,
  stone: 0,
  iron: 0,
  tools: 0,
  weapons: 0,
  gold: 0
});

export const createWorld = (
  worldId: string,
  seed: string,
  size: number,
  tickRate: number,
  type: "public" | "sandbox" = "public",
  overrides: Partial<WorldConfig> = {}
): WorldState => {
  const config: WorldConfig = {
    seed,
    size,
    tickRate,
    visionRadius: 6,
    fogOfWar: true,
    towerBonus: 2,
    forestPenalty: 1,
    mountainBlocks: true,
    maxAgents: 200,
    maxUnitsPerAgent: 6,
    actionsPerTick: 2,
    actionsPerMinute: 30,
    sandbox: type === "sandbox",
    allowRoles: ["citizen", "tribe", "state"]
  };
  const mergedConfig = { ...config, ...overrides };

  // Tiles are derived data, generated deterministically from seed
  // Do not store tiles in world state - generate on demand
  const tiles: WorldState["tiles"] = getOrGenerateTiles(mergedConfig.seed, mergedConfig.size);
  
  const regions = generateRegions(tiles, mergedConfig.size);

  return {
    worldId,
    tick: 0,
    type,
    config: mergedConfig,
    tiles,
    chunkOwnership: {},
    regions,
    agents: {},
    units: {},
    cities: {},
    states: {},
    treaties: [],
    armies: {},
    markets: {},
    actionQueues: {},
    fog: {},
    heatmaps: {},
    agentLogs: {},
    lastEventsHash: [],
    events: [],
    snapshots: [],
    diagnostics: { lastTickMs: 0, avgTickMs: 0, lastPayloadBytes: 0 },
    lastGoodSnapshotTick: 0,
    paused: false,
    lastTickTime: Date.now(),
    // Drama system
    dramaEvents: [],
    agentStories: {},
    wars: {},
    cityCooldowns: {},
    coordinationLogs: []
  };
};

export const createInventory = (seeded = false): Inventory => {
  if (seeded) {
    return { food: 5, wood: 5, stone: 0, iron: 0, tools: 0, weapons: 0, gold: 10 };
  }
  return defaultInventory();
};

export const clampPosition = (pos: Position, size: number): Position => ({
  x: Math.max(0, Math.min(size - 1, pos.x)),
  y: Math.max(0, Math.min(size - 1, pos.y))
});






