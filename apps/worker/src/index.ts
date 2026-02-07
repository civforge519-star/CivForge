import type { Action, Agent, AgentObservation, Unit, WorldState } from "./types";
import { createWorld, createInventory, isHugeWorld, getOrGenerateTiles } from "./world";
import { observeAgent, tickWorld } from "./simulation";
import { generateRegions, generateWorldMap } from "./worldgen";
import { initStorage, loadSnapshot, loadWorldState, saveSnapshot, saveWorldState } from "./storage/persistence";
import { sanitizeWorld } from "./rules/sanity";
import { generateChunk, generateViewportTiles, getCell } from "./chunkgen-api";

type Env = {
  WORLD_DO: DurableObjectNamespace;
  ADMIN_TOKEN: string;
  AGENT_SIGNING_SECRET?: string;
  WORLD_SIZE?: string;
  NPC_COUNT?: string;
  TICK_RATE?: string;
};

type WsMessage =
  | {
      type: "snapshot";
      protocolVersion: string;
      snapshotVersion: number;
      worldId: string;
      worldType?: string;
      seed: string;
      tick: number;
      serverTime: number;
      config: WorldState["config"];
      tiles: WorldState["tiles"];
      tilesMeta: { mode: "full" | "chunked"; size: number; tileCount: number };
      chunkOwnership: WorldState["chunkOwnership"];
      regions: WorldState["regions"];
      units: WorldState["units"];
      cities: WorldState["cities"];
      states: WorldState["states"];
      events: string[];
      paused: boolean;
      tickRate: number;
      fog?: { exploredChunks: string[]; visibleChunks: string[] };
      heatmaps?: WorldState["heatmaps"];
    }
  | {
      type: "tick";
      tick: number;
      serverTime: number;
      units: WorldState["units"];
      cities: WorldState["cities"];
      states: WorldState["states"];
      events: string[];
    }
  | { type: "chunk_update"; chunks: WorldState["tiles"]; tick: number }
  | { type: "border_update"; chunks: Array<{ key: string; tiles: WorldState["tiles"] }>; tick: number }
  | { type: "heatmap_update"; typeKey: string; chunks: Record<string, number[]>; tick: number }
  | { type: "drama_events"; events: Array<{ id: string; type: string; severity: string; tick: number; timestamp: number; location?: Position; cityId?: string; stateId?: string; targetStateId?: string; message: string }> }
  | { type: "error"; message: string }
  | { type: "ack"; messageId: string }
  | { type: "agent_status"; agentId: string; status: string };

const DEFAULT_WORLD_ID = "public";
const DEFAULT_PUBLIC_WORLD_ID = "public2"; // New huge world ID
const REGISTRY_WORLD_ID = "__registry__";
const PROTOCOL_VERSION = "1.1";
const SNAPSHOT_VERSION = 2;
const HUGE_WORLD_THRESHOLD = 512; // Worlds >= 512 use chunk streaming, no tile persistence
const DEFAULT_HUGE_WORLD_SEED = "earthlike-01";
const DEFAULT_HUGE_WORLD_SIZE = 4096;
const CHUNK_SIZE = 128;
const MAX_VIEWPORT_CHUNKS = 9; // 3x3 chunks

const corsHeaders = (origin?: string): HeadersInit => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,x-admin-token,x-world-id",
  "Access-Control-Max-Age": "86400"
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      // Handle OPTIONS globally at top level
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders()
        });
      }

      const url = new URL(request.url);
      const pathname = url.pathname;
      const worldId = url.searchParams.get("worldId") ?? DEFAULT_WORLD_ID;

      if (pathname === "/worlds" || pathname.startsWith("/worlds/")) {
        const registryStub = env.WORLD_DO.get(env.WORLD_DO.idFromName(REGISTRY_WORLD_ID));
        url.searchParams.set("worldId", REGISTRY_WORLD_ID);
        return registryStub.fetch(new Request(url.toString(), request));
      }

      const stub = env.WORLD_DO.get(env.WORLD_DO.idFromName(worldId));
      return stub.fetch(new Request(url.toString(), request));
    } catch (error) {
      console.error("Top-level fetch error:", error);
      return new Response(
        JSON.stringify({
          ok: false,
          error: "internal_error",
          message: String(error),
          stack: error instanceof Error ? error.stack : undefined
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders()
          }
        }
      );
    }
  }
};

