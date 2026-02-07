import type { WorldState, WorldConfig } from "../types";
import { isHugeWorld } from "../world";

// Maximum bytes for SQLite storage (200KB)
const MAX_BYTES = 200 * 1024; // 204800 bytes

/**
 * Calculate JSON size in bytes using TextEncoder
 */
function safeJsonSize(obj: unknown): number {
  try {
    const json = JSON.stringify(obj);
    return new TextEncoder().encode(json).length;
  } catch (error) {
    console.error("safeJsonSize error:", error);
    return 0;
  }
}

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

export const saveWorldState = async (state: DurableObjectState, world: WorldState): Promise<{ ok: boolean; skipped?: boolean; reason?: string; bytes?: number }> => {
  try {
    const huge = isHugeWorld(world.config.size);
    
    // For huge worlds, always persist only minimal metadata
    if (huge) {
      const minimalMetadata = {
        worldId: world.worldId,
        seed: world.config.seed,
        size: world.config.size,
        tick: world.tick,
        updatedAt: Date.now(),
        type: world.type,
        config: {
          seed: world.config.seed,
          size: world.config.size,
          tickRate: world.config.tickRate,
          visionRadius: world.config.visionRadius,
          fogOfWar: world.config.fogOfWar
        }
      };
      const bytes = safeJsonSize(minimalMetadata);
      if (bytes > MAX_BYTES) {
        console.error(`Minimal metadata too large: ${bytes} bytes`);
        return { ok: false, skipped: true, reason: "minimal_metadata_too_large", bytes };
      }
      exec(state.storage.sql, "INSERT OR REPLACE INTO world_state (id, data) VALUES (1, ?)", JSON.stringify(minimalMetadata));
      console.log(`Huge world mode (size=${world.config.size}): persisted minimal metadata only (${bytes} bytes)`);
      return { ok: true, bytes };
    }
    
    // For small worlds, try to save full state (without tiles)
    const stateWithoutTiles = { ...world, tiles: [] };
    const bytes = safeJsonSize(stateWithoutTiles);
    
    if (bytes > MAX_BYTES) {
      // Fallback to minimal metadata for small worlds too if they grow too large
      console.warn(`saveWorldState: payload too large (${bytes} bytes > ${MAX_BYTES}), persisting minimal metadata instead`);
      const minimalMetadata = {
        worldId: world.worldId,
        seed: world.config.seed,
        size: world.config.size,
        tick: world.tick,
        updatedAt: Date.now(),
        type: world.type
      };
      const minimalBytes = safeJsonSize(minimalMetadata);
      exec(state.storage.sql, "INSERT OR REPLACE INTO world_state (id, data) VALUES (1, ?)", JSON.stringify(minimalMetadata));
      return { ok: true, skipped: true, reason: "too_large", bytes, minimalBytes };
    }
    
    // Save full state (without tiles)
    exec(state.storage.sql, "INSERT OR REPLACE INTO world_state (id, data) VALUES (1, ?)", JSON.stringify(stateWithoutTiles));
    return { ok: true, bytes };
  } catch (error) {
    console.error("saveWorldState error:", error);
    // Don't throw - allow world to continue in memory
    return { ok: false, reason: String(error) };
  }
};

export const saveSnapshot = async (state: DurableObjectState, world: WorldState): Promise<{ ok: boolean; skipped?: boolean; bytes?: number }> => {
  try {
    // Store only compact snapshot data, never tiles
    const snapshot = {
      tick: world.tick,
      units: world.units,
      cities: world.cities,
      states: world.states,
      events: world.events
    };
    const bytes = safeJsonSize(snapshot);
    
    if (bytes > MAX_BYTES) {
      console.warn(`saveSnapshot: payload too large (${bytes} bytes > ${MAX_BYTES}), skipping`);
      return { ok: false, skipped: true, bytes };
    }
    
    exec(state.storage.sql, "INSERT OR REPLACE INTO world_snapshots (tick, data) VALUES (?, ?)", world.tick, JSON.stringify(snapshot));
    return { ok: true, bytes };
  } catch (error) {
    console.error("saveSnapshot error:", error);
    // Don't throw - snapshot failures shouldn't crash the world
    return { ok: false, reason: String(error) };
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

