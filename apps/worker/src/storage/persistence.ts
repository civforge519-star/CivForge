import type { WorldState } from "../types";

type StorageState = DurableObjectState["storage"];

export const initStorage = (state: DurableObjectState): void => {
  state.storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS world_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)"
  );
  state.storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS world_tiles (seed TEXT PRIMARY KEY, data TEXT NOT NULL)"
  );
  state.storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS world_snapshots (tick INTEGER PRIMARY KEY, data TEXT NOT NULL)"
  );
};

export const loadWorldState = async (state: DurableObjectState): Promise<WorldState | null> => {
  try {
    const stmt = state.storage.sql.prepare("SELECT data FROM world_state WHERE id = 1");
    const row = stmt.first<{ data: string }>();
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
    state.storage.sql.prepare("INSERT OR REPLACE INTO world_state (id, data) VALUES (1, ?)").bind(data).run();
  } catch (error) {
    console.error("saveWorldState error:", error);
    throw error;
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
    state.storage.sql.prepare("INSERT OR REPLACE INTO world_snapshots (tick, data) VALUES (?, ?)").bind(world.tick, snapshot).run();
  } catch (error) {
    console.error("saveSnapshot error:", error);
    throw error;
  }
};

export const loadSnapshot = async (state: DurableObjectState, tick: number): Promise<WorldState["snapshots"][number] | null> => {
  try {
    const stmt = state.storage.sql.prepare("SELECT data FROM world_snapshots WHERE tick = ?");
    const row = stmt.bind(tick).first<{ data: string }>();
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
    const stmt = storage.sql.prepare("SELECT seed FROM world_tiles WHERE seed = ?");
    const row = stmt.bind(seed).first<{ seed: string }>();
    return Boolean(row);
  } catch (error) {
    console.error("hasTiles error:", error);
    return false;
  }
};

const saveTiles = async (storage: StorageState, seed: string, tiles: WorldState["tiles"]): Promise<void> => {
  try {
    storage.sql.prepare("INSERT OR REPLACE INTO world_tiles (seed, data) VALUES (?, ?)").bind(seed, JSON.stringify(tiles)).run();
  } catch (error) {
    console.error("saveTiles error:", error);
    throw error;
  }
};

const loadTiles = async (storage: StorageState, seed: string): Promise<WorldState["tiles"] | null> => {
  try {
    const stmt = storage.sql.prepare("SELECT data FROM world_tiles WHERE seed = ?");
    const row = stmt.bind(seed).first<{ data: string }>();
    if (!row?.data) {
      return null;
    }
    return JSON.parse(row.data) as WorldState["tiles"];
  } catch (error) {
    console.error("loadTiles error:", error);
    return null;
  }
};

