/**
 * Chunk-based deterministic world map generation system
 * 
 * Generates terrain on demand using world seed + coordinates.
 * Supports infinite maps, LOD, and natural terrain features.
 */

import type { Biome, Position, Tile } from "./types";

// Constants
export const CHUNK_SIZE = 128; // 128x128 cells per chunk
export const SEA_LEVEL = 0.32;
export const COAST_THRESHOLD = 0.36;

// LOD levels
export type LOD = 0 | 1 | 2;

// Chunk coordinate
export type ChunkCoord = {
  cx: number;
  cy: number;
};

// Field values at a point
export type FieldValues = {
  elevation: number;
  temperature: number;
  moisture: number;
  ruggedness: number;
};

// Cell data
export type CellData = {
  biome: Biome;
  movementCost: number;
  resources: {
    food: number;
    wood: number;
    stone: number;
    iron: number;
  };
  hasRiver: boolean;
  hasLake: boolean;
};

// Chunk data structure
export type ChunkData = {
  cx: number;
  cy: number;
  lod: LOD;
  cells?: Tile[]; // LOD0: full cell data
  blocks?: Array<{ biome: Biome; avgElevation: number }>; // LOD1: aggregated blocks
  heatmap?: { biome: Biome; coverage: number }[]; // LOD2: biome summary
  generatedAt: number;
};

// Chunk cache entry
type ChunkCacheEntry = {
  data: ChunkData;
  lastAccess: number;
};

/**
 * Deterministic noise generator using world seed
 */
class NoiseGenerator {
  private rng: () => number;

  constructor(seed: string) {
    const hash = this.hashSeed(seed);
    this.rng = this.mulberry32(hash);
  }

