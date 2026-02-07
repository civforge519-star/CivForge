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
   * Uses layered noise for natural terrain with one large landmass + islands
   */
  sampleFields(x: number, y: number): FieldValues {
    const size = 128; // World size (normalize coordinates)
    const nx = x / size;
    const ny = y / size;
    
    // Create one large central landmass using radial falloff
    const centerX = 0.5;
    const centerY = 0.5;
    const distFromCenter = Math.sqrt((nx - centerX) ** 2 + (ny - centerY) ** 2);
    const landmassShape = 1 - (distFromCenter * 1.8); // Large central continent
    const landmassNoise = this.noise.sample(x * 0.008, y * 0.008, 4, 1.2);
    const continentBase = Math.max(0, landmassShape * 0.7 + landmassNoise * 0.3);
    
    // Add scattered islands (smaller landmasses away from center)
    const islandNoise = this.noise.sample(x * 0.015, y * 0.015, 3, 0.8);
    const islandThreshold = 0.3;
    const islandContribution = islandNoise > islandThreshold ? (islandNoise - islandThreshold) * 0.4 : 0;
    
    // Mid-frequency terrain detail (mountains, valleys)
    const terrainNoise = this.noise.sample(x * 0.04, y * 0.04, 5, 0.6);
    
    // High-frequency detail (small features)
    const detailNoise = this.noise.sample(x * 0.15, y * 0.15, 2, 0.2);
    
    // Combine for elevation: continent base + islands + terrain detail
    const elevation = Math.max(0, Math.min(1, 
      continentBase * 0.5 + 
      islandContribution * 0.3 + 
      terrainNoise * 0.15 + 
      detailNoise * 0.05
    ));
    
    // Temperature: latitude-based with elevation influence
    const lat = ny; // 0-1 from top to bottom
    const tempBase = 1 - Math.abs(lat - 0.5) * 1.8; // Colder at poles, warmer at equator
    const tempElevation = (1 - elevation) * 0.4; // Higher = colder
    const tempNoise = this.noise.sample(x * 0.02, y * 0.02, 2, 0.3);
    const temperature = Math.max(0, Math.min(1, tempBase * 0.6 + tempElevation + tempNoise * 0.15));
    
    // Moisture: distance from coast + elevation (rain shadow) + noise
    const coastDist = this.getCoastDistance(x, y);
    const moistureBase = Math.max(0, 1 - coastDist * 1.5);
    
    // Rain shadow: leeward side of mountains is drier
    const mountainInfluence = elevation > 0.6 ? this.getRainShadow(x, y, elevation) : 1.0;
    
    const moistureNoise = this.noise.sample(x * 0.03, y * 0.03, 3, 0.5);
    const moisture = Math.max(0, Math.min(1, 
      moistureBase * 0.5 + 
      mountainInfluence * 0.3 + 
      moistureNoise * 0.2
    ));
    
    // Ruggedness: high-frequency noise for mountain detail, concentrated in high elevation
    const ruggednessBase = elevation > 0.5 ? this.noise.sample(x * 0.12, y * 0.12, 4, 1.5) : 0.2;
    const ruggedness = Math.max(0, Math.min(1, ruggednessBase * elevation));
    
    return {
      elevation: Math.max(0, Math.min(1, elevation)),
      temperature: Math.max(0, Math.min(1, temperature)),
      moisture: Math.max(0, Math.min(1, moisture)),
      ruggedness: Math.max(0, Math.min(1, ruggedness))
    };
  }
  
  /**
   * Calculate distance to nearest coast (for moisture calculation)
   */
  private getCoastDistance(x: number, y: number): number {
    // Sample nearby points to find coast
    const searchRadius = 10;
    let minDist = searchRadius;
    
    for (let dy = -searchRadius; dy <= searchRadius; dy += 2) {
      for (let dx = -searchRadius; dx <= searchRadius; dx += 2) {
        const fields = this.sampleFields(x + dx, y + dy);
        if (fields.elevation < COAST_THRESHOLD) {
          const dist = Math.sqrt(dx * dx + dy * dy);
          minDist = Math.min(minDist, dist);
        }
      }
    }
    
    return minDist / searchRadius; // Normalize to 0-1
  }
  
  /**
   * Calculate rain shadow effect (drier on leeward side of mountains)
   */
  private getRainShadow(x: number, y: number, elevation: number): number {
    if (elevation < 0.5) return 1.0; // No rain shadow at low elevation
    
    // Check windward side (assume prevailing wind from west)
    const westElevation = this.sampleFields(x - 10, y).elevation;
    const eastElevation = this.sampleFields(x + 10, y).elevation;
    
    // If we're on the leeward (east) side of a mountain, reduce moisture
    if (westElevation > elevation + 0.1 && eastElevation < elevation) {
      return 0.3; // Strong rain shadow
    }
    
    // If we're on the windward (west) side, increase moisture
    if (westElevation < elevation && eastElevation > elevation + 0.1) {
      return 1.2; // Enhanced moisture (capped by caller)
    }
    
    return 1.0; // No rain shadow
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
   * Natural biome placement with smooth transitions
   */
  private classifyBiome(fields: FieldValues): Biome {
    const { elevation, temperature, moisture, ruggedness } = fields;

    // Ocean (below sea level)
    if (elevation < SEA_LEVEL) {
      return "ocean";
    }

    // Coast (shallow water, beaches, estuaries)
    if (elevation < COAST_THRESHOLD) {
      // Wetlands/estuaries in low-lying coastal areas with high moisture
      if (moisture > 0.7 && elevation < SEA_LEVEL + 0.02) {
        return "coast"; // Marshy coast
      }
      return "coast";
    }

    // Mountains (high elevation + high ruggedness)
    // Snow caps on high mountains (cold or very high)
    if (elevation > 0.7 && ruggedness > 0.5) {
      if (temperature < 0.35 || elevation > 0.85) {
        return "snow"; // Snow-capped peaks
      }
      return "mountain";
    }

    // Tundra (very cold, moderate moisture)
    if (temperature < 0.3) {
      if (moisture > 0.4) {
        return "tundra";
      }
      return "snow"; // Cold and dry = snow
    }

    // High elevation but not quite mountain = alpine tundra
    if (elevation > 0.65 && temperature < 0.5) {
      return "tundra";
    }

    // Desert (very dry, especially on leeward side of mountains)
    // Desert forms in dry zones, especially at mid-low elevations
    if (moisture < 0.25 && elevation < 0.7) {
      return "desert";
    }

    // Forest (high moisture, moderate to high temperature, mid elevations)
    // Forests prefer humid zones near rivers and moderate elevations
    if (moisture > 0.55 && temperature > 0.35 && elevation < 0.7) {
      // Denser forest in very humid zones
      if (moisture > 0.7) {
        return "forest";
      }
      // Mixed forest/plains transition
      if (moisture > 0.6) {
        return "forest";
      }
    }

    // Default: plains/grassland (moderate conditions)
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
   * Improved: Better river continuity and branching
   */
  private isOnRiverPath(x: number, y: number, fields: FieldValues): boolean {
    const MAX_TRACE_STEPS = 300; // Increased for longer rivers
    const visited = new Set<string>();
    let currentX = x;
    let currentY = y;
    let steps = 0;
    let foundSource = false;

    // Trace backward (uphill) to find source
    while (steps < MAX_TRACE_STEPS) {
      const key = `${currentX},${currentY}`;
      if (visited.has(key)) {
        // Loop detected - check if we're in a valid river basin
        break;
      }
      visited.add(key);

      const currentFields = this.sampleFields(currentX, currentY);
      
      // Check if we've reached a valid source
      if (currentFields.elevation > 0.6 && currentFields.moisture > 0.55) {
        const sourceSeed = this.noise.sample(currentX * 0.08, currentY * 0.08, 1, 0.6);
        if (sourceSeed > 0.75) {
          foundSource = true;
          break; // Found valid source
        }
      }

      // Check if we've reached ocean/coast (can't trace further)
      if (currentFields.elevation < SEA_LEVEL + 0.05) {
        break; // Reached water, not a valid path
      }

      // Find highest neighbor (uphill direction, tracing backward)
      const neighbors = [
        { x: currentX - 1, y: currentY },
        { x: currentX + 1, y: currentY },
        { x: currentX, y: currentY - 1 },
        { x: currentX, y: currentY + 1 },
        // Include diagonals for smoother paths
        { x: currentX - 1, y: currentY - 1 },
        { x: currentX + 1, y: currentY - 1 },
        { x: currentX - 1, y: currentY + 1 },
        { x: currentX + 1, y: currentY + 1 }
      ];

      let next: { x: number; y: number } | null = null;
      let highestElevation = currentFields.elevation;

      for (const n of neighbors) {
        const nFields = this.sampleFields(n.x, n.y);
        // Prefer neighbors that are higher (uphill) but not too much higher (avoid jumping)
        if (nFields.elevation > highestElevation && nFields.elevation < currentFields.elevation + 0.2) {
          highestElevation = nFields.elevation;
          next = n;
        }
      }

      // No uphill neighbor found - check if we're in a valid river valley
      if (!next) {
        // If we're in a valley (surrounded by higher ground) and have moisture, might be river
        if (currentFields.moisture > 0.6 && currentFields.elevation > SEA_LEVEL + 0.1) {
          // Check if nearby cells suggest river flow
          const nearbyMoisture = this.checkNearbyMoisture(currentX, currentY);
          if (nearbyMoisture > 0.65) {
            foundSource = true; // Valid river valley
          }
        }
        break;
      }

      currentX = next.x;
      currentY = next.y;
      steps += 1;
    }

    // If we found a source, verify the path forward (downhill) is valid
    if (foundSource) {
      // Quick forward trace to ensure river flows to water
      return this.verifyRiverFlow(x, y, fields);
    }

    return false;
  }
  
  /**
   * Check nearby moisture to determine if we're in a river valley
   */
  private checkNearbyMoisture(x: number, y: number): number {
    let totalMoisture = 0;
    let count = 0;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const fields = this.sampleFields(x + dx, y + dy);
        totalMoisture += fields.moisture;
        count += 1;
      }
    }
    return totalMoisture / count;
  }
  
  /**
   * Verify that a river point can flow downhill to water
   */
  private verifyRiverFlow(x: number, y: number, fields: FieldValues): boolean {
    const MAX_FLOW_STEPS = 150;
    let currentX = x;
    let currentY = y;
    let steps = 0;
    const visited = new Set<string>();

    while (steps < MAX_FLOW_STEPS) {
      const key = `${currentX},${currentY}`;
      if (visited.has(key)) {
        break; // Loop
      }
      visited.add(key);

      const currentFields = this.sampleFields(currentX, currentY);
      
      // Reached water - valid river
      if (currentFields.elevation < SEA_LEVEL + 0.1) {
        return true;
      }

      // Find lowest neighbor (downhill)
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

      if (!next) {
        // Local minima - check for lake
        if (currentFields.moisture > 0.7) {
          return true; // Lake formed, river valid
        }
        return false; // Dead end
      }

      currentX = next.x;
      currentY = next.y;
      steps += 1;
    }

    return false; // Didn't reach water
  }

  /**
   * Check if cell has a lake
   * Lakes form in local elevation minima with high moisture
   */
  private checkLake(x: number, y: number, fields: FieldValues): boolean {
    // Lakes need to be in a basin (local minimum) with sufficient moisture
    if (fields.elevation < 0.5 && fields.moisture > 0.65) {
      // Check if this is a local minimum (all neighbors are higher)
      const neighbors = [
        { x: x - 1, y },
        { x: x + 1, y },
        { x, y: y - 1 },
        { x, y: y + 1 }
      ];
      
      let isLocalMin = true;
      for (const n of neighbors) {
        const nFields = this.sampleFields(n.x, n.y);
        if (nFields.elevation < fields.elevation + 0.05) {
          isLocalMin = false;
          break;
        }
      }
      
      if (isLocalMin) {
        // Use deterministic noise to place lakes
        const lakeNoise = this.noise.sample(x * 0.15, y * 0.15, 1, 1.5);
        return lakeNoise > 0.7; // 30% chance in valid basins
      }
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

