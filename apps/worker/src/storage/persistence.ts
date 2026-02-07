import type { WorldState } from "../types";

type StorageState = DurableObjectState["storage"];
type SqlStorage = DurableObjectState["storage"]["sql"];

// Helper functions for SQL operations
function exec(sql: SqlStorage, query: string, ...args: any[]): void {
  sql.exec(query, ...args);
}

function one<T = any>(sql: SqlStorage, query: string, ...args: any[]): T | null {
  const arr = sql.exec(query, ...args).toArray() as T[];
  return arr.length ? arr[0] : null;
}

function all<T = any>(sql: SqlStorage, query: string, ...args: any[]): T[] {
  return sql.exec(query, ...args).toArray() as T[];
}

export const initStorage = (state: DurableObjectState): void => {
  try {
    exec(state.storage.sql, "CREATE TABLE IF NOT EXISTS world_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
    // Tiles are derived data, do not persist - removed world_tiles table
    exec(state.storage.sql, "CREATE TABLE IF NOT EXISTS world_snapshots (tick INTEGER PRIMARY KEY, data TEXT NOT NULL)");
  } catch (error) {
    console.error("initStorage error:", error);
    // Don't throw - allow in-memory world to continue
  }
};

export const loadWorldState = async (state: DurableObjectState): Promise<WorldState | null> => {
  try {
    const row = one<{ data: string }>(state.storage.sql, "SELECT data FROM world_state WHERE id = 1");
    if (!row?.data) {
      return null;
    }
    const parsed = JSON.parse(row.data) as WorldState;
    // Tiles are derived data, do not load from storage - will be generated on demand
    // Remove tiles from loaded state to force regeneration
    parsed.tiles = [];
    return parsed;
  } catch (error) {
    console.error("loadWorldState error:", error);
    return null;
  }
};

// Guardrail: reject payloads >200KB
const MAX_PAYLOAD_SIZE = 200 * 1024; // 200KB

const checkPayloadSize = (data: string, operation: string): void => {
  const size = new Blob([data]).size;
  if (size > MAX_PAYLOAD_SIZE) {
    console.error(`Payload too large for ${operation}: ${size} bytes (max ${MAX_PAYLOAD_SIZE})`);
    throw new Error(`Payload too large: ${size} bytes exceeds ${MAX_PAYLOAD_SIZE} bytes`);
  }
  if (size > 100 * 1024) {
    console.warn(`Large payload for ${operation}: ${size} bytes`);
  }
};

export const saveWorldState = async (state: DurableObjectState, world: WorldState): Promise<void> => {
  try {
    // Tiles are derived data, do not persist - always exclude from save
    const data = JSON.stringify({ ...world, tiles: [] });
    checkPayloadSize(data, "saveWorldState");
    exec(state.storage.sql, "INSERT OR REPLACE INTO world_state (id, data) VALUES (1, ?)", data);
  } catch (error) {
    console.error("saveWorldState error:", error);
    // Don't throw - allow world to continue in memory
  }
};

export const saveSnapshot = async (state: DurableObjectState, world: WorldState): Promise<void> => {
  try {
    // Store only compact snapshot data, never tiles
    const snapshot = JSON.stringify({
      tick: world.tick,
      units: world.units,
      cities: world.cities,
      states: world.states,
      events: world.events
    });
    checkPayloadSize(snapshot, "saveSnapshot");
    exec(state.storage.sql, "INSERT OR REPLACE INTO world_snapshots (tick, data) VALUES (?, ?)", world.tick, snapshot);
  } catch (error) {
    console.error("saveSnapshot error:", error);
    // Don't throw - snapshot failures shouldn't crash the world
  }
};

export const loadSnapshot = async (state: DurableObjectState, tick: number): Promise<WorldState["snapshots"][number] | null> => {
  try {
    const row = one<{ data: string }>(state.storage.sql, "SELECT data FROM world_snapshots WHERE tick = ?", tick);
    if (!row?.data) {
      return null;
    }
    return JSON.parse(row.data) as WorldState["snapshots"][number];
  } catch (error) {
    console.error("loadSnapshot error:", error);
    return null;
  }
};

// Tiles are derived data, do not persist
// Removed saveTiles, loadTiles, hasTiles - tiles are generated deterministically from seed

