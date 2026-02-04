import type { Biome, Position, Tile } from "./types";

const biomePalette: Record<Biome, string> = {
  ocean: "#1a4f8a",
  coast: "#3f7fb3",
  plains: "#6fbf5f",
  forest: "#2f7d4b",
  desert: "#d9c37a",
  tundra: "#a5b9a8",
  snow: "#e9f0f5",
  mountain: "#7a7f86",
  river: "#4aa3df"
};

export const generateWorldMap = (seed: string, size: number): Tile[] => {
  const rng = mulberry32(hashSeed(seed));
  const elevation = generateLayer(size, 5, rng);
  const humidity = generateLayer(size, 6, rng);
  const temperature = generateTemperature(size, rng);

  const softenedElevation = blurLayer(elevation, size, 2);
  const tiles: Tile[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = y * size + x;
      const e = softenedElevation[idx];
      const t = temperature[idx];
      const h = humidity[idx];
      const biome = pickBiome(e, t, h);
      tiles.push({
        x,
        y,
        elevation: e,
        temperature: t,
        humidity: h,
        biome,
        river: false
      });
    }
  }

  addRivers(tiles, size, rng);
  return tiles;
};

export const generateRegions = (tiles: Tile[], size: number): { id: string; name: string; type: "continent" | "sea"; center: Position }[] => {
  const regions: { id: string; name: string; type: "continent" | "sea"; center: Position }[] = [];
  const visited = new Set<number>();
  const land = (tile: Tile) => tile.biome !== "ocean";

  for (const tile of tiles) {
    const idx = tile.y * size + tile.x;
    if (visited.has(idx)) {
      continue;
    }
    const isLand = land(tile);
    const queue = [tile];
    const points: Tile[] = [];
    visited.add(idx);

    while (queue.length > 0) {
      const current = queue.pop()!;
      points.push(current);
      for (const neighbor of neighbors(current, tiles, size)) {
        const nIdx = neighbor.y * size + neighbor.x;
        if (visited.has(nIdx)) {
          continue;
        }
        if (land(neighbor) === isLand) {
          visited.add(nIdx);
          queue.push(neighbor);
        }
      }
    }

    if (points.length < 40) {
      continue;
    }
    const center = averagePosition(points);
    regions.push({
      id: crypto.randomUUID(),
      name: isLand ? continentName() : seaName(),
      type: isLand ? "continent" : "sea",
      center
    });
  }
  return regions.slice(0, 12);
};

export const biomeColor = (biome: Biome): string => biomePalette[biome];

const hashSeed = (seed: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const mulberry32 = (seed: number): (() => number) => {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const generateLayer = (size: number, octaves: number, rng: () => number): Float32Array => {
  const base = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x / size - 0.5;
      const ny = y / size - 0.5;
      let value = 0;
      let amplitude = 1;
      let frequency = 1;
      let max = 0;
      for (let o = 0; o < octaves; o += 1) {
        const noise = smoothNoise(nx * frequency, ny * frequency, rng);
        value += noise * amplitude;
        max += amplitude;
        amplitude *= 0.5;
        frequency *= 2;
      }
      value /= max;
      base[y * size + x] = value;
    }
  }
  return base;
};

const generateTemperature = (size: number, rng: () => number): Float32Array => {
  const temp = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    const latitude = Math.abs(y / size - 0.5) * 2;
    for (let x = 0; x < size; x += 1) {
      const noise = (rng() - 0.5) * 0.15;
      temp[y * size + x] = 1 - latitude + noise;
    }
  }
  return temp;
};

const blurLayer = (layer: Float32Array, size: number, passes: number): Float32Array => {
  let result = layer;
  for (let p = 0; p < passes; p += 1) {
    const next = new Float32Array(size * size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) {
              continue;
            }
            sum += result[ny * size + nx];
            count += 1;
          }
        }
        next[y * size + x] = sum / count;
      }
    }
    result = next;
  }
  return result;
};

const smoothNoise = (x: number, y: number, rng: () => number): number => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  const n00 = randomFromCoords(xi, yi, rng);
  const n10 = randomFromCoords(xi + 1, yi, rng);
  const n01 = randomFromCoords(xi, yi + 1, rng);
  const n11 = randomFromCoords(xi + 1, yi + 1, rng);

  const u = fade(xf);
  const v = fade(yf);
  const x1 = lerp(n00, n10, u);
  const x2 = lerp(n01, n11, u);
  return lerp(x1, x2, v);
};

const randomFromCoords = (x: number, y: number, rng: () => number): number => {
  const r = Math.sin(x * 127.1 + y * 311.7 + rng() * 10) * 43758.5453123;
  return r - Math.floor(r);
};

const fade = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const pickBiome = (elevation: number, temp: number, humidity: number): Biome => {
  if (elevation < 0.32) {
    return "ocean";
  }
  if (elevation < 0.36) {
    return "coast";
  }
  if (elevation > 0.78) {
    return temp < 0.4 ? "snow" : "mountain";
  }
  if (temp < 0.25) {
    return humidity > 0.5 ? "tundra" : "snow";
  }
  if (humidity < 0.25) {
    return "desert";
  }
  if (humidity > 0.6) {
    return "forest";
  }
  return "plains";
};

const addRivers = (tiles: Tile[], size: number, rng: () => number): void => {
  const candidates = tiles.filter((tile) => tile.elevation > 0.68 && tile.biome !== "mountain");
  const sources = shuffle(candidates, rng).slice(0, Math.min(18, candidates.length));
  for (const source of sources) {
    let current = source;
    const visited = new Set<string>();
    for (let step = 0; step < 140; step += 1) {
      const key = `${current.x},${current.y}`;
      if (visited.has(key)) {
        break;
      }
      visited.add(key);
      current.river = true;
      current.biome = current.biome === "ocean" ? "ocean" : "river";
      const next = lowestNeighbor(current, tiles, size);
      if (!next) {
        break;
      }
      if (next.biome === "ocean") {
        break;
      }
      current = next;
    }
  }
};

const neighbors = (tile: Tile, tiles: Tile[], size: number): Tile[] => {
  const results: Tile[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const nx = tile.x + dx;
      const ny = tile.y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) {
        continue;
      }
      results.push(tiles[ny * size + nx]);
    }
  }
  return results;
};

const lowestNeighbor = (tile: Tile, tiles: Tile[], size: number): Tile | null => {
  const options = neighbors(tile, tiles, size);
  let best: Tile | null = null;
  for (const option of options) {
    if (!best || option.elevation < best.elevation) {
      best = option;
    }
  }
  return best;
};

const shuffle = <T>(items: T[], rng: () => number): T[] => {
  const array = [...items];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

const continentName = (): string => {
  const parts = ["Ar", "Bel", "Ca", "Dor", "Eld", "Fae", "Gal", "Hel", "Ily", "Jor", "Kel", "Lor"];
  return `${parts[Math.floor(Math.random() * parts.length)]}${parts[Math.floor(Math.random() * parts.length)]}a`;
};

const seaName = (): string => {
  const parts = ["Azure", "Silver", "Tempest", "Whisper", "Dawn", "Umber", "Gleam", "Sable"];
  return `${parts[Math.floor(Math.random() * parts.length)]} Sea`;
};

const averagePosition = (tiles: Tile[]): Position => {
  const sum = tiles.reduce(
    (acc, tile) => ({ x: acc.x + tile.x, y: acc.y + tile.y }),
    { x: 0, y: 0 }
  );
  return {
    x: Math.round(sum.x / tiles.length),
    y: Math.round(sum.y / tiles.length)
  };
};

