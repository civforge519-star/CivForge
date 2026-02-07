/**
 * Terrain overlay system for simulation changes
 * 
 * Stores modifications to base terrain (roads, buildings, resource depletion, etc.)
 * Separate from base generation to maintain determinism.
 */

import type { Biome } from "./types";
import { BiomeId, BIOME_TO_ID } from "./types";

/**
 * Overlay delta for a single cell
 * All fields are optional - only specified changes are applied
 */
export type OverlayCellDelta = {
  biomeOverride?: Biome;
  movementCostAdjustment?: number; // Multiplier (e.g., 0.5 for roads)
  resourceDepletion?: {
    food?: number; // Multiplier (0-1)
    wood?: number;
    stone?: number;
    iron?: number;
  };
  structures?: {
    road?: boolean;
    building?: boolean;
    farm?: boolean;
    mine?: boolean;
  };
};

/**
 * In-memory overlay store
 * Maps world coordinates to cell deltas
 */
export class OverlayStore {
  private deltas: Map<string, OverlayCellDelta> = new Map();

  /**
   * Get delta for a cell
   */
  getDelta(x: number, y: number): OverlayCellDelta | null {
    const key = `${x},${y}`;
    return this.deltas.get(key) || null;
  }

  /**
   * Set delta for a cell
   */
  setDelta(x: number, y: number, delta: OverlayCellDelta): void {
    const key = `${x},${y}`;
    if (Object.keys(delta).length === 0) {
      // Remove if empty
      this.deltas.delete(key);
    } else {
      this.deltas.set(key, delta);
    }
  }

  /**
   * Get all deltas in a chunk
   * Returns a Map keyed by "x,y" for efficient lookup
   */
  getDeltasInChunk(cx: number, cy: number, chunkSize: number = 128): Map<string, OverlayCellDelta> {
    const result = new Map<string, OverlayCellDelta>();
    const minX = cx * chunkSize;
    const maxX = (cx + 1) * chunkSize - 1;
    const minY = cy * chunkSize;
    const maxY = (cy + 1) * chunkSize - 1;

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const key = `${x},${y}`;
        const delta = this.deltas.get(key);
        if (delta) {
          result.set(key, delta);
        }
      }
    }

    return result;
  }

  /**
   * Clear all deltas
   */
  clear(): void {
    this.deltas.clear();
  }

  /**
   * Get count of stored deltas
   */
  size(): number {
    return this.deltas.size;
  }
}

/**
 * Apply overlay delta to base cell data
 */
export function applyOverlay(
  base: {
    biome: Biome;
    movementCost: number;
    resources: { food: number; wood: number; stone: number; iron: number };
  },
  delta: OverlayCellDelta | null
): {
  biome: Biome;
  movementCost: number;
  resources: { food: number; wood: number; stone: number; iron: number };
} {
  if (!delta) {
    return base;
  }

  const result = { ...base };

  // Biome override
  if (delta.biomeOverride) {
    result.biome = delta.biomeOverride;
  }

  // Movement cost adjustment
  if (delta.movementCostAdjustment !== undefined) {
    result.movementCost *= delta.movementCostAdjustment;
  }

  // Resource depletion
  if (delta.resourceDepletion) {
    if (delta.resourceDepletion.food !== undefined) {
      result.resources.food *= delta.resourceDepletion.food;
    }
    if (delta.resourceDepletion.wood !== undefined) {
      result.resources.wood *= delta.resourceDepletion.wood;
    }
    if (delta.resourceDepletion.stone !== undefined) {
      result.resources.stone *= delta.resourceDepletion.stone;
    }
    if (delta.resourceDepletion.iron !== undefined) {
      result.resources.iron *= delta.resourceDepletion.iron;
    }
  }

  return result;
}