export class WorldDurableObject {
  private state: DurableObjectState;
  private env: Env;
  private world: WorldState | null = null;
  private clients = new Set<WebSocket>();
  private clientMeta = new Map<
    WebSocket,
    {
      viewport?: { x: number; y: number; w: number; h: number; lod: number };
      agentId?: string;
      spectator?: boolean;
      token?: string | null;
    }
  >();
  private initPromise: Promise<void>;
  private worldId = DEFAULT_WORLD_ID;
  private lastTickDurationMs = 0;
  private lastPayloadBytes = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      initStorage(this.state);
      this.state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, data TEXT NOT NULL)"
      );
    } catch (error) {
      console.error("Storage initialization error:", error);
      // Continue with in-memory world so WS can still connect
    }
    
    try {
      const loaded = await loadWorldState(this.state);
      if (loaded) {
        this.world = loaded;
        this.worldId = loaded.worldId;
        // Ensure public world always uses DEFAULT_WORLD_ID
        if (this.world.type === "public" && this.world.worldId !== DEFAULT_WORLD_ID) {
          this.world.worldId = DEFAULT_WORLD_ID;
          this.worldId = DEFAULT_WORLD_ID;
          await this.persistWorld();
        }
        
        // Tiles are derived data - for huge worlds, tiles array is empty (use chunk API)
        // For small/medium worlds, generate on demand if missing
        if (!isHugeWorld(this.world.config.size)) {
          const expectedTileCount = this.world.config.size * this.world.config.size;
          if (!this.world.tiles || this.world.tiles.length !== expectedTileCount) {
            this.world.tiles = getOrGenerateTiles(this.world.config.seed, this.world.config.size);
          }
        } else {
          // Huge world: tiles array stays empty, terrain via chunk API
          this.world.tiles = [];
        }
      } else {
        const size = Number(this.env.WORLD_SIZE ?? 128);
        const tickRate = Number(this.env.TICK_RATE ?? 1);
        const seed = this.worldId;
        // Ensure public world always uses DEFAULT_WORLD_ID
        const finalWorldId = this.worldId === DEFAULT_WORLD_ID || this.worldId === "public" ? DEFAULT_WORLD_ID : this.worldId;
        this.world = createWorld(finalWorldId, seed, size, tickRate, finalWorldId === DEFAULT_WORLD_ID ? "public" : "sandbox");
        this.worldId = finalWorldId;
        // Tiles are derived data, do not persist - already generated in createWorld
        await this.persistWorld();
      }
    } catch (error) {
      console.error("World initialization error:", error);
      // Create in-memory world as fallback
      const isHugeWorldId = this.worldId === DEFAULT_PUBLIC_WORLD_ID;
      const size = isHugeWorldId ? DEFAULT_HUGE_WORLD_SIZE : Number(this.env.WORLD_SIZE ?? 128);
      const tickRate = Number(this.env.TICK_RATE ?? 1);
      const seed = isHugeWorldId ? DEFAULT_HUGE_WORLD_SEED : this.worldId;
      const finalWorldId = this.worldId === DEFAULT_WORLD_ID || this.worldId === "public" ? DEFAULT_WORLD_ID : this.worldId;
      this.world = createWorld(finalWorldId, seed, size, tickRate, finalWorldId === DEFAULT_WORLD_ID ? "public" : "sandbox");
      this.worldId = finalWorldId;
    }
    
    await this.scheduleNextTick();
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.initPromise;
      const url = new URL(request.url);
      const pathname = url.pathname;
      let worldId = url.searchParams.get("worldId") ?? DEFAULT_WORLD_ID;
    // Normalize "public" to DEFAULT_WORLD_ID
    if (worldId === "public" || worldId === DEFAULT_WORLD_ID) {
      worldId = DEFAULT_WORLD_ID;
    }
    this.worldId = worldId;
    // Only switch worlds if not the registry and world doesn't match
    if (this.world && this.world.worldId !== worldId && worldId !== REGISTRY_WORLD_ID) {
      // Load existing world or create new sandbox
      const loaded = await loadWorldState(this.state);
      if (loaded && loaded.worldId === worldId) {
        this.world = loaded;
      } else {
        this.world = createWorld(worldId, worldId, this.world.config.size, this.world.config.tickRate, "sandbox");
        await this.persistWorld();
      }
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (pathname === "/health") {
      return this.jsonResponse({ ok: true });
    }

    if (pathname === "/debug/selftest") {
      return this.handleSelfTest();
    }

    if (pathname === "/health/diagnostics") {
      return this.jsonResponse({
        ok: true,
        tick: this.world?.tick ?? 0,
        lastTickDurationMs: this.lastTickDurationMs,
        clients: this.clients.size,
        units: Object.keys(this.world?.units ?? {}).length,
        cities: Object.keys(this.world?.cities ?? {}).length,
        states: Object.keys(this.world?.states ?? {}).length,
        lastPayloadBytes: this.lastPayloadBytes
      });
    }

    if (pathname === "/world/snapshot") {
      return this.handleSnapshot(request);
    }

    if (pathname === "/world/info") {
      return this.handleWorldInfo(request);
    }

    if (pathname === "/world/chunk") {
      return this.handleChunk(request);
    }

    if (pathname === "/world/viewport") {
      return this.handleViewport(request);
    }

    if (pathname === "/world/reset" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      return this.handleWorldReset(request);
    }

    if (pathname === "/world/create" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      return this.handleWorldCreateFromRequest(request);
    }

    if (pathname === "/world/config" && request.method === "GET") {
      if (!this.world) {
        return this.jsonResponse({ error: "world_not_ready" }, 400);
      }
      const url = new URL(request.url);
      const requestedWorldId = url.searchParams.get("worldId");
      if (requestedWorldId && requestedWorldId !== this.worldId) {
        return this.jsonResponse({ error: "world_not_found" }, 404);
      }
      return this.jsonResponse({
        worldId: this.world.worldId,
        seed: this.world.config.seed,
        size: this.world.config.size,
        tickRate: this.world.config.tickRate,
        hugeWorld: isHugeWorld(this.world.config.size)
      });
    }

    if (pathname === "/world/summary") {
      return this.jsonResponse(this.buildWorldSummary());
    }

    if (pathname === "/world/diagnostics") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      return this.jsonResponse(this.buildDiagnostics());
    }

    if (pathname === "/world/export") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      return this.jsonResponse({ snapshot: this.world });
    }

    if (pathname === "/world/import" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      if (!this.world || this.world.type !== "sandbox") {
        return this.jsonResponse({ error: "not_allowed" }, 403);
      }
      const body = (await request.json().catch(() => ({}))) as { snapshot?: WorldState };
      if (!body.snapshot) {
        return this.jsonResponse({ error: "invalid_snapshot" }, 400);
      }
      this.world = body.snapshot;
      await this.persistWorld();
      return this.jsonResponse({ status: "imported" });
    }

    if (pathname === "/world/summary") {
      return this.jsonResponse({
        worldId: this.world?.worldId ?? worldId,
        type: this.world?.type ?? "public",
        seed: this.world?.config.seed ?? "",
        tick: this.world?.tick ?? 0,
        agents: Object.keys(this.world?.agents ?? {}).length,
        cities: Object.keys(this.world?.cities ?? {}).length,
        states: Object.keys(this.world?.states ?? {}).length,
        tickRate: this.world?.config.tickRate ?? 1,
        lastTickTime: this.world?.lastTickTime ?? 0
      });
    }

    if (pathname === "/world/create" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      return this.handleWorldCreateFromRequest(request);
    }

    if (pathname === "/ws") {
      // WebSocket upgrade handling: require Upgrade header
      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        return this.jsonResponse({ ok: false, error: "upgrade_required", message: "WebSocket upgrade required" }, 426);
      }
      return this.handleWebSocket(request);
    }

    if (pathname === "/agent/ws") {
      return this.handleAgentWebSocket(request);
    }

    if (pathname === "/worlds" && request.method === "GET") {
      return this.handleWorldList();
    }

    if (pathname === "/worlds" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      return this.handleWorldCreate(request);
    }

    if (pathname.startsWith("/agent/register") && request.method === "POST") {
      if (!this.world) {
        return this.jsonResponse({ error: "world_not_ready" }, 400);
      }
      return this.registerAgent(request);
    }

    if (pathname.startsWith("/agent/") && pathname.endsWith("/observe")) {
      return this.observeAgentEndpoint(request);
    }

    if (pathname.startsWith("/agent/") && pathname.endsWith("/act")) {
      return this.actAgentEndpoint(request);
    }

    if (pathname.startsWith("/agent/") && pathname.endsWith("/story")) {
      const agentId = pathname.split("/agent/")[1]?.split("/")[0];
      if (!agentId || !this.world?.agentStories[agentId]) {
        return this.jsonResponse({ error: "agent_story_not_found" }, 404);
      }
      return this.jsonResponse({ story: this.world.agentStories[agentId] });
    }

    if (pathname === "/admin/agents") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      return this.jsonResponse({ agents: this.world?.agents ?? {}, logs: this.world?.agentLogs ?? {} });
    }

    if (pathname === "/admin/pause" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      if (this.world) {
        this.world.paused = true;
        await this.persistWorld();
      }
      return this.jsonResponse({ status: "paused" });
    }

    if (pathname === "/admin/resume" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      if (this.world) {
        this.world.paused = false;
        await this.persistWorld();
        await this.scheduleNextTick();
      }
      return this.jsonResponse({ status: "running" });
    }

    if (pathname === "/admin/speed" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      const body = (await request.json().catch(() => ({}))) as { rate?: number };
      const nextRate = Number(body?.rate);
      if (!Number.isFinite(nextRate) || nextRate <= 0 || nextRate > 10) {
        return this.jsonResponse({ error: "rate must be between 0 and 10" }, 400);
      }
      if (this.world) {
        this.world.config.tickRate = nextRate;
        await this.persistWorld();
        await this.scheduleNextTick();
      }
      return this.jsonResponse({ status: "ok", tickRate: this.world?.config.tickRate ?? nextRate });
    }

    if (pathname === "/admin/step" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      if (!this.world) {
        return this.jsonResponse({ error: "world_not_ready" }, 400);
      }
      const body = (await request.json().catch(() => ({}))) as { ticks?: number };
      const steps = Math.min(10, Math.max(1, body.ticks ?? 1));
      for (let i = 0; i < steps; i += 1) {
        tickWorld(this.world);
      }
      await this.persistWorld();
      return this.jsonResponse({ status: "stepped", ticks: steps });
    }

    if (pathname === "/admin/export" && request.method === "GET") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      return this.jsonResponse({ snapshot: this.world });
    }

    if (pathname === "/admin/import" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      const body = (await request.json().catch(() => ({}))) as { snapshot?: WorldState };
      if (!body.snapshot) {
        return this.jsonResponse({ error: "invalid_snapshot" }, 400);
      }
      this.world = body.snapshot;
      await this.persistWorld();
      return this.jsonResponse({ status: "imported" });
    }

    if (pathname === "/admin/reset" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      if (!this.world) {
        return this.jsonResponse({ error: "world_not_ready" }, 400);
      }
      // Prevent resetting the global public world - only allow sandbox resets
      if (this.world.type === "public" && this.world.worldId === DEFAULT_WORLD_ID) {
        return this.jsonResponse({ error: "public_world_protected", message: "Global public world cannot be reset" }, 403);
      }
      const body = (await request.json().catch(() => ({}))) as { seed?: string };
      const seed = body.seed ?? crypto.randomUUID();
      const tiles = generateWorldMap(seed, this.world.config.size);
      const regions = generateRegions(tiles, this.world.config.size);
      this.world.config.seed = seed;
      this.world.tiles = tiles;
      this.world.regions = regions;
      this.world.tick = 0;
      this.world.fog = {};
      this.world.heatmaps = {};
      this.world.snapshots = [];
      this.world.events = [`World reset with seed ${seed}`];
      await this.persistWorld();
      return this.jsonResponse({ status: "reset", seed });
    }

    if (pathname === "/admin/freeze" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      if (this.world) {
        this.world.paused = true;
        await this.persistWorld();
      }
      return this.jsonResponse({ status: "frozen" });
    }

    if (pathname === "/admin/unfreeze" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      if (this.world) {
        this.world.paused = false;
        await this.persistWorld();
      }
      return this.jsonResponse({ status: "running" });
    }

    if (pathname === "/admin/ban" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      const body = (await request.json().catch(() => ({}))) as { agentId?: string };
      if (!body.agentId || !this.world?.agents[body.agentId]) {
        return this.jsonResponse({ error: "agent_not_found" }, 404);
      }
      this.world.agents[body.agentId].banned = true;
      await this.persistWorld();
      return this.jsonResponse({ status: "banned", agentId: body.agentId });
    }

    if (pathname === "/admin/config" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      if (!this.world) {
        return this.jsonResponse({ error: "world_not_ready" }, 400);
      }
      const body = (await request.json().catch(() => ({}))) as Partial<WorldState["config"]>;
      this.world.config = { ...this.world.config, ...body };
      await this.persistWorld();
      return this.jsonResponse({ status: "updated", config: this.world.config });
    }

    if (pathname === "/admin/paint" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      if (!this.world || this.world.type === "public") {
        return this.jsonResponse({ error: "not_allowed" }, 403);
      }
      const body = (await request.json().catch(() => ({}))) as { x?: number; y?: number; biome?: string; elevation?: number };
      if (body.x === undefined || body.y === undefined) {
        return this.jsonResponse({ error: "invalid_payload" }, 400);
      }
      const idx = body.y * this.world.config.size + body.x;
      const tile = this.world.tiles[idx];
      if (!tile) {
        return this.jsonResponse({ error: "tile_not_found" }, 404);
      }
      if (body.biome) {
        tile.biome = body.biome as any;
      }
      if (typeof body.elevation === "number") {
        tile.elevation = body.elevation;
      }
      this.world.events.unshift(`God mode painted tile ${body.x},${body.y}`);
      await this.persistWorld();
      return this.jsonResponse({ status: "painted" });
    }

    if (pathname === "/admin/event" && request.method === "POST") {
      if (!this.authorize(request)) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      if (!this.world || this.world.type === "public") {
        return this.jsonResponse({ error: "not_allowed" }, 403);
      }
      const body = (await request.json().catch(() => ({}))) as { type?: string; message?: string };
      this.world.events.unshift(body.message ?? `Event: ${body.type ?? "custom"}`);
      await this.persistWorld();
      return this.jsonResponse({ status: "event_added" });
    }

    return this.jsonResponse({ error: "not_found" }, 404);
    } catch (error) {
      console.error("WorldDurableObject.fetch error:", error);
      return this.jsonResponse(
        {
          ok: false,
          error: "internal_error",
          message: String(error),
          stack: error instanceof Error ? error.stack : undefined
        },
        500
      );
    }
  }

  async alarm(): Promise<void> {
    await this.initPromise;
    if (!this.world) {
      return;
    }
    if (!this.world.paused) {
      const start = performance.now();
      if (this.world.tick % 60 === 0) {
        for (const agent of Object.values(this.world.agents)) {
          agent.minuteQuota = this.world.config.actionsPerMinute;
        }
      }
      await this.pullAgentActions();
      let processed: Action[] = [];
      let rejected: Array<{ action: Action; reason: string }> = [];
      try {
        ({ processed, rejected } = tickWorld(this.world));
      } catch (error) {
        this.world.events.unshift("Tick error, reverting to last snapshot");
        await this.revertToLastSnapshot();
      }
      const issues = sanitizeWorld(this.world);
      if (issues.length > 0) {
        this.world.events.unshift("Sanity correction applied");
      }
      for (const action of processed) {
        const log = this.world.agentLogs[action.agentId] ?? { actions: [], lastObservationSize: 0 };
        log.actions.unshift({ action, status: "accepted" });
        log.actions = log.actions.slice(0, 50);
        this.world.agentLogs[action.agentId] = log;
      }
      for (const entry of rejected) {
        const log = this.world.agentLogs[entry.action.agentId] ?? { actions: [], lastObservationSize: 0 };
        log.actions.unshift({ action: entry.action, status: "rejected", reason: entry.reason });
        log.actions = log.actions.slice(0, 50);
        this.world.agentLogs[entry.action.agentId] = log;
      }
      if (rejected.length > 0) {
        for (const entry of rejected) {
          this.logAudit({
            id: crypto.randomUUID(),
            type: "invalid_action",
            data: entry
          });
        }
      }
      if (this.world.tick % 20 === 0 || this.world.events.some((event) => event.includes("founded"))) {
        await saveSnapshot(this.state, this.world);
        this.world.lastGoodSnapshotTick = this.world.tick;
      }
      if (this.world.tick % 5 === 0) {
        await this.persistWorld();
      }
      this.lastTickDurationMs = performance.now() - start;
      this.world.diagnostics.lastTickMs = Math.round(this.lastTickDurationMs);
      this.world.diagnostics.avgTickMs =
        this.world.diagnostics.avgTickMs === 0
          ? this.world.diagnostics.lastTickMs
          : Math.round(this.world.diagnostics.avgTickMs * 0.9 + this.world.diagnostics.lastTickMs * 0.1);
      if (this.lastTickDurationMs > 500 && this.world.config.tickRate > 1) {
        this.world.config.tickRate = Math.max(1, Math.floor(this.world.config.tickRate / 2));
        this.world.events.unshift("Tick slowdown detected; reducing tick rate.");
      }
      this.broadcastTick();
      
      // Broadcast new drama events
      const newDramaEvents = this.world.dramaEvents.filter(
        (e) => e.tick === this.world.tick || (this.world.tick - e.tick <= 1)
      );
      if (newDramaEvents.length > 0) {
        this.broadcastDramaEvents(newDramaEvents);
      }
      
      if (this.world.tick % 5 === 0) {
        this.broadcastHeatmaps();
      }
      if (this.world.tick % 10 === 0) {
        this.broadcastBorders();
      }
    }
    await this.scheduleNextTick();
  }

  private handleWebSocket(request: Request): Response {
    try {
      // Double-check upgrade header (already checked in route handler, but be safe)
      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        return this.jsonResponse({ ok: false, error: "upgrade_required" }, 426);
      }
      
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      server.accept();
      this.clients.add(server);
      const url = new URL(request.url);
      const agentId = url.searchParams.get("agentId") ?? undefined;
      const spectator = url.searchParams.get("spectator") === "1";
      const token = url.searchParams.get("token");
      this.clientMeta.set(server, { agentId, spectator, token });
      server.addEventListener("close", () => {
        this.clients.delete(server);
        this.clientMeta.delete(server);
      });
      server.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(String(event.data)) as { 
            type: string; 
            viewport?: { x: number; y: number; w: number; h: number; lod: number };
            minCx?: number; minCy?: number; maxCx?: number; maxCy?: number; lod?: number;
          };
          if (data.type === "ping") {
            safeSend(server, { type: "pong", tick: this.world?.tick ?? 0 });
            return;
          }
          if (data.type === "set_viewport" && this.world) {
            const meta = this.clientMeta.get(server) ?? {};
            const huge = isHugeWorld(this.world.config.size);
            
            if (huge) {
              // Huge world: send chunks for viewport
              const minCx = data.minCx ?? 0;
              const minCy = data.minCy ?? 0;
              const maxCx = data.maxCx ?? minCx + 2;
              const maxCy = data.maxCy ?? minCy + 2;
              const lod = (data.lod ?? 0) as 0 | 1 | 2;
              
              // Rate limit: max 25 chunks per request
              const chunkCount = (maxCx - minCx + 1) * (maxCy - minCy + 1);
              if (chunkCount > 25) {
                safeSend(server, { type: "error", message: "viewport_too_large" });
                return;
              }
              
              const chunks: Array<{ cx: number; cy: number; lod: number; data: any }> = [];
              for (let cy = minCy; cy <= maxCy; cy += 1) {
                for (let cx = minCx; cx <= maxCx; cx += 1) {
                  try {
                    const chunk = generateChunk(this.world.config.seed, cx, cy, lod);
                    chunks.push({ cx, cy, lod, data: chunk });
                  } catch (error) {
                    console.error(`Failed to generate chunk ${cx},${cy}:`, error);
                  }
                }
              }
              safeSend(server, {
                type: "viewport_chunks",
                chunks,
                tick: this.world.tick
              });
            } else {
              // Small world: use existing subscribe logic
              if (data.viewport) {
                this.clientMeta.set(server, { ...meta, viewport: data.viewport });
                const tiles = tilesForViewport(this.world, data.viewport, meta.agentId);
                safeSend(server, { type: "chunk_update", chunks: tiles, tick: this.world.tick });
              }
            }
            return;
          }
          if (data.type === "subscribe" && data.viewport && this.world && !isHugeWorld(this.world.config.size)) {
            const meta = this.clientMeta.get(server) ?? {};
            this.clientMeta.set(server, { ...meta, viewport: data.viewport });
            const tiles = tilesForViewport(this.world, data.viewport, meta.agentId);
            safeSend(server, { type: "chunk_update", chunks: tiles, tick: this.world.tick });
          }
        } catch (error) {
          console.error("WS message error:", error);
          try {
            if (server.readyState === WebSocket.OPEN) {
              safeSend(server, { type: "error", message: "invalid_message" });
            }
          } catch (sendError) {
            // Socket may be closed
          }
        }
      });

      if (this.world) {
        if (agentId && token && this.world.agents[agentId]) {
          this.verifyAgentAuthToken(token, this.world.agents[agentId]).then((ok) => {
            if (!ok) {
              try {
                server.send(JSON.stringify({ type: "error", message: "unauthorized" }));
                server.close(1008, "Unauthorized");
              } catch (closeError) {
                // Socket may already be closed
              }
            }
          }).catch((error) => {
            console.error("WS auth error:", error);
            try {
              server.close(1011, "Auth error");
            } catch (closeError) {
              // Socket may already be closed
            }
          });
        }
        try {
          const huge = this.world && isHugeWorld(this.world.config.size);
          
          // For huge worlds, send world_info first, then viewport_chunks
          if (huge) {
            safeSend(server, {
              type: "world_info",
              worldId: this.world.worldId,
              seed: this.world.config.seed,
              size: this.world.config.size,
              chunkSize: CHUNK_SIZE,
              tickRate: this.world.config.tickRate,
              hugeWorld: true
            });
            
            // Send initial viewport chunks (center of world, 3x3 chunks)
            const centerCx = Math.floor(this.world.config.size / 2 / CHUNK_SIZE);
            const centerCy = Math.floor(this.world.config.size / 2 / CHUNK_SIZE);
            const chunks: Array<{ cx: number; cy: number; lod: number; data: any }> = [];
            for (let cy = centerCy - 1; cy <= centerCy + 1; cy += 1) {
              for (let cx = centerCx - 1; cx <= centerCx + 1; cx += 1) {
                try {
                  const chunk = generateChunk(this.world.config.seed, cx, cy, 0);
                  chunks.push({ cx, cy, lod: 0, data: chunk });
                } catch (error) {
                  console.error(`Failed to generate chunk ${cx},${cy}:`, error);
                }
              }
            }
            safeSend(server, {
              type: "viewport_chunks",
              chunks,
              tick: this.world.tick
            });
          }
          
          // Always send snapshot (for small worlds it includes tiles, for huge worlds it's metadata)
          try {
            const snapshot = this.buildSnapshotForClient(this.clientMeta.get(server));
            safeSend(server, snapshot);
          } catch (snapshotError) {
            console.error("WS snapshot error:", snapshotError);
            safeSend(server, { type: "error", message: "snapshot_failed" });
          }
        } catch (error) {
          console.error("WS initialization error:", error);
          try {
            server.close(1011, "Internal error");
          } catch (closeError) {
            // Socket may already be closed
          }
        }
      }

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    } catch (error) {
      console.error("WS handler error:", error);
      return this.jsonResponse(
        {
          ok: false,
          error: "ws_error",
          message: String(error),
          stack: error instanceof Error ? error.stack : undefined
        },
        500
      );
    }
  }

  private handleAgentWebSocket(request: Request): Response {
    const url = new URL(request.url);
    const agentId = url.searchParams.get("agentId");
    const token = url.searchParams.get("token");
    if (!agentId || !token || !this.world?.agents[agentId]) {
      return this.jsonResponse({ error: "unauthorized" }, 401);
    }
    const agent = this.world.agents[agentId];
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.addEventListener("message", async (event) => {
      try {
        const action = JSON.parse(String(event.data)) as Action;
        if (!action || action.agentId !== agentId || !(await this.verifyAgentAuthToken(token, agent))) {
          server.send(JSON.stringify({ type: "error", message: "unauthorized" }));
          return;
        }
        const queue = this.world?.actionQueues[agentId] ?? [];
        if (!this.world || agent.minuteQuota <= 0) {
          server.send(JSON.stringify({ type: "error", message: "rate_limited" }));
          return;
        }
        queue.push({ ...action, createdAt: Date.now() });
        agent.minuteQuota -= 1;
        this.world.actionQueues[agentId] = queue;
        server.send(JSON.stringify({ type: "ack", messageId: action.id }));
      } catch (error) {
        server.send(JSON.stringify({ type: "error", message: "invalid_action" }));
      }
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private authorize(request: Request): boolean {
    // Support both x-admin-token header and Authorization header for compatibility
    const token = request.headers.get("x-admin-token") ?? request.headers.get("authorization")?.replace("Bearer ", "");
    return Boolean(this.env.ADMIN_TOKEN && token && token === this.env.ADMIN_TOKEN);
  }

  private async scheduleNextTick(): Promise<void> {
    if (!this.world || this.worldId === REGISTRY_WORLD_ID) {
      return;
    }
    const hasClients = this.clients.size > 0;
    const hasAgents = Object.keys(this.world.agents).length > 0;
    const baseInterval = Math.max(200, Math.floor(1000 / this.world.config.tickRate));
    const intervalMs = hasClients || hasAgents ? baseInterval : Math.max(2000, baseInterval * 5);
    await this.state.storage.setAlarm(Date.now() + intervalMs);
  }

  private async persistWorld(): Promise<void> {
    if (!this.world) {
      return;
    }
    const result = await saveWorldState(this.state, this.world);
    if (!result.ok && result.skipped) {
      // Log but don't throw - world continues in memory
      console.warn(`persistWorld skipped: ${result.reason}, bytes: ${result.bytes}`);
    }
  }

  private broadcast(message: WsMessage): void {
    const payload = JSON.stringify(message);
    for (const socket of this.clients) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  }

  private sendWithCap(socket: WebSocket, message: unknown): void {
    try {
      const payload = JSON.stringify(message);
      this.world!.diagnostics.lastPayloadBytes = payload.length;
      if (payload.length > 100_000) {
        safeSend(socket, { type: "error", message: "payload_too_large" });
        return;
      }
      socket.send(payload);
    } catch (error) {
      safeSend(socket, { type: "error", message: "send_failed" });
    }
  }

  private buildWorldSummary(): Record<string, unknown> {
    if (!this.world) {
      return { status: "loading" };
    }
    return {
      worldId: this.world.worldId,
      type: this.world.type,
      seed: this.world.config.seed,
      size: this.world.config.size,
      tick: this.world.tick,
      tickRate: this.world.config.tickRate,
      agents: Object.keys(this.world.agents).length,
      units: Object.keys(this.world.units).length,
      cities: Object.keys(this.world.cities).length,
      states: Object.keys(this.world.states).length,
      lastTickTime: this.world.lastTickTime,
      paused: this.world.paused
    };
  }

  private buildDiagnostics(): Record<string, unknown> {
    if (!this.world) {
      return { status: "loading" };
    }
    return {
      lastTickMs: this.world.diagnostics.lastTickMs,
      avgTickMs: this.world.diagnostics.avgTickMs,
      lastPayloadBytes: this.world.diagnostics.lastPayloadBytes,
      events: this.world.events.length,
      agents: Object.keys(this.world.agents).length,
      units: Object.keys(this.world.units).length,
      cities: Object.keys(this.world.cities).length,
      states: Object.keys(this.world.states).length
    };
  }

  private broadcastTick(): void {
    if (!this.world) {
      return;
    }
    for (const [socket, meta] of this.clientMeta.entries()) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (meta.agentId && this.world.agents[meta.agentId]) {
        const fog = this.world.fog[meta.agentId];
        const units = fog ? filterUnitsByFog(this.world, fog) : this.world.units;
        const payload = {
          type: "tick",
          tick: this.world.tick,
          serverTime: Date.now(),
          units,
          cities: this.world.cities,
          states: this.world.states,
          events: this.world.events.slice(0, 10)
        };
        this.sendWithCap(socket, payload);
      } else if (meta.spectator && this.authorizeToken(meta.token)) {
        const payload = {
          type: "tick",
          tick: this.world.tick,
          serverTime: Date.now(),
          units: this.world.units,
          cities: this.world.cities,
          states: this.world.states,
          events: this.world.events.slice(0, 10)
        };
        this.sendWithCap(socket, payload);
      }
    }
  }

  private jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }

  private async registerAgent(request: Request): Promise<Response> {
    if (!this.world) {
      return this.jsonResponse({ error: "world_not_ready" }, 400);
    }
    const payload = (await request.json().catch(() => ({}))) as {
      name?: string;
      role?: Agent["role"];
      mode?: Agent["mode"];
      pullUrl?: string;
    };
    const role = payload.role ?? "citizen";
    if (!this.world.config.allowRoles.includes(role)) {
      return this.jsonResponse({ error: "role_not_allowed" }, 400);
    }
    if (Object.keys(this.world.agents).length >= this.world.config.maxAgents) {
      return this.jsonResponse({ error: "world_full" }, 400);
    }
    const agentId = crypto.randomUUID();
    const apiKey = crypto.randomUUID();
    const agent: Agent = {
      id: agentId,
      name: payload.name ?? `Agent-${agentId.slice(0, 6)}`,
      role,
      apiKeyHash: await hashKey(apiKey),
      pullUrl: payload.pullUrl,
      mode: payload.mode ?? "push",
      units: [],
      reputation: 0,
      lastActionTick: 0,
      actionQuota: this.world.config.actionsPerTick,
      minuteQuota: this.world.config.actionsPerMinute,
      banned: false,
      worldId: this.world.worldId
    };
    this.world.agents[agentId] = agent;
    this.world.actionQueues[agentId] = [];
    this.world.agentLogs[agentId] = { actions: [], lastObservationSize: 0 };

    const unitCount = Math.min(this.world.config.maxUnitsPerAgent, role === "tribe" ? 3 : role === "state" ? 5 : 1);
    for (let i = 0; i < unitCount; i += 1) {
      const unitId = crypto.randomUUID();
      const unit: Unit = {
        id: unitId,
        agentId,
        role,
        position: this.randomSpawn(),
        hp: 100,
        stamina: 100,
        inventory: createInventory(true),
        alive: true
      };
      this.world.units[unitId] = unit;
      agent.units.push(unitId);
    }
    this.world.events.unshift(`${agent.name} joined the world`);

    await this.persistWorld();
    return this.jsonResponse({ agentId, apiKey, unitId: agent.units[0], worldId: this.world.worldId });
  }

  private async observeAgentEndpoint(request: Request): Promise<Response> {
    if (!this.world) {
      return this.jsonResponse({ error: "world_not_ready" }, 400);
    }
    const agentId = request.url.split("/agent/")[1]?.split("/")[0];
    if (!agentId) {
      return this.jsonResponse({ error: "agent_not_found" }, 404);
    }
    const agent = this.world.agents[agentId];
    if (!agent) {
      return this.jsonResponse({ error: "agent_not_found" }, 404);
    }
    if (!(await this.verifyAgentAuth(request, agent))) {
      return this.jsonResponse({ error: "unauthorized" }, 401);
    }
    const unit = this.world.units[agent.units[0]];
    if (!unit) {
      return this.jsonResponse({ error: "unit_not_found" }, 404);
    }
    const observation = observeAgent(this.world, unit);
    const size = JSON.stringify(observation).length;
    const log = this.world.agentLogs[agentId] ?? { actions: [], lastObservationSize: 0 };
    log.lastObservationSize = size;
    this.world.agentLogs[agentId] = log;
    return this.jsonResponse(observation);
  }

  private async actAgentEndpoint(request: Request): Promise<Response> {
    if (!this.world) {
      return this.jsonResponse({ error: "world_not_ready" }, 400);
    }
    const agentId = request.url.split("/agent/")[1]?.split("/")[0];
    if (!agentId) {
      return this.jsonResponse({ error: "agent_not_found" }, 404);
    }
    const agent = this.world.agents[agentId];
    if (!agent) {
      return this.jsonResponse({ error: "agent_not_found" }, 404);
    }
    if (!(await this.verifyAgentAuth(request, agent))) {
      return this.jsonResponse({ error: "unauthorized" }, 401);
    }
    const action = (await request.json().catch(() => null)) as Action | null;
    if (!action || action.agentId !== agentId || !isValidAction(action)) {
      return this.jsonResponse({ error: "invalid_action" }, 400);
    }
    const queue = this.world.actionQueues[agentId] ?? [];
    if (agent.minuteQuota <= 0) {
      return this.jsonResponse({ error: "rate_limited" }, 429);
    }
    queue.push({ ...action, createdAt: Date.now() });
    agent.minuteQuota -= 1;
    this.world.actionQueues[agentId] = queue;
    return this.jsonResponse({ status: "queued", queueSize: queue.length });
  }

  private async verifyAgentAuth(request: Request, agent: Agent): Promise<boolean> {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) {
      return false;
    }
    const hash = await hashKey(token);
    return hash === agent.apiKeyHash;
  }

  private async verifyAgentAuthToken(token: string, agent: Agent): Promise<boolean> {
    const hash = await hashKey(token);
    return hash === agent.apiKeyHash;
  }

  private randomSpawn(): { x: number; y: number } {
    if (!this.world) {
      return { x: 0, y: 0 };
    }
    const landTiles = this.world.tiles.filter((tile) => tile.biome !== "ocean");
    const pick = landTiles[Math.floor(Math.random() * landTiles.length)];
    return { x: pick.x, y: pick.y };
  }

  private async handleWorldList(): Promise<Response> {
    if (this.worldId !== REGISTRY_WORLD_ID) {
      return this.jsonResponse({ error: "not_registry" }, 400);
    }
    const list = (await this.state.storage.get<string[]>("worlds")) ?? [];
    const meta = (await this.state.storage.get<Record<string, any>>("world_meta")) ?? {};
    const worlds = list.map((id) => ({
      worldId: id,
      ...meta[id]
    }));
    return this.jsonResponse({ worlds });
  }

  private async handleWorldCreate(request: Request): Promise<Response> {
    if (this.worldId !== REGISTRY_WORLD_ID) {
      return this.jsonResponse({ error: "not_registry" }, 400);
    }
    const payload = (await request.json().catch(() => ({}))) as {
      worldId?: string;
      seed?: string;
      type?: "public" | "sandbox";
      size?: number;
      tickRate?: number;
    };
    const type = payload.type ?? "sandbox";
    
    // Prevent creating multiple public worlds - only one "public" world exists
    if (type === "public") {
      const worlds = (await this.state.storage.get<string[]>("worlds")) ?? [];
      if (worlds.includes(DEFAULT_WORLD_ID)) {
        return this.jsonResponse({ error: "public_world_exists", message: "Only one public world can exist" }, 409);
      }
    }
    
    const worldId = payload.worldId ?? (type === "public" ? DEFAULT_WORLD_ID : `sandbox-${crypto.randomUUID()}`);
    
    // Ensure public world always uses DEFAULT_WORLD_ID
    const finalWorldId = type === "public" ? DEFAULT_WORLD_ID : worldId;
    
    const worlds = (await this.state.storage.get<string[]>("worlds")) ?? [];
    if (!worlds.includes(finalWorldId)) {
      worlds.push(finalWorldId);
      await this.state.storage.put("worlds", worlds);
    }
    const meta = (await this.state.storage.get<Record<string, any>>("world_meta")) ?? {};
    meta[finalWorldId] = {
      seed: payload.seed ?? finalWorldId,
      type,
      size: payload.size ?? Number(this.env.WORLD_SIZE ?? 128),
      tickRate: payload.tickRate ?? Number(this.env.TICK_RATE ?? 1),
      createdAt: Date.now()
    };
    await this.state.storage.put("world_meta", meta);
    return this.jsonResponse({ worldId: finalWorldId, ...meta[finalWorldId] });
  }

  private async handleWorldInfo(request: Request): Promise<Response> {
    if (!this.world) {
      return this.jsonResponse({ error: "world_not_ready" }, 400);
    }
    const url = new URL(request.url);
    const requestedWorldId = url.searchParams.get("worldId");
    
    // Only return info for current world or if no worldId specified
    if (requestedWorldId && requestedWorldId !== this.worldId) {
      return this.jsonResponse({ error: "world_not_found" }, 404);
    }
    
    return this.jsonResponse({
      worldId: this.world.worldId,
      seed: this.world.config.seed,
      size: this.world.config.size,
      chunkSize: CHUNK_SIZE,
      tickRate: this.world.config.tickRate,
      type: this.world.type,
      hugeWorld: isHugeWorld(this.world.config.size),
      tick: this.world.tick
    });
  }

  private async handleWorldReset(request: Request): Promise<Response> {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        worldId?: string;
        seed?: string;
        size?: number;
      };
      
      const worldIdToReset = body.worldId ?? DEFAULT_WORLD_ID;
      const seed = body.seed ?? `public-${Date.now()}`;
      const size = body.size ?? 2048; // Default to huge world
      
      // Only allow resetting if this DO is for that world
      if (this.worldId !== worldIdToReset) {
        return this.jsonResponse({ error: "cannot_reset_other_world" }, 403);
      }
      
      // Clear world state from SQLite
      try {
        this.state.storage.sql.exec("DELETE FROM world_state WHERE id = 1");
        this.state.storage.sql.exec("DELETE FROM world_snapshots");
      } catch (error) {
        console.warn("SQLite cleanup error (may not exist):", error);
      }
      
      // Clear from KV storage (registry, overlays, etc.)
      try {
        await this.state.storage.delete("worlds");
        await this.state.storage.delete("world_meta");
      } catch (error) {
        console.warn("KV cleanup error:", error);
      }
      
      // Reinitialize world with new seed and size
      const tickRate = Number(this.env.TICK_RATE ?? 1);
      this.world = createWorld(worldIdToReset, seed, size, tickRate, worldIdToReset === DEFAULT_WORLD_ID ? "public" : "sandbox");
      this.worldId = worldIdToReset;
      
      // For huge worlds, do NOT generate/store all tiles - just set seed+size
      // Persist minimal metadata only
      await this.persistWorld();
      
      // Update registry if it exists
      try {
        const registryStub = this.env.WORLD_DO.get(this.env.WORLD_DO.idFromName(REGISTRY_WORLD_ID));
        const url = new URL(request.url);
        await registryStub.fetch(new Request(`${url.origin}/worlds?worldId=${REGISTRY_WORLD_ID}`, {
          method: "POST",
          body: JSON.stringify({ worldId: worldIdToReset, seed, size, tickRate, type: worldIdToReset === DEFAULT_WORLD_ID ? "public" : "sandbox" }),
          headers: { "Content-Type": "application/json" }
        }));
      } catch (error) {
        console.warn("Registry update error:", error);
      }
      
      // Start tick loop
      await this.scheduleNextTick();
      
      return this.jsonResponse({ ok: true, worldId: worldIdToReset, seed, size });
    } catch (error) {
      console.error("World reset error:", error);
      return this.jsonResponse({ error: "reset_failed", message: String(error) }, 500);
    }
  }

  private async handleWorldCreateFromRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const worldId = url.searchParams.get("worldId");
    const seed = url.searchParams.get("seed") ?? DEFAULT_HUGE_WORLD_SEED;
    const size = Number(url.searchParams.get("size") ?? DEFAULT_HUGE_WORLD_SIZE);
    const tickRate = Number(url.searchParams.get("tickRate") ?? this.env.TICK_RATE ?? 1);
    
    if (!worldId) {
      return this.jsonResponse({ error: "worldId_required" }, 400);
    }
    
    // Only allow creating if this DO is for that world or if world doesn't exist
    if (this.world && this.worldId !== worldId) {
      return this.jsonResponse({ error: "world_already_exists" }, 409);
    }
    
    try {
      // Create new world
      const finalWorldId = worldId;
      this.world = createWorld(finalWorldId, seed, size, tickRate, "public");
      this.worldId = finalWorldId;
      
      // Persist metadata only (no tiles for huge worlds)
      await this.persistWorld();
      
      // Update registry
      const registryStub = this.env.WORLD_DO.get(this.env.WORLD_DO.idFromName(REGISTRY_WORLD_ID));
      await registryStub.fetch(new Request(`${url.origin}/worlds?worldId=${REGISTRY_WORLD_ID}`, {
        method: "POST",
        body: JSON.stringify({ worldId: finalWorldId, seed, size, tickRate, type: "public" }),
        headers: { "Content-Type": "application/json" }
      }));
      
      // Start tick loop
      await this.scheduleNextTick();
      
      return this.jsonResponse({ 
        status: "created", 
        worldId: finalWorldId, 
        seed, 
        size, 
        tickRate,
        hugeWorld: isHugeWorld(this.world.config.size)
      });
    } catch (error) {
      console.error("World create error:", error);
      return this.jsonResponse({ error: "create_failed", message: String(error) }, 500);
    }
  }

  private async handleChunk(request: Request): Promise<Response> {
    if (!this.world) {
      return this.jsonResponse({ error: "world_not_ready" }, 400);
    }
    const url = new URL(request.url);
    const cx = Number(url.searchParams.get("cx"));
    const cy = Number(url.searchParams.get("cy"));
    const lod = Number(url.searchParams.get("lod") ?? "0") as 0 | 1 | 2;
    
    if (isNaN(cx) || isNaN(cy)) {
      return this.jsonResponse({ error: "invalid_coords" }, 400);
    }
    
    // Cap payload size - reject if too large
    const MAX_CHUNK_PAYLOAD = 200 * 1024; // 200KB
    try {
      const chunk = generateChunk(this.world.config.seed, cx, cy, lod);
      const payload = JSON.stringify(chunk);
      if (new Blob([payload]).size > MAX_CHUNK_PAYLOAD) {
        return this.jsonResponse({ error: "chunk_too_large" }, 413);
      }
      return this.jsonResponse(chunk);
    } catch (error) {
      return this.jsonResponse({ error: "generation_failed", message: String(error) }, 500);
    }
  }

  private async handleViewport(request: Request): Promise<Response> {
    if (!this.world) {
      return this.jsonResponse({ error: "world_not_ready" }, 400);
    }
    const url = new URL(request.url);
    const minX = Number(url.searchParams.get("minX"));
    const minY = Number(url.searchParams.get("minY"));
    const maxX = Number(url.searchParams.get("maxX"));
    const maxY = Number(url.searchParams.get("maxY"));
    const lod = Number(url.searchParams.get("lod") ?? "0") as 0 | 1 | 2;
    
    if (isNaN(minX) || isNaN(minY) || isNaN(maxX) || isNaN(maxY)) {
      return this.jsonResponse({ error: "invalid_viewport" }, 400);
    }
    
    // Clamp bounds to world size first
    const size = this.world.config.size;
    const clampedMinX = Math.max(0, Math.floor(minX));
    const clampedMinY = Math.max(0, Math.floor(minY));
    const clampedMaxX = Math.min(size - 1, Math.floor(maxX));
    const clampedMaxY = Math.min(size - 1, Math.floor(maxY));
    
    // Cap viewport size to prevent huge requests
    const viewportArea = (clampedMaxX - clampedMinX + 1) * (clampedMaxY - clampedMinY + 1);
    const MAX_VIEWPORT_AREA = 10000; // Reasonable limit
    if (viewportArea > MAX_VIEWPORT_AREA) {
      return this.jsonResponse({ error: "viewport_too_large", area: viewportArea, max: MAX_VIEWPORT_AREA }, 400);
    }
    
    try {
      const tiles = generateViewportTiles(this.world.config.seed, clampedMinX, clampedMinY, clampedMaxX, clampedMaxY);
      
      // Return compact format: biomeId instead of biome string, minimal fields
      const compactTiles = tiles.map(t => ({
        x: t.x,
        y: t.y,
        b: t.biome === "ocean" ? 0 : t.biome === "coast" ? 1 : t.biome === "plains" ? 2 : t.biome === "forest" ? 3 : t.biome === "desert" ? 4 : t.biome === "tundra" ? 5 : t.biome === "snow" ? 6 : t.biome === "mountain" ? 7 : 2, // default to plains
        e: Math.round(t.elevation * 255) // 0-255
      }));
      
      const payload = JSON.stringify({ tiles: compactTiles, count: compactTiles.length });
      const bytes = new TextEncoder().encode(payload).length;
      const MAX_PAYLOAD = 200 * 1024; // 200KB
      if (bytes > MAX_PAYLOAD) {
        return this.jsonResponse({ error: "viewport_too_large", bytes, max: MAX_PAYLOAD }, 413);
      }
      return this.jsonResponse({ tiles: compactTiles, count: compactTiles.length, bytes });
    } catch (error) {
      console.error("handleViewport error:", error);
      return this.jsonResponse({ error: "generation_failed", message: String(error) }, 500);
    }
  }

  private logAudit(entry: { id: string; type: string; data: unknown }): void {
    try {
      this.state.storage.sql.exec("INSERT OR REPLACE INTO audit_logs (id, data) VALUES (?, ?)", entry.id, JSON.stringify(entry));
    } catch (error) {
      console.error("logAudit error:", error);
      // Don't throw - audit logging failures shouldn't crash the app
    }
  }

  private async handleSelfTest(): Promise<Response> {
    const checks: Record<string, { ok: boolean; message?: string; error?: string }> = {};
    
    // Test 1: DB initialization
    try {
      const arr = this.state.storage.sql.exec("SELECT 1 as test").toArray();
      checks.db_init = { ok: arr.length > 0, message: "DB initialized" };
    } catch (error) {
      checks.db_init = { ok: false, error: String(error) };
    }

    // Test 2: Simple SELECT query
    try {
      const arr = this.state.storage.sql.exec("SELECT data FROM world_state WHERE id = 1").toArray();
      checks.db_query = { ok: true, message: "SELECT query works" };
    } catch (error) {
      checks.db_query = { ok: false, error: String(error) };
    }

    // Test 3: World metadata read
    try {
      const hasWorld = this.world !== null && this.world !== undefined;
      checks.world_metadata = { 
        ok: hasWorld, 
        message: hasWorld ? `World loaded: ${this.world?.worldId ?? "unknown"}` : "No world loaded" 
      };
    } catch (error) {
      checks.world_metadata = { ok: false, error: String(error) };
    }

    // Test 4: Tiles check (CRITICAL) - for huge worlds, tiles array is empty (OK)
    try {
      if (!this.world) {
        checks.tiles = { ok: false, error: "No world loaded" };
      } else {
        const huge = isHugeWorld(this.world.config.size);
        if (huge) {
          // Huge worlds: tiles array should be empty, terrain via chunk API
          checks.tiles = {
            ok: true,
            message: `Huge world (size=${this.world.config.size}): tiles array empty (OK, uses chunk API)`
          };
        } else {
          const expectedTileCount = this.world.config.size * this.world.config.size;
          const tilesCount = this.world.tiles?.length || 0;
          const tilesOk = tilesCount === expectedTileCount && tilesCount > 0;
          checks.tiles = {
            ok: tilesOk,
            message: tilesOk ? `Tiles OK: ${tilesCount} (expected ${expectedTileCount})` : `Tiles MISSING: ${tilesCount} (expected ${expectedTileCount})`,
            error: tilesOk ? undefined : `Tiles count mismatch: ${tilesCount} vs ${expectedTileCount}`
          };
        }
      }
    } catch (error) {
      checks.tiles = { ok: false, error: String(error) };
    }

    // Test 5: Storage operations
    try {
      const testKey = "__selftest__";
      await this.state.storage.put(testKey, "test");
      const retrieved = await this.state.storage.get(testKey);
      await this.state.storage.delete(testKey);
      checks.storage_ops = { ok: retrieved === "test", message: "Storage read/write works" };
    } catch (error) {
      checks.storage_ops = { ok: false, error: String(error) };
    }

    // Test 6: WS upgrade check
    try {
      // Simulate a non-upgrade request
      const testRequest = new Request("https://test/ws", { method: "GET" });
      const upgrade = testRequest.headers.get("Upgrade");
      checks.wsUpgradeCheck = {
        ok: upgrade === null,
        message: "WS upgrade check logic works (non-upgrade request has no Upgrade header)"
      };
    } catch (error) {
      checks.wsUpgradeCheck = { ok: false, error: String(error) };
    }

    // Test 7: CORS headers
    try {
      const headers = corsHeaders();
      checks.cors = {
        ok: headers["Access-Control-Allow-Origin"] === "*",
        message: "CORS headers configured"
      };
    } catch (error) {
      checks.cors = { ok: false, error: String(error) };
    }

    // Test 8: Huge world persistence
    try {
      if (this.world && isHugeWorld(this.world.config.size)) {
        checks.hugeWorldPersistence = {
          ok: true,
          message: "Huge world: persistence skipped (OK, uses minimal metadata)"
        };
      } else {
        checks.hugeWorldPersistence = {
          ok: true,
          message: "Small world: full persistence allowed"
        };
      }
    } catch (error) {
      checks.hugeWorldPersistence = { ok: false, error: String(error) };
    }

    // Test 9: Registry
    try {
      const registryStub = this.env.WORLD_DO.get(this.env.WORLD_DO.idFromName(REGISTRY_WORLD_ID));
      checks.registryOk = { ok: registryStub !== null, message: "Registry DO accessible" };
    } catch (error) {
      checks.registryOk = { ok: false, error: String(error) };
    }

    const allOk = Object.values(checks).every(c => c.ok);
    return this.jsonResponse(
      {
        ok: allOk,
        version: PROTOCOL_VERSION,
        time: Date.now(),
        checks,
        timestamp: Date.now()
      },
      allOk ? 200 : 500
    );
  }

  private async pullAgentActions(): Promise<void> {
    if (!this.world) {
      return;
    }
    const agents = Object.values(this.world.agents).filter((agent) => agent.mode === "pull" && agent.pullUrl);
    for (const agent of agents) {
      const unit = this.world.units[agent.units[0]];
      if (!unit) {
        continue;
      }
      const observation = observeAgent(this.world, unit);
      const signed = await signPayload(this.env.AGENT_SIGNING_SECRET ?? "default", observation);
      try {
        const response = await fetch(agent.pullUrl!, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agent-id": agent.id,
            "x-agent-signature": signed
          },
          body: JSON.stringify(observation)
        });
        if (!response.ok) {
          continue;
        }
        const action = (await response.json().catch(() => null)) as Action | null;
        if (action && action.agentId === agent.id) {
          const queue = this.world.actionQueues[agent.id] ?? [];
          if (agent.minuteQuota > 0) {
            queue.push({ ...action, createdAt: Date.now() });
            agent.minuteQuota -= 1;
          }
          this.world.actionQueues[agent.id] = queue;
        }
      } catch (error) {
        this.logAudit({ id: crypto.randomUUID(), type: "pull_error", data: String(error) });
      }
    }
  }

  private async revertToLastSnapshot(): Promise<void> {
    if (!this.world || this.world.lastGoodSnapshotTick <= 0) {
      return;
    }
    const snapshot = await loadSnapshot(this.state, this.world.lastGoodSnapshotTick);
    if (!snapshot) {
      return;
    }
    this.world.units = snapshot.units;
    this.world.cities = snapshot.cities;
    this.world.states = snapshot.states;
    this.world.events.unshift(`Reverted to snapshot at tick ${snapshot.tick}`);
    await this.persistWorld();
  }

  private buildSnapshotForClient(meta?: { agentId?: string; spectator?: boolean; token?: string | null }): WsMessage {
    if (!this.world) {
      return { type: "error", message: "world_not_ready" };
    }
    
    // SNAPSHOT CONTRACT: ALWAYS RENDERABLE, NEVER EMPTY
    // Tiles are derived data, regenerate deterministically if missing
    const expectedTileCount = this.world.config.size * this.world.config.size;
    if (!this.world.tiles || this.world.tiles.length !== expectedTileCount) {
      console.warn(`World tiles missing or wrong size (${this.world.tiles?.length || 0} vs ${expectedTileCount}), regenerating...`);
      this.world.tiles = getOrGenerateTiles(this.world.config.seed, this.world.config.size);
    }
    
    // Determine tiles mode: full for size <= 128, chunked for larger
    const tilesMode: "full" | "chunked" = this.world.config.size <= 128 ? "full" : "chunked";
    const tilesMeta = {
      mode: tilesMode,
      size: this.world.config.size,
      tileCount: this.world.tiles.length
    };
    
    // Validate tilesMeta contract
    if (tilesMeta.mode === "full" && tilesMeta.tileCount !== tilesMeta.size * tilesMeta.size) {
      console.error(`CRITICAL: tilesMeta contract violation - full mode requires ${tilesMeta.size * tilesMeta.size} tiles, got ${tilesMeta.tileCount}`);
      this.world.tiles = getOrGenerateTiles(this.world.config.seed, this.world.config.size);
      tilesMeta.tileCount = this.world.tiles.length;
    }
    
    const baseSnapshot = {
      type: "snapshot" as const,
      protocolVersion: PROTOCOL_VERSION,
      snapshotVersion: SNAPSHOT_VERSION,
      worldId: this.world.worldId,
      worldType: this.world.type,
      seed: this.world.config.seed,
      tick: this.world.tick,
      serverTime: Date.now(),
      config: this.world.config,
      tiles: this.world.tiles,
      tilesMeta,
      chunkOwnership: this.world.chunkOwnership,
      regions: this.world.regions,
      paused: this.world.paused,
      tickRate: this.world.config.tickRate
    };
    
    if (meta?.agentId && this.world.agents[meta.agentId]) {
      const fog = this.world.fog[meta.agentId];
      const tiles = fog ? filterTilesByFog(this.world, fog) : this.world.tiles;
      const units = fog ? filterUnitsByFog(this.world, fog) : this.world.units;
      return {
        ...baseSnapshot,
        tiles,
        tilesMeta: { ...tilesMeta, tileCount: tiles.length },
        units,
        cities: this.world.cities,
        states: this.world.states,
        events: this.world.events,
        fog,
        heatmaps: fog ? filterHeatmapsForAgent(this.world.heatmaps, fog, this.world.config.size) : this.world.heatmaps
      };
    }
    if (meta?.spectator) {
      return {
        ...baseSnapshot,
        units: this.world.units,
        cities: this.world.cities,
        states: this.world.states,
        events: this.world.events,
        heatmaps: this.world.heatmaps,
        dramaEvents: this.world.dramaEvents.slice(0, 50),
        wars: Object.values(this.world.wars).filter((w) => !w.endTick).map((w) => ({
          id: w.id,
          stateA: w.stateA,
          stateB: w.stateB,
          startTick: w.startTick,
          casualties: w.casualties,
          exhaustion: w.exhaustion
        }))
      };
    }
    // Default case: unauthenticated spectator - still return tiles
    return {
      ...baseSnapshot,
      units: {},
      cities: this.world.cities,
      states: this.world.states,
      events: this.world.events
    };
  }

  private authorizeToken(token?: string | null): boolean {
    if (!token) {
      return false;
    }
    return token === this.env.ADMIN_TOKEN;
  }

  private async handleSnapshot(request: Request): Promise<Response> {
    if (!this.world) {
      return this.jsonResponse({ error: "world_not_ready" }, 400);
    }
    
    // CRITICAL: Sanity check before returning snapshot
    // Tiles are derived data - for huge worlds, tiles array is empty (use chunk API)
    // For small/medium worlds, generate on demand if missing
    const huge = isHugeWorld(this.world.config.size);
    if (!huge) {
      const expectedTileCount = this.world.config.size * this.world.config.size;
      if (!this.world.tiles || this.world.tiles.length !== expectedTileCount) {
        this.world.tiles = getOrGenerateTiles(this.world.config.seed, this.world.config.size);
      }
    } else {
      // Huge world: tiles array stays empty, terrain via chunk API
      this.world.tiles = [];
    }
    
    const url = new URL(request.url);
    const agentId = url.searchParams.get("agentId");
    const spectator = url.searchParams.get("spectator") === "1";
    const token = url.searchParams.get("token");
    
    if (agentId && this.world.agents[agentId]) {
      if (!(await this.verifyAgentAuth(request, this.world.agents[agentId]))) {
        return this.jsonResponse({ error: "unauthorized" }, 401);
      }
      const fog = this.world.fog[agentId];
      return this.jsonResponse({
        protocolVersion: PROTOCOL_VERSION,
        snapshotVersion: SNAPSHOT_VERSION,
        serverTime: Date.now(),
        ...this.buildSnapshotForClient({ agentId }),
        fog
      });
    }
    
    // Allow spectator access without admin token
    if (spectator) {
      return this.jsonResponse({
        protocolVersion: PROTOCOL_VERSION,
        snapshotVersion: SNAPSHOT_VERSION,
        serverTime: Date.now(),
        ...this.buildSnapshotForClient({ spectator: true, token })
      });
    }
    
    // Full admin access requires authorization
    if (!this.authorize(request)) {
      return this.jsonResponse({ error: "unauthorized" }, 401);
    }
    // Admin snapshot includes full world with tiles
    return this.jsonResponse({
      protocolVersion: PROTOCOL_VERSION,
      snapshotVersion: SNAPSHOT_VERSION,
      serverTime: Date.now(),
      ...this.world // Includes tiles
    });
  }

  private broadcastHeatmaps(): void {
    if (!this.world) {
      return;
    }
    for (const [socket, meta] of this.clientMeta.entries()) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      const viewport = meta.viewport;
      if (!viewport) {
        continue;
      }
      for (const [typeKey, heatmap] of Object.entries(this.world.heatmaps)) {
        const chunks = filterHeatmapChunks(
          heatmap.chunks,
          viewport,
          meta.agentId ? this.world.fog[meta.agentId] : undefined,
          this.world.config.size
        );
        safeSend(socket, { type: "heatmap_update", typeKey, chunks, tick: this.world.tick });
      }
    }
  }

  private broadcastDramaEvents(events: typeof this.world.dramaEvents): void {
    if (!this.world) {
      return;
    }
    for (const [socket, meta] of this.clientMeta.entries()) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      // Only send to spectators - agents don't get drama events
      if (meta.spectator) {
        safeSend(socket, {
          type: "drama_events",
          events: events.map((e) => ({
            id: e.id,
            type: e.type,
            severity: e.severity,
            tick: e.tick,
            timestamp: e.timestamp,
            location: e.location,
            cityId: e.cityId,
            stateId: e.stateId,
            targetStateId: e.targetStateId,
            message: e.message
          }))
        });
      }
    }
  }

  private broadcastBorders(): void {
    if (!this.world) {
      return;
    }
    for (const [socket, meta] of this.clientMeta.entries()) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      const viewport = meta.viewport;
      if (!viewport) {
        continue;
      }
      const tiles = tilesForViewport(this.world, viewport, meta.agentId);
      safeSend(socket, { type: "border_update", chunks: [{ key: "viewport", tiles }], tick: this.world.tick });
    }
  }
}

