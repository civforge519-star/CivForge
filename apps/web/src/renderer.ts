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

export const getChunkCanvas = (
  worldState: { worldId: string; config: { size: number }; tiles: Array<any | null> },
  cx: number,
  cy: number,
  chunkSize: number,
  cache: Map<string, HTMLCanvasElement>,
  biomeColors: Record<string, string>
): HTMLCanvasElement => {
  const key = `${worldState.worldId}:${cx}:${cy}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const canvas = document.createElement("canvas");
  canvas.width = chunkSize;
  canvas.height = chunkSize;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }
  for (let y = 0; y < chunkSize; y += 1) {
    for (let x = 0; x < chunkSize; x += 1) {
      const wx = cx * chunkSize + x;
      const wy = cy * chunkSize + y;
      if (wx >= worldState.config.size || wy >= worldState.config.size) {
        continue;
      }
      const tile = worldState.tiles[wy * worldState.config.size + wx];
      if (!tile) {
        ctx.fillStyle = "#0b0f14";
        ctx.fillRect(x, y, 1, 1);
      } else {
        const base = biomeColors[tile.biome] ?? "#0b0f14";
        const shade = Math.floor(30 * (tile.elevation - 0.5));
        ctx.fillStyle = shadeColor(base, shade);
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
  cache.set(key, canvas);
  return canvas;
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

