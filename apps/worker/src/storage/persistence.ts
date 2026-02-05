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
    exec(state.storage.sql, "CREATE TABLE IF NOT EXISTS world_tiles (seed TEXT PRIMARY KEY, data TEXT NOT NULL)");
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
    if (!parsed.tiles || parsed.tiles.length === 0) {
      const tiles = await loadTiles(state.storage, parsed.config.seed);
      if (tiles) {
        parsed.tiles = tiles;
      }
    }
    return parsed;
  } catch (error) {
    console.error("loadWorldState error:", error);
    return null;
  }
};

export const saveWorldState = async (state: DurableObjectState, world: WorldState): Promise<void> => {
  try {
    if (!(await hasTiles(state.storage, world.config.seed))) {
      await saveTiles(state.storage, world.config.seed, world.tiles);
    }
    const data = JSON.stringify({ ...world, tiles: [] });
    exec(state.storage.sql, "INSERT OR REPLACE INTO world_state (id, data) VALUES (1, ?)", data);
  } catch (error) {
    console.error("saveWorldState error:", error);
    // Don't throw - allow world to continue in memory
  }
};

export const saveSnapshot = async (state: DurableObjectState, world: WorldState): Promise<void> => {
  try {
    const snapshot = JSON.stringify({
      tick: world.tick,
      units: world.units,
      cities: world.cities,
      states: world.states,
      events: world.events
    });
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

const hasTiles = async (storage: StorageState, seed: string): Promise<boolean> => {
  try {
    const row = one<{ seed: string }>(storage.sql, "SELECT seed FROM world_tiles WHERE seed = ?", seed);
    return Boolean(row);
  } catch (error) {
    console.error("hasTiles error:", error);
    return false;
  }
};

export const saveTiles = async (storage: StorageState, seed: string, tiles: WorldState["tiles"]): Promise<void> => {
  try {
    if (!tiles || tiles.length === 0) {
      console.warn("saveTiles: Attempted to save empty tiles array");
      return;
    }
    exec(storage.sql, "INSERT OR REPLACE INTO world_tiles (seed, data) VALUES (?, ?)", seed, JSON.stringify(tiles));
  } catch (error) {
    console.error("saveTiles error:", error);
    // Don't throw - tile save failures shouldn't crash
  }
};

export const loadTiles = async (storage: StorageState, seed: string): Promise<WorldState["tiles"] | null> => {
  try {
    const row = one<{ data: string }>(storage.sql, "SELECT data FROM world_tiles WHERE seed = ?", seed);
    if (!row?.data) {
      return null;
    }
    const parsed = JSON.parse(row.data) as WorldState["tiles"];
    if (!parsed || parsed.length === 0) {
      return null;
    }
    return parsed;
  } catch (error) {
    console.error("loadTiles error:", error);
    return null;
  }
};

