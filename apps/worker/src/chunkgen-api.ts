/**
 * Public API for chunk-based world generation
 * 
 * Provides clean interface for accessing world terrain data
 */

import { ChunkWorldGenerator, CHUNK_SIZE, type ChunkCoord, type ChunkData, type FieldValues, type CellData, type LOD } from "./chunkgen";
import type { OverlayStore } from "./chunkgen-overlay";
import { applyOverlay } from "./chunkgen-overlay";

// Global generator instance per world seed
const generators = new Map<string, ChunkWorldGenerator>();

/**
 * Get or create generator for a world seed
 */
function getGenerator(seed: string): ChunkWorldGenerator {
  if (!generators.has(seed)) {
    generators.set(seed, new ChunkWorldGenerator(seed, 100));
  }
  return generators.get(seed)!;
}

/**
 * Sample field values at world coordinates
 * @param seed World seed
 * @param x World X coordinate
 * @param y World Y coordinate
 * @returns Field values (elevation, temperature, moisture, ruggedness)
 */
export function sampleFields(seed: string, x: number, y: number): FieldValues {
  const gen = getGenerator(seed);
  return gen.sampleFields(x, y);
}

/**
 * Get cell data at world coordinates
 * @param seed World seed
 * @param x World X coordinate
 * @param y World Y coordinate
 * @returns Cell data (biome, movement cost, resources, water features)
 */
export function getCell(seed: string, x: number, y: number): CellData {
  const gen = getGenerator(seed);
  return gen.getCell(x, y);
}

/**
 * Convert world coordinates to chunk coordinates
 * @param x World X coordinate
 * @param y World Y coordinate
 * @returns Chunk coordinates
 */
export function worldToChunk(x: number, y: number): ChunkCoord {
  return {
    cx: Math.floor(x / CHUNK_SIZE),
    cy: Math.floor(y / CHUNK_SIZE)
  };
}

/**
 * Generate a chunk at specified coordinates and LOD
 * @param seed World seed
 * @param cx Chunk X coordinate
 * @param cy Chunk Y coordinate
 * @param lod Level of detail (0=full, 1=blocks, 2=heatmap)
 * @returns Chunk data
 */
export function generateChunk(seed: string, cx: number, cy: number, lod: LOD = 0): ChunkData {
  const gen = getGenerator(seed);
  return gen.generateChunk(cx, cy, lod);
}

/**
 * Generate tiles for a viewport (for rendering)
 * @param seed World seed
 * @param minX Minimum world X
 * @param minY Minimum world Y
 * @param maxX Maximum world X
 * @param maxY Maximum world Y
 * @returns Array of tiles in viewport
 */
export function generateViewportTiles(
  seed: string,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): Array<{ x: number; y: number; biome: string; elevation: number }> {
  const gen = getGenerator(seed);
  const tiles: Array<{ x: number; y: number; biome: string; elevation: number }> = [];
  
  const startChunk = worldToChunk(minX, minY);
  const endChunk = worldToChunk(maxX, maxY);
  
  // Generate chunks covering viewport
  for (let cy = startChunk.cy; cy <= endChunk.cy; cy += 1) {
    for (let cx = startChunk.cx; cx <= endChunk.cx; cx += 1) {
      const chunk = gen.generateChunk(cx, cy, 0);
      if (chunk.cells) {
        for (const cell of chunk.cells) {
          if (cell.x >= minX && cell.x <= maxX && cell.y >= minY && cell.y <= maxY) {
            tiles.push({
              x: cell.x,
              y: cell.y,
              biome: cell.biome,
              elevation: cell.elevation
            });
          }
        }
      }
    }
  }
  
  return tiles;
}

/**
 * Clear generator cache for a seed
 * @param seed World seed
 */
export function clearCache(seed: string): void {
  const gen = generators.get(seed);
  if (gen) {
    gen.clearCache();
  }
}

/**
 * Get cache statistics
 * @param seed World seed
 * @returns Cache stats
 */
export function getCacheStats(seed: string): { size: number; maxSize: number } {
  const gen = generators.get(seed);
  if (!gen) {
    return { size: 0, maxSize: 0 };
  }
  return gen.getCacheStats();
}

/**
 * Get cell data with overlay applied
 * @param seed World seed
 * @param x World X coordinate
 * @param y World Y coordinate
 * @param overlayStore Overlay store (optional)
 * @returns Cell data with overlay modifications
 */
export function getCellWithOverlay(
  seed: string,
  x: number,
  y: number,
  overlayStore?: OverlayStore
): CellData {
  const base = getCell(seed, x, y);
  if (!overlayStore) {
    return base;
  }
  const delta = overlayStore.getDelta(x, y);
  return applyOverlay(base, delta);
}

/**
 * Generate chunk with overlay applied
 * @param seed World seed
 * @param cx Chunk X coordinate
 * @param cy Chunk Y coordinate
 * @param lod Level of detail
 * @param overlayStore Overlay store (optional)
 * @returns Chunk data with overlay modifications
 */
export function generateChunkWithOverlay(
  seed: string,
  cx: number,
  cy: number,
  lod: LOD = 0,
  overlayStore?: OverlayStore
): ChunkData {
  const baseChunk = generateChunk(seed, cx, cy, lod);
  
  if (!overlayStore || lod !== 0) {
    // Overlay only applies to LOD0 (full cell data)
    return baseChunk;
  }

  if (!baseChunk.cells) {
    return baseChunk;
  }

  // Get all deltas for this chunk
  const deltas = overlayStore.getDeltasInChunk(cx, cy);
  
  // Apply overlays to cells
  const modifiedCells = baseChunk.cells.map(cell => {
    const key = `${cell.x},${cell.y}`;
    const delta = deltas.get(key);
    if (!delta) {
      return cell;
    }

    // Apply biome override if present
    if (delta.biomeOverride) {
      return { ...cell, biome: delta.biomeOverride };
    }

    return cell;
  });

  return {
    ...baseChunk,
    cells: modifiedCells
  };
}

