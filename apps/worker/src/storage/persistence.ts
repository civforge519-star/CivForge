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
  const result = state.storage.sql.exec("SELECT data FROM world_state WHERE id = 1");
  const row = (result as { rows?: Array<{ data: string }> }).rows?.[0];
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
};

export const saveWorldState = async (state: DurableObjectState, world: WorldState): Promise<void> => {
  if (!(await hasTiles(state.storage, world.config.seed))) {
    await saveTiles(state.storage, world.config.seed, world.tiles);
  }
  const data = JSON.stringify({ ...world, tiles: [] });
  state.storage.sql.exec("INSERT OR REPLACE INTO world_state (id, data) VALUES (1, ?)", data);
};

export const saveSnapshot = async (state: DurableObjectState, world: WorldState): Promise<void> => {
  const snapshot = JSON.stringify({
    tick: world.tick,
    units: world.units,
    cities: world.cities,
    states: world.states,
    events: world.events
  });
  state.storage.sql.exec("INSERT OR REPLACE INTO world_snapshots (tick, data) VALUES (?, ?)", [
    world.tick,
    snapshot
  ]);
};

export const loadSnapshot = async (state: DurableObjectState, tick: number): Promise<WorldState["snapshots"][number] | null> => {
  const result = state.storage.sql.exec("SELECT data FROM world_snapshots WHERE tick = ?", [tick]);
  const row = (result as { rows?: Array<{ data: string }> }).rows?.[0];
  if (!row?.data) {
    return null;
  }
  return JSON.parse(row.data) as WorldState["snapshots"][number];
};

const hasTiles = async (storage: StorageState, seed: string): Promise<boolean> => {
  const result = storage.sql.exec("SELECT seed FROM world_tiles WHERE seed = ?", [seed]);
  return Boolean((result as { rows?: Array<{ seed: string }> }).rows?.[0]);
};

const saveTiles = async (storage: StorageState, seed: string, tiles: WorldState["tiles"]): Promise<void> => {
  storage.sql.exec("INSERT OR REPLACE INTO world_tiles (seed, data) VALUES (?, ?)", [
    seed,
    JSON.stringify(tiles)
  ]);
};

const loadTiles = async (storage: StorageState, seed: string): Promise<WorldState["tiles"] | null> => {
  const result = storage.sql.exec("SELECT data FROM world_tiles WHERE seed = ?", [seed]);
  const row = (result as { rows?: Array<{ data: string }> }).rows?.[0];
  if (!row?.data) {
    return null;
  }
  return JSON.parse(row.data) as WorldState["tiles"];
};

