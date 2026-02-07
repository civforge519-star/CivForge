# Chunk-Based World Generation System

## Overview

The chunk-based world generation system provides scalable, deterministic procedural terrain generation for CivForge. It generates terrain on demand using world seed + coordinates, supporting infinite or extremely large maps.

## Determinism Contract

**Critical Guarantee**: For any given `(seed, x, y)`, the system guarantees:
- `sampleFields(seed, x, y)` returns identical values across all runs
- `getCell(seed, x, y)` returns identical values across all runs
- `generateChunk(seed, cx, cy, lod)` returns identical chunk data across all runs
- Cross-chunk boundaries are seamless - cells at chunk edges match when accessed from adjacent chunks
- Rivers flow deterministically across chunk boundaries without breaks

This determinism is achieved through:
- Pure functions with no external state
- Deterministic noise generation based on seed + coordinates
- Global sampling functions (no chunk-local context)
- No random number generation (all "randomness" is deterministic from seed)

## Architecture

### Core Components

1. **`chunkgen.ts`** - Core chunk generation engine
   - `ChunkWorldGenerator` - Main generator class
   - Deterministic noise system
   - Biome classification
   - Resource assignment
   - Water feature detection

2. **`chunkgen-api.ts`** - Public API for accessing world data
   - Clean interface functions
   - Generator instance management
   - Viewport tile generation

### Key Features

- **Chunk-based**: 128x128 cells per chunk
- **Deterministic**: Same seed + coordinates = same terrain
- **On-demand**: Chunks generated only when requested
- **LOD Support**: Three detail levels (LOD0, LOD1, LOD2)
- **Cached**: LRU cache for performance
- **Scalable**: Supports infinite/large maps

## API Functions

### `sampleFields(seed, x, y)`
Returns field values at world coordinates:
- `elevation` - Terrain height (0-1)
- `temperature` - Climate temperature (0-1)
- `moisture` - Humidity/rainfall (0-1)
- `ruggedness` - Mountain detail (0-1)

### `getCell(seed, x, y)`
Returns complete cell data:
- `biome` - Terrain type
- `movementCost` - Travel difficulty
- `resources` - Natural resource potential (food, wood, stone, iron)
- `hasRiver` - River presence
- `hasLake` - Lake presence

### `worldToChunk(x, y)`
Converts world coordinates to chunk coordinates:
```typescript
{ cx: number, cy: number }
```

### `generateChunk(seed, cx, cy, lod)`
Generates chunk data at specified LOD:
- **LOD0**: Full cell data (128x128 tiles)
- **LOD1**: Aggregated blocks (4x4 cells per block)
- **LOD2**: Biome heatmap summary

### `generateViewportTiles(seed, minX, minY, maxX, maxY)`
Generates tiles for a viewport (for rendering).

## Biome Classification

Biomes are determined by field values with smooth transitions:

- **Ocean**: `elevation < 0.32`
- **Coast**: `elevation < 0.36`
- **Mountain**: `elevation > 0.75 && ruggedness > 0.6`
- **Snow**: High elevation + low temperature
- **Tundra**: `temperature < 0.25`
- **Desert**: `moisture < 0.2`
- **Forest**: `moisture > 0.6`
- **Plains**: Default grassland

## Resource Potential

Each biome has natural resource potential (0-1 scale):

| Biome | Food | Wood | Stone | Iron |
|-------|------|------|-------|------|
| Forest | 0.4 | 0.8 | 0 | 0 |
| Plains | 0.9 | 0.2 | 0 | 0 |
| Mountain | 0 | 0 | 0.9 | 0.5 |
| Desert | 0.1 | 0 | 0.5 | 0 |
| Coast | 0.6 | 0 | 0 | 0 |
| Ocean | 0.3 | 0 | 0 | 0 |

## Water Features

### Rivers
- Start at high elevation (`> 0.55`)
- Flow through valleys
- Deterministic based on seed + coordinates
- Cross chunk boundaries correctly

### Lakes
- Appear in local elevation minima
- Require high moisture (`> 0.7`)
- Elevation threshold (`< 0.4`)

## Performance

- **Generation**: Pure functions, no blocking IO
- **Caching**: LRU cache (default 100 chunks)
- **Memory**: Only active chunks in memory
- **Speed**: Fast enough for real-time simulation

## Usage Example

```typescript
import { sampleFields, getCell, generateChunk, worldToChunk } from "./chunkgen-api";

const seed = "my-world-seed";

// Sample fields at a point
const fields = sampleFields(seed, 100, 200);
console.log(fields.elevation, fields.temperature);

// Get cell data
const cell = getCell(seed, 100, 200);
console.log(cell.biome, cell.resources);

// Generate a chunk
const chunk = generateChunk(seed, 0, 0, 0); // LOD0
console.log(chunk.cells?.length); // 16384 cells

// Convert coordinates
const chunkCoord = worldToChunk(100, 200);
console.log(chunkCoord); // { cx: 0, cy: 1 }
```

## Backward Compatibility

The system maintains backward compatibility:
- Small worlds (`size <= 256`) use legacy generation
- Large worlds (`size > 256`) use chunk-based generation
- Existing worlds continue to work unchanged

## Terrain Overlay System

The overlay system allows simulation changes (roads, buildings, resource depletion) to be applied on top of base terrain without affecting determinism.

### OverlayCellDelta

Optional modifications to a cell:
- `biomeOverride` - Change biome (e.g., for buildings)
- `movementCostAdjustment` - Multiplier for movement cost (e.g., 0.5 for roads)
- `resourceDepletion` - Resource multipliers (0-1) for depletion
- `structures` - Flags for roads, buildings, farms, mines

### Usage

```typescript
import { OverlayStore } from "./chunkgen-overlay";
import { getCellWithOverlay, generateChunkWithOverlay } from "./chunkgen-api";

const overlay = new OverlayStore();

// Add a road (reduces movement cost)
overlay.setDelta(100, 200, {
  movementCostAdjustment: 0.5,
  structures: { road: true }
});

// Get cell with overlay
const cell = getCellWithOverlay(seed, 100, 200, overlay);

// Generate chunk with overlay
const chunk = generateChunkWithOverlay(seed, 0, 0, 0, overlay);
```

### Important Notes

- Overlays never modify base `sampleFields()` - determinism is preserved
- Overlays only apply to LOD0 (full cell data)
- Overlay store is in-memory (persistence layer to be added)

## Payload Optimization

Chunks can be serialized to compact JSON for network transmission:

```typescript
import { serializeChunk, deserializeChunk } from "./chunkgen-serializer";

const chunk = generateChunk(seed, 0, 0, 0);
const payload = serializeChunk(chunk); // Compact JSON
const restored = deserializeChunk(payload); // Full chunk data
```

Optimizations:
- Biome IDs (0-8) instead of strings
- Scaled values (0-255) instead of floats
- Compact field names (b, e, t, h, r)

## Testing

Run tests with:
```bash
npm test
```

Test suite covers:
- **Determinism**: Same seed + coords = identical outputs
- **Cross-chunk continuity**: Cells at chunk boundaries match from adjacent chunks
- **LOD consistency**: LOD1/LOD2 match aggregated LOD0 data
- **River continuity**: Rivers flow seamlessly across chunk boundaries
- **Water edge cases**: Safeguards for loops, max steps, local minima

## Future Enhancements

- Multi-chunk river pathfinding (enhanced)
- Advanced lake generation
- Swamp biome implementation
- Chunk persistence to storage
- Streaming chunk updates
- Overlay persistence layer

