export type CameraState = {
  x: number;
  y: number;
  zoom: number;
  vx: number;
  vy: number;
  isDragging: boolean;
  lastX: number;
  lastY: number;
};

export const createCamera = (size = 128): CameraState => ({
  x: size / 2,
  y: size / 2,
  zoom: 0.9,
  vx: 0,
  vy: 0,
  isDragging: false,
  lastX: 0,
  lastY: 0
});

export const updateCamera = (
  camera: CameraState,
  size: number,
  width: number,
  height: number,
  follow?: { x: number; y: number }
): void => {
  camera.x += camera.vx;
  camera.y += camera.vy;
  camera.vx *= 0.85;
  camera.vy *= 0.85;
  if (follow) {
    camera.x += (follow.x - camera.x) * 0.1;
    camera.y += (follow.y - camera.y) * 0.1;
  }
  const halfW = width / (2 * camera.zoom);
  const halfH = height / (2 * camera.zoom);
  camera.x = clamp(camera.x, halfW, size - halfW);
  camera.y = clamp(camera.y, halfH, size - halfH);
};

export const worldToScreen = (pos: { x: number; y: number }, view: { left: number; top: number }, zoom: number) => ({
  x: (pos.x - view.left) * zoom,
  y: (pos.y - view.top) * zoom
});

export const screenToWorld = (
  x: number,
  y: number,
  camera: CameraState,
  worldSize: number,
  rect: { width: number; height: number }
) => {
  const halfW = rect.width / (2 * camera.zoom);
  const halfH = rect.height / (2 * camera.zoom);
  const worldX = camera.x - halfW + x / camera.zoom;
  const worldY = camera.y - halfH + y / camera.zoom;
  return {
    x: Math.max(0, Math.min(worldSize - 1, Math.round(worldX))),
    y: Math.max(0, Math.min(worldSize - 1, Math.round(worldY)))
  };
};

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const resetToFit = (
  camera: CameraState,
  worldSize: number,
  canvasWidth: number,
  canvasHeight: number
): void => {
  // Center camera on world center
  camera.x = worldSize / 2;
  camera.y = worldSize / 2;
  
  // Calculate zoom to fit entire world in view
  // World coordinates: 0 to worldSize
  // We want to see the full world with a small margin
  const padding = 0.95; // 95% of viewport to leave small margin
  const zoomX = (canvasWidth * padding) / worldSize;
  const zoomY = (canvasHeight * padding) / worldSize;
  camera.zoom = Math.min(zoomX, zoomY);
  
  // Ensure zoom is reasonable (not too small or too large)
  camera.zoom = Math.max(0.1, Math.min(camera.zoom, 5.0));
  
  // Reset velocity
  camera.vx = 0;
  camera.vy = 0;
};