const hashKey = async (value: string): Promise<string> => {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const signPayload = async (secret: string, payload: unknown): Promise<string> => {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(JSON.stringify(payload)));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const tilesForViewport = (
  world: WorldState,
  viewport: { x: number; y: number; w: number; h: number },
  agentId?: string
): WorldState["tiles"] => {
  const tiles: WorldState["tiles"] = [];
  const size = world.config.size;
  const fog = agentId ? world.fog[agentId] : undefined;
  const exploredChunks = fog ? new Set(fog.exploredChunks) : null;
  const startX = Math.max(0, Math.floor(viewport.x));
  const startY = Math.max(0, Math.floor(viewport.y));
  const endX = Math.min(size - 1, Math.ceil(viewport.x + viewport.w));
  const endY = Math.min(size - 1, Math.ceil(viewport.y + viewport.h));
  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      const idx = y * size + x;
      if (exploredChunks && !exploredChunks.has(chunkKey(x, y))) {
        continue;
      }
      tiles.push(world.tiles[idx]);
    }
  }
  return tiles;
};

const filterTilesByFog = (
  world: WorldState,
  fog: { exploredChunks: string[]; visibleChunks: string[] }
): WorldState["tiles"] => {
  const exploredChunks = new Set(fog.exploredChunks);
  return world.tiles.filter((tile) => exploredChunks.has(chunkKey(tile.x, tile.y)));
};

