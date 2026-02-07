import type { CameraState } from "./camera";

export const chunkKey = (x: number, y: number, chunkSize: number): string =>
  `${Math.floor(x / chunkSize) * chunkSize}:${Math.floor(y / chunkSize) * chunkSize}`;

export const shadeColor = (color: string, percent: number) => {
  const num = parseInt(color.replace("#", ""), 16);
  const amt = Math.round(2.55 * percent);
  const r = Math.min(255, Math.max(0, (num >> 16) + amt));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + amt));
  const b = Math.min(255, Math.max(0, (num & 0x0000ff) + amt));
  return `#${(0x1000000 + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
};

/**
 * Biome to RGB color mapping
 * Natural, distinct colors for clean game map style
 */
const biomeRGB: Record<string, [number, number, number]> = {
  ocean: [15, 60, 130],        // Deep ocean blue
  coast: [50, 110, 170],       // Shallow coastal blue
  plains: [85, 160, 75],       // Green grassland
  forest: [25, 95, 50],        // Dark green forest
  desert: [210, 190, 120],     // Sandy beige desert
  tundra: [150, 170, 160],     // Gray-green tundra
  snow: [240, 245, 250],       // Bright white snow
  mountain: [100, 100, 110],   // Gray mountain
  river: [60, 140, 220]        // Bright blue river
};

/**
 * Normalize tiles array into dense grids
 */
export type NormalizedTiles = {
  size: number;
  biomeGrid: Uint8Array; // Biome IDs (0-8)
  riverGrid: Uint8Array; // 0 or 1
  contestedGrid: Uint8Array; // 0 or 1
  expectedTiles: number;
  tilesOk: boolean;
};

const biomeToId: Record<string, number> = {
  ocean: 0,
  coast: 1,
  plains: 2,
  forest: 3,
  desert: 4,
  tundra: 5,
  snow: 6,
  mountain: 7,
  river: 8
};

export const normalizeTiles = (
  tiles: Array<{ x: number; y: number; biome: string; river?: boolean; contested?: boolean } | null>,
  size: number
): NormalizedTiles => {
  const expectedTiles = size * size;
  const biomeGrid = new Uint8Array(expectedTiles);
  const riverGrid = new Uint8Array(expectedTiles);
  const contestedGrid = new Uint8Array(expectedTiles);
  
  let validTiles = 0;
  
  for (let i = 0; i < tiles.length; i += 1) {
    const tile = tiles[i];
    if (tile && tile.x >= 0 && tile.x < size && tile.y >= 0 && tile.y < size) {
      const index = tile.y * size + tile.x;
      biomeGrid[index] = biomeToId[tile.biome] ?? 0;
      riverGrid[index] = tile.river ? 1 : 0;
      contestedGrid[index] = tile.contested ? 1 : 0;
      validTiles += 1;
    }
  }
  
  const tilesOk = validTiles === expectedTiles;
  
  return {
    size,
    biomeGrid,
    riverGrid,
    contestedGrid,
    expectedTiles,
    tilesOk
  };
};

/**
 * Build ImageData for the full map from normalized grids
 */
export const buildMapImageData = (
  size: number,
  biomeGrid: Uint8Array,
  riverGrid: Uint8Array,
  contestedGrid: Uint8Array
): ImageData => {
  const imageData = new ImageData(size, size);
  const data = imageData.data;
  
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      const biomeId = biomeGrid[index];
      
      // Get base color from biome
      let r = 0;
      let g = 0;
      let b = 0;
      
      switch (biomeId) {
        case 0: // ocean
          [r, g, b] = biomeRGB.ocean;
          break;
        case 1: // coast
          [r, g, b] = biomeRGB.coast;
          break;
        case 2: // plains
          [r, g, b] = biomeRGB.plains;
          break;
        case 3: // forest
          [r, g, b] = biomeRGB.forest;
          break;
        case 4: // desert
          [r, g, b] = biomeRGB.desert;
          break;
        case 5: // tundra
          [r, g, b] = biomeRGB.tundra;
          break;
        case 6: // snow
          [r, g, b] = biomeRGB.snow;
          break;
        case 7: // mountain
          [r, g, b] = biomeRGB.mountain;
          break;
        case 8: // river
          [r, g, b] = biomeRGB.river;
          break;
        default:
          [r, g, b] = [11, 15, 20]; // Dark background
      }
      
      // Overlay river if present
      if (riverGrid[index] === 1 && biomeId !== 8) {
        // Blend river color (bright blue) with biome
        r = Math.floor(r * 0.6 + biomeRGB.river[0] * 0.4);
        g = Math.floor(g * 0.6 + biomeRGB.river[1] * 0.4);
        b = Math.floor(b * 0.6 + biomeRGB.river[2] * 0.4);
      }
      
      // Overlay contested tint if present
      if (contestedGrid[index] === 1) {
        r = Math.min(255, r + 20);
        g = Math.max(0, g - 10);
        b = Math.max(0, b - 10);
      }
      
      const pixelIndex = (y * size + x) * 4;
      data[pixelIndex] = r; // R
      data[pixelIndex + 1] = g; // G
      data[pixelIndex + 2] = b; // B
      data[pixelIndex + 3] = 255; // A
    }
  }
  
  return imageData;
};

/**
 * Create or update cached map canvas
 */
export const buildMapCanvas = (
  size: number,
  biomeGrid: Uint8Array,
  riverGrid: Uint8Array,
  contestedGrid: Uint8Array,
  existingCanvas?: HTMLCanvasElement
): HTMLCanvasElement => {
  const canvas = existingCanvas || document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }
  
  const imageData = buildMapImageData(size, biomeGrid, riverGrid, contestedGrid);
  ctx.putImageData(imageData, 0, 0);
  
  return canvas;
};

/**
 * Draw the map canvas to the main canvas with proper transforms
 */
export const drawMapCanvas = (
  ctx: CanvasRenderingContext2D,
  mapCanvas: HTMLCanvasElement,
  camera: CameraState,
  worldSize: number,
  canvasWidth: number,
  canvasHeight: number,
  imageSmoothing: boolean
): void => {
  ctx.imageSmoothingEnabled = imageSmoothing;
  
  // Calculate visible world bounds
  const halfW = canvasWidth / (2 * camera.zoom);
  const halfH = canvasHeight / (2 * camera.zoom);
  
  const worldLeft = Math.max(0, camera.x - halfW);
  const worldTop = Math.max(0, camera.y - halfH);
  const worldRight = Math.min(worldSize, camera.x + halfW);
  const worldBottom = Math.min(worldSize, camera.y + halfH);
  
  const worldWidth = worldRight - worldLeft;
  const worldHeight = worldBottom - worldTop;
  
  // Calculate screen destination
  const screenX = (worldLeft - camera.x) * camera.zoom + canvasWidth / 2;
  const screenY = (worldTop - camera.y) * camera.zoom + canvasHeight / 2;
  const screenWidth = worldWidth * camera.zoom;
  const screenHeight = worldHeight * camera.zoom;
  
  // Draw the map canvas
  ctx.drawImage(
    mapCanvas,
    worldLeft, worldTop, worldWidth, worldHeight, // Source rect (world coords)
    screenX, screenY, screenWidth, screenHeight // Destination rect (screen coords)
  );
};

export const drawFog = (
  ctx: CanvasRenderingContext2D,
  view: { left: number; top: number; right: number; bottom: number },
  zoom: number,
  chunkSize: number,
  exploredChunks: Set<string>,
  visibleChunks: Set<string>,
  showDebug: boolean,
  selected: { x: number; y: number } | null,
  visionRadius: number
) => {
  const startX = Math.max(0, Math.floor(view.left));
  const startY = Math.max(0, Math.floor(view.top));
  const endX = Math.ceil(view.right);
  const endY = Math.ceil(view.bottom);
  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      const screenX = (x - view.left) * zoom;
      const screenY = (y - view.top) * zoom;
      const key = chunkKey(x, y, chunkSize);
      if (!exploredChunks.has(key)) {
        ctx.fillStyle = "rgba(5,8,12,0.9)";
        ctx.fillRect(screenX, screenY, zoom, zoom);
      } else if (!visibleChunks.has(key)) {
        ctx.fillStyle = "rgba(5,8,12,0.5)";
        ctx.fillRect(screenX, screenY, zoom, zoom);
      }
    }
  }
  if (showDebug && selected) {
    ctx.strokeStyle = "#ff5d5d";
    ctx.beginPath();
    ctx.arc((selected.x - view.left) * zoom, (selected.y - view.top) * zoom, visionRadius * zoom, 0, Math.PI * 2);
    ctx.stroke();
  }
};

export const drawBorders = (
  ctx: CanvasRenderingContext2D,
  view: { left: number; top: number; right: number; bottom: number },
  zoom: number,
  chunkSize: number,
  chunkOwnership: Record<string, { cityId?: string; stateId?: string; contested?: boolean }>
) => {
  const startX = Math.floor(view.left / chunkSize) * chunkSize;
  const startY = Math.floor(view.top / chunkSize) * chunkSize;
  const endX = Math.ceil(view.right / chunkSize) * chunkSize;
  const endY = Math.ceil(view.bottom / chunkSize) * chunkSize;
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = Math.max(1, zoom * 0.05);
  for (let y = startY; y < endY; y += chunkSize) {
    for (let x = startX; x < endX; x += chunkSize) {
      const key = `${x}:${y}`;
      const chunk = chunkOwnership[key];
      if (!chunk?.stateId && !chunk?.cityId) {
        continue;
      }
      const right = chunkOwnership[`${x + chunkSize}:${y}`];
      const down = chunkOwnership[`${x}:${y + chunkSize}`];
      const screenX = (x - view.left) * zoom;
      const screenY = (y - view.top) * zoom;
      const width = chunkSize * zoom;
      const height = chunkSize * zoom;
      if ((right?.stateId ?? right?.cityId) !== (chunk.stateId ?? chunk.cityId)) {
        ctx.beginPath();
        ctx.moveTo(screenX + width, screenY);
        ctx.lineTo(screenX + width, screenY + height);
        ctx.stroke();
      }
      if ((down?.stateId ?? down?.cityId) !== (chunk.stateId ?? chunk.cityId)) {
        ctx.beginPath();
        ctx.moveTo(screenX, screenY + height);
        ctx.lineTo(screenX + width, screenY + height);
        ctx.stroke();
      }
      if (chunk.contested) {
        ctx.fillStyle = "rgba(255,110,110,0.2)";
        ctx.fillRect(screenX, screenY, width, height);
      }
    }
  }
};

export const drawOverlay = (
  ctx: CanvasRenderingContext2D,
  view: { left: number; top: number; right: number; bottom: number },
  zoom: number,
  overlay: string,
  heatmaps: Record<string, { updatedAt: number; chunks: Record<string, number[]> }> | undefined,
  chunkSize: number
) => {
  if (!heatmaps) {
    return;
  }
  const heatmap = heatmaps[overlay];
  if (!heatmap) {
    return;
  }
  const startX = Math.floor(view.left);
  const startY = Math.floor(view.top);
  const endX = Math.ceil(view.right);
  const endY = Math.ceil(view.bottom);
  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      const chunkX = Math.floor(x / chunkSize) * chunkSize;
      const chunkY = Math.floor(y / chunkSize) * chunkSize;
      const key = `${chunkX}:${chunkY}`;
      const values = heatmap.chunks[key];
      if (!values) {
        continue;
      }
      const index = (y - chunkY) * chunkSize + (x - chunkX);
      const value = values[index] ?? 0;
      const color = `rgba(78,161,255,${Math.min(0.6, value)})`;
      const screenX = (x - view.left) * zoom;
      const screenY = (y - view.top) * zoom;
      ctx.fillStyle = color;
      ctx.fillRect(screenX, screenY, zoom, zoom);
    }
  }
};

export const drawCheckerboard = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  tileSize: number = 32
): void => {
  const cols = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      ctx.fillStyle = (x + y) % 2 === 0 ? "#1a1f26" : "#0f1419";
      ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
    }
  }
};