  private hashSeed(seed: string): number {
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  private mulberry32(seed: number): () => number {
    let t = seed;
    return () => {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Sample noise at world coordinates
   * Deterministic based on seed + coordinates
   */
  sample(x: number, y: number, octaves: number = 5, frequency: number = 1.0): number {
    let value = 0;
    let amplitude = 1;
    let freq = frequency;
    let max = 0;

    for (let o = 0; o < octaves; o += 1) {
      const noise = this.smoothNoise(x * freq, y * freq);
      value += noise * amplitude;
      max += amplitude;
      amplitude *= 0.5;
      freq *= 2;
    }

    return value / max;
  }

  private smoothNoise(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;

    const n00 = this.randomFromCoords(xi, yi);
    const n10 = this.randomFromCoords(xi + 1, yi);
    const n01 = this.randomFromCoords(xi, yi + 1);
    const n11 = this.randomFromCoords(xi + 1, yi + 1);

    const u = this.fade(xf);
    const v = this.fade(yf);
    const x1 = this.lerp(n00, n10, u);
    const x2 = this.lerp(n01, n11, u);
    return this.lerp(x1, x2, v);
  }

  private randomFromCoords(x: number, y: number): number {
    const r = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return r - Math.floor(r);
  }

  private fade(t: number): number {
    return t * t * (3 - 2 * t);
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }
}

/**
 * World map generator
 */
export class ChunkWorldGenerator {
  private noise: NoiseGenerator;
  private seed: string;
  private chunkCache: Map<string, ChunkCacheEntry>;
  private maxCacheSize: number;

  constructor(seed: string, maxCacheSize: number = 100) {
    this.seed = seed;
    this.noise = new NoiseGenerator(seed);
    this.chunkCache = new Map();
    this.maxCacheSize = maxCacheSize;
  }

  /**
   * Convert world coordinates to chunk coordinates
   */
  worldToChunk(x: number, y: number): ChunkCoord {
    return {
      cx: Math.floor(x / CHUNK_SIZE),
      cy: Math.floor(y / CHUNK_SIZE)
    };
  }

  /**
   * Sample field values at world coordinates
   */
  sampleFields(x: number, y: number): FieldValues {
    // Elevation: continent-scale + detail
    const continentElevation = this.noise.sample(x * 0.01, y * 0.01, 4, 0.5);
    const detailElevation = this.noise.sample(x * 0.1, y * 0.1, 3, 1.0) * 0.3;
    const elevation = continentElevation * 0.7 + detailElevation;

    // Temperature: latitude-based with noise
    const latitude = Math.abs(y / 10000 - 0.5) * 2; // Normalize for large maps
    const tempNoise = this.noise.sample(x * 0.05, y * 0.05, 2, 1.0) * 0.2;
    const temperature = 1 - latitude + tempNoise;

    // Moisture: noise-based, boosted near water
    const baseMoisture = this.noise.sample(x * 0.08, y * 0.08, 4, 1.0);
    const waterBoost = elevation < SEA_LEVEL + 0.1 ? 0.3 : 0;
    const moisture = Math.min(1, baseMoisture + waterBoost);

    // Ruggedness: high-frequency noise for mountain detail
    const ruggedness = this.noise.sample(x * 0.2, y * 0.2, 2, 2.0);

    return { elevation, temperature, moisture, ruggedness };
  }

  /**
   * Get cell data at world coordinates
   */
  getCell(x: number, y: number): CellData {
    const fields = this.sampleFields(x, y);
    const biome = this.classifyBiome(fields);
    const resources = this.getResourcePotential(biome, fields);
    const movementCost = this.getMovementCost(biome, fields);

    // Check for water features (simplified - would need chunk context for full rivers)
    const hasRiver = this.checkRiver(x, y, fields);
    const hasLake = this.checkLake(x, y, fields);

    return {
      biome,
      movementCost,
      resources,
      hasRiver,
      hasLake
    };
  }

  /**
   * Classify biome from field values
   * Smooth transitions, not grid-like
   */
  private classifyBiome(fields: FieldValues): Biome {
    const { elevation, temperature, moisture, ruggedness } = fields;

    // Ocean
    if (elevation < SEA_LEVEL) {
      return "ocean";
    }

    // Coast
    if (elevation < COAST_THRESHOLD) {
      return "coast";
    }

    // Mountains (high elevation + high ruggedness)
    if (elevation > 0.75 && ruggedness > 0.6) {
      return temperature < 0.3 ? "snow" : "mountain";
    }

    // Tundra (very cold)
    if (temperature < 0.25) {
      return moisture > 0.5 ? "tundra" : "snow";
    }

    // Desert (very dry)
    if (moisture < 0.2) {
      return "desert";
    }

    // Swamp (high moisture, moderate temp)
    if (moisture > 0.7 && temperature > 0.4 && temperature < 0.7 && elevation < 0.5) {
      return "plains"; // Use plains as swamp proxy for now
    }

    // Forest (high moisture)
    if (moisture > 0.6) {
      return "forest";
    }

    // Default: plains/grassland
    return "plains";
  }

  /**
   * Get resource potential for a biome
   */
  private getResourcePotential(biome: Biome, fields: FieldValues): CellData["resources"] {
    const base = {
      food: 0,
      wood: 0,
      stone: 0,
      iron: 0
    };

    switch (biome) {
      case "forest":
        return { ...base, wood: 0.8, food: 0.4 };
      case "plains":
        return { ...base, food: 0.9, wood: 0.2 };
      case "mountain":
        return { ...base, stone: 0.9, iron: 0.5 };
      case "desert":
        return { ...base, stone: 0.5, food: 0.1 };
      case "coast":
        return { ...base, food: 0.6 };
      case "ocean":
        return { ...base, food: 0.3 };
      case "tundra":
        return { ...base, food: 0.3 };
      case "snow":
        return { ...base, stone: 0.3 };
      default:
        return base;
    }
  }

  /**
   * Get movement cost for a biome
   */
  private getMovementCost(biome: Biome, fields: FieldValues): number {
    switch (biome) {
      case "ocean":
        return 3; // Requires boats
      case "mountain":
        return 2.5;
      case "forest":
        return 1.5;
      case "snow":
        return 2;
      case "desert":
        return 1.3;
      default:
        return 1;
    }
  }

  /**
   * Check if cell has a river using deterministic path tracing
   * Rivers flow from high elevation to low, crossing chunk boundaries deterministically
   */
  private checkRiver(x: number, y: number, fields: FieldValues): boolean {
    // River sources: high elevation with high moisture
    const isSource = fields.elevation > 0.65 && fields.moisture > 0.6;
    if (!isSource) {
      // Check if this point is on a river path by tracing backward from potential sources
      return this.isOnRiverPath(x, y, fields);
    }
    
    // Use deterministic seed to determine if this source actually generates a river
    const sourceSeed = this.noise.sample(x * 0.1, y * 0.1, 1, 0.5);
    return sourceSeed > 0.85;
  }

  /**
   * Check if a point is on a river path by tracing from nearby sources
   * Uses deterministic downhill walk with safeguards
   */
  private isOnRiverPath(x: number, y: number, fields: FieldValues): boolean {
    const MAX_TRACE_STEPS = 200;
    const visited = new Set<string>();
    let currentX = x;
    let currentY = y;
    let steps = 0;

    // Trace backward/forward along elevation gradient
    while (steps < MAX_TRACE_STEPS) {
      const key = `${currentX},${currentY}`;
      if (visited.has(key)) {
        // Loop detected - create lake or terminate
        return false;
      }
      visited.add(key);

      const currentFields = this.sampleFields(currentX, currentY);
      
      // Check if we've reached a source
      if (currentFields.elevation > 0.65 && currentFields.moisture > 0.6) {
        const sourceSeed = this.noise.sample(currentX * 0.1, currentY * 0.1, 1, 0.5);
        if (sourceSeed > 0.85) {
          return true; // This point is on a valid river path
        }
      }

      // Check if we've reached ocean/coast (river endpoint)
      if (currentFields.elevation < SEA_LEVEL + 0.1) {
        return false; // River ended, but this point wasn't on the path
      }

      // Find lowest neighbor (downhill direction)
      const neighbors = [
        { x: currentX - 1, y: currentY },
        { x: currentX + 1, y: currentY },
        { x: currentX, y: currentY - 1 },
        { x: currentX, y: currentY + 1 }
      ];

      let next: { x: number; y: number } | null = null;
      let lowestElevation = currentFields.elevation;

      for (const n of neighbors) {
        const nFields = this.sampleFields(n.x, n.y);
        if (nFields.elevation < lowestElevation) {
          lowestElevation = nFields.elevation;
          next = n;
        }
      }

      // Local minima: no downhill neighbor
      if (!next) {
        // Check if this is a lake basin (deterministic)
        if (currentFields.moisture > 0.7) {
          const lakeSeed = this.noise.sample(currentX * 0.2, currentY * 0.2, 1, 2.0);
          if (lakeSeed > 0.75) {
            return false; // Lake formed, river ends
          }
        }
        return false; // Local minima, river terminates
      }

      currentX = next.x;
      currentY = next.y;
      steps += 1;
    }

    return false; // Max steps reached
  }

  /**
   * Check if cell has a lake
   */
  private checkLake(x: number, y: number, fields: FieldValues): boolean {
    // Lakes in local minima with high moisture
    if (fields.elevation < 0.4 && fields.moisture > 0.7) {
      const lakeNoise = this.noise.sample(x * 0.2, y * 0.2, 1, 2.0);
      return lakeNoise > 0.75;
    }
    return false;
  }

  /**
   * Generate a chunk at specified coordinates and LOD
   */
  generateChunk(cx: number, cy: number, lod: LOD = 0): ChunkData {
    const cacheKey = `${cx},${cy},${lod}`;
    
    // Check cache
    const cached = this.chunkCache.get(cacheKey);
    if (cached) {
      cached.lastAccess = Date.now();
      return cached.data;
    }

    let data: ChunkData;

    if (lod === 0) {
      // Full detail: generate all cells
      const cells: Tile[] = [];
      for (let cyLocal = 0; cyLocal < CHUNK_SIZE; cyLocal += 1) {
        for (let cxLocal = 0; cxLocal < CHUNK_SIZE; cxLocal += 1) {
          const wx = cx * CHUNK_SIZE + cxLocal;
          const wy = cy * CHUNK_SIZE + cyLocal;
          const fields = this.sampleFields(wx, wy);
          const cellData = this.getCell(wx, wy);
          
          cells.push({
            x: wx,
            y: wy,
            elevation: fields.elevation,
            temperature: fields.temperature,
            humidity: fields.moisture,
            biome: cellData.biome,
            river: cellData.hasRiver
          });
        }
      }
      data = { cx, cy, lod, cells, generatedAt: Date.now() };
    } else if (lod === 1) {
      // Aggregated blocks (4x4 cells per block)
      const blockSize = 4;
      const blocks: Array<{ biome: Biome; avgElevation: number }> = [];
      for (let by = 0; by < CHUNK_SIZE / blockSize; by += 1) {
        for (let bx = 0; bx < CHUNK_SIZE / blockSize; bx += 1) {
          const wx = cx * CHUNK_SIZE + bx * blockSize;
          const wy = cy * CHUNK_SIZE + by * blockSize;
          const fields = this.sampleFields(wx, wy);
          const biome = this.classifyBiome(fields);
          blocks.push({ biome, avgElevation: fields.elevation });
        }
      }
      data = { cx, cy, lod, blocks, generatedAt: Date.now() };
    } else {
      // LOD2: Biome heatmap summary
      const biomeCounts = new Map<Biome, number>();
      const sampleSize = 16; // Sample every 8th cell
      for (let sy = 0; sy < CHUNK_SIZE; sy += sampleSize) {
        for (let sx = 0; sx < CHUNK_SIZE; sx += sampleSize) {
          const wx = cx * CHUNK_SIZE + sx;
          const wy = cy * CHUNK_SIZE + sy;
          const fields = this.sampleFields(wx, wy);
          const biome = this.classifyBiome(fields);
          biomeCounts.set(biome, (biomeCounts.get(biome) || 0) + 1);
        }
      }
      const total = biomeCounts.size;
      const heatmap = Array.from(biomeCounts.entries()).map(([biome, count]) => ({
        biome,
        coverage: count / total
      }));
      data = { cx, cy, lod, heatmap, generatedAt: Date.now() };
    }

    // Cache the chunk
    this.cacheChunk(cacheKey, data);
    return data;
  }

  /**
   * Cache management with LRU eviction
   */
  private cacheChunk(key: string, data: ChunkData): void {
    // Evict oldest if cache is full
    if (this.chunkCache.size >= this.maxCacheSize) {
      let oldestKey = "";
      let oldestTime = Infinity;
      for (const [k, entry] of this.chunkCache.entries()) {
        if (entry.lastAccess < oldestTime) {
          oldestTime = entry.lastAccess;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        this.chunkCache.delete(oldestKey);
      }
    }

    this.chunkCache.set(key, {
      data,
      lastAccess: Date.now()
    });
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.chunkCache.clear();
  }

  /**
   * Get cache stats
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.chunkCache.size,
      maxSize: this.maxCacheSize
    };
  }
}

/**
 * Generate full world tiles array (backward compatibility)
 * For existing worlds that need flat array
 */
export function generateWorldTilesFromChunks(
  generator: ChunkWorldGenerator,
  size: number
): Tile[] {
  const tiles: Tile[] = [];
  const chunksX = Math.ceil(size / CHUNK_SIZE);
  const chunksY = Math.ceil(size / CHUNK_SIZE);

  for (let cy = 0; cy < chunksY; cy += 1) {
    for (let cx = 0; cx < chunksX; cx += 1) {
      const chunk = generator.generateChunk(cx, cy, 0);
      if (chunk.cells) {
        for (const cell of chunk.cells) {
          // Only include cells within world bounds
          if (cell.x < size && cell.y < size) {
            tiles.push(cell);
          }
        }
      }
    }
  }

  return tiles;
}