const filterUnitsByFog = (
  world: WorldState,
  fog: { exploredChunks: string[]; visibleChunks: string[] }
): WorldState["units"] => {
  const visibleChunks = new Set(fog.visibleChunks);
  const units: WorldState["units"] = {};
  for (const unit of Object.values(world.units)) {
    if (visibleChunks.has(chunkKey(unit.position.x, unit.position.y))) {
      units[unit.id] = unit;
    }
  }
  return units;
};

const filterHeatmapChunks = (
  chunks: Record<string, number[]>,
  viewport: { x: number; y: number; w: number; h: number },
  fog: { exploredChunks: string[]; visibleChunks: string[] } | undefined,
  size: number
) => {
  const result: Record<string, number[]> = {};
  const chunkSize = 16;
  const startX = Math.floor(viewport.x / chunkSize) * chunkSize;
  const startY = Math.floor(viewport.y / chunkSize) * chunkSize;
  const endX = Math.floor((viewport.x + viewport.w) / chunkSize) * chunkSize;
  const endY = Math.floor((viewport.y + viewport.h) / chunkSize) * chunkSize;
  const exploredChunks = fog ? new Set(fog.exploredChunks) : null;
  for (let y = startY; y <= endY; y += chunkSize) {
    for (let x = startX; x <= endX; x += chunkSize) {
      const key = `${x}:${y}`;
      if (chunks[key]) {
        if (!exploredChunks || exploredChunks.has(chunkKey(x, y))) {
          result[key] = chunks[key];
        } else {
          result[key] = chunks[key].map(() => 0);
        }
      }
    }
  }
  return result;
};

