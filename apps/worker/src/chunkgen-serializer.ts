/**
 * Chunk payload serializer for compact JSON representation
 * Optimized for WebSocket streaming
 */

import type { ChunkData } from "./chunkgen";
import { BiomeId, BIOME_TO_ID, ID_TO_BIOME } from "./types";
import type { Biome } from "./types";

/**
 * Compact chunk payload for network transmission
 */
export type CompactChunkPayload = {
  cx: number;
  cy: number;
  lod: 0 | 1 | 2;
  // LOD0: cells as compact array
  cells?: Array<{
    x: number;
    y: number;
    b: number; // biomeId
    e: number; // elevation (0-255, scaled)
    t: number; // temperature (0-255, scaled)
    h: number; // humidity (0-255, scaled)
    r: boolean; // river
  }>;
  // LOD1: blocks as compact array
  blocks?: Array<{
    b: number; // biomeId
    e: number; // avgElevation (0-255, scaled)
  }>;
  // LOD2: heatmap as compact array
  heatmap?: Array<{
    b: number; // biomeId
    c: number; // coverage (0-255, scaled)
  }>;
  ts: number; // timestamp
};

/**
 * Serialize chunk data to compact payload
 */
export function serializeChunk(chunk: ChunkData): CompactChunkPayload {
  const payload: CompactChunkPayload = {
    cx: chunk.cx,
    cy: chunk.cy,
    lod: chunk.lod,
    ts: chunk.generatedAt
  };

  if (chunk.lod === 0 && chunk.cells) {
    payload.cells = chunk.cells.map(cell => ({
      x: cell.x,
      y: cell.y,
      b: BIOME_TO_ID[cell.biome],
      e: Math.round(cell.elevation * 255),
      t: Math.round(cell.temperature * 255),
      h: Math.round(cell.humidity * 255),
      r: cell.river
    }));
  } else if (chunk.lod === 1 && chunk.blocks) {
    payload.blocks = chunk.blocks.map(block => ({
      b: BIOME_TO_ID[block.biome],
      e: Math.round(block.avgElevation * 255)
    }));
  } else if (chunk.lod === 2 && chunk.heatmap) {
    payload.heatmap = chunk.heatmap.map(h => ({
      b: BIOME_TO_ID[h.biome],
      c: Math.round(h.coverage * 255)
    }));
  }

  return payload;
}

/**
 * Deserialize compact payload to chunk data
 */
export function deserializeChunk(payload: CompactChunkPayload): ChunkData {
  const chunk: ChunkData = {
    cx: payload.cx,
    cy: payload.cy,
    lod: payload.lod,
    generatedAt: payload.ts
  };

  if (payload.lod === 0 && payload.cells) {
    chunk.cells = payload.cells.map(c => ({
      x: c.x,
      y: c.y,
      elevation: c.e / 255,
      temperature: c.t / 255,
      humidity: c.h / 255,
      biome: ID_TO_BIOME[c.b as BiomeId],
      river: c.r
    }));
  } else if (payload.lod === 1 && payload.blocks) {
    chunk.blocks = payload.blocks.map(b => ({
      biome: ID_TO_BIOME[b.b as BiomeId],
      avgElevation: b.e / 255
    }));
  } else if (payload.lod === 2 && payload.heatmap) {
    chunk.heatmap = payload.heatmap.map(h => ({
      biome: ID_TO_BIOME[h.b as BiomeId],
      coverage: h.c / 255
    }));
  }

  return chunk;
}