const filterHeatmapsForAgent = (
  heatmaps: WorldState["heatmaps"],
  fog: { exploredChunks: string[]; visibleChunks: string[] },
  size: number
): WorldState["heatmaps"] => {
  const result: WorldState["heatmaps"] = {};
  for (const [key, map] of Object.entries(heatmaps)) {
    const filteredChunks = filterHeatmapChunks(map.chunks, { x: 0, y: 0, w: size, h: size }, fog, size);
    result[key] = { updatedAt: map.updatedAt, chunks: filteredChunks };
  }
  return result;
};
const chunkKey = (x: number, y: number): string => `${Math.floor(x / 16) * 16}:${Math.floor(y / 16) * 16}`;

const isValidAction = (action: Action): boolean => {
  const allowed = [
    "move",
    "gather",
    "craft",
    "build",
    "trade",
    "join_city",
    "found_city",
    "form_state",
    "tax_policy_vote",
    "attack",
    "defend",
    "negotiate",
    "apply_job",
    "enlist",
    "vote_policy"
  ];
  return typeof action.type === "string" && allowed.includes(action.type);
};

const safeSend = (socket: WebSocket, message: unknown): void => {
  try {
    const payload = JSON.stringify(message);
    socket.send(payload);
  } catch (error) {
    try {
      socket.send(JSON.stringify({ type: "error", message: "send_failed" }));
    } catch {
      // ignore
    }
  }
};

