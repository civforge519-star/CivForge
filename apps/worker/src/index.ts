import type { Action, Agent, AgentObservation, Unit, WorldState } from "./types";
import { createWorld, createInventory } from "./world";
import { observeAgent, tickWorld } from "./simulation";
import { generateRegions, generateWorldMap } from "./worldgen";
import { initStorage, loadSnapshot, loadWorldState, saveSnapshot, saveWorldState } from "./storage/persistence";
import { sanitizeWorld } from "./rules/sanity";

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
const REGISTRY_WORLD_ID = "__registry__";
const PROTOCOL_VERSION = "1.1";
const SNAPSHOT_VERSION = 2;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
    initStorage(this.state);
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, data TEXT NOT NULL)"
    );
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
    } else {
      const size = Number(this.env.WORLD_SIZE ?? 128);
      const tickRate = Number(this.env.TICK_RATE ?? 1);
      const seed = this.worldId;
      // Ensure public world always uses DEFAULT_WORLD_ID
      const finalWorldId = this.worldId === DEFAULT_WORLD_ID || this.worldId === "public" ? DEFAULT_WORLD_ID : this.worldId;
      this.world = createWorld(finalWorldId, seed, size, tickRate, finalWorldId === DEFAULT_WORLD_ID ? "public" : "sandbox");
      this.worldId = finalWorldId;
      await this.persistWorld();
    }
    await this.scheduleNextTick();
  }

  async fetch(request: Request): Promise<Response> {
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
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,x-admin-token,authorization"
        }
      });
    }

    if (pathname === "/health") {
      return this.jsonResponse({ ok: true });
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

    return new Response("Not found", { status: 404 });
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
        const data = JSON.parse(String(event.data)) as { type: string; viewport?: { x: number; y: number; w: number; h: number; lod: number } };
        if (data.type === "ping") {
          safeSend(server, { type: "pong", tick: this.world?.tick ?? 0 });
          return;
        }
        if (data.type === "subscribe" && data.viewport) {
          const meta = this.clientMeta.get(server) ?? {};
          this.clientMeta.set(server, { ...meta, viewport: data.viewport });
          if (this.world) {
            const tiles = tilesForViewport(this.world, data.viewport, meta.agentId);
            server.send(JSON.stringify({ type: "chunk_update", chunks: tiles, tick: this.world.tick }));
          }
        }
      } catch (error) {
        server.send(JSON.stringify({ type: "error", message: "invalid_message" }));
      }
    });

    if (this.world) {
      if (agentId && token && this.world.agents[agentId]) {
        this.verifyAgentAuthToken(token, this.world.agents[agentId]).then((ok) => {
          if (!ok) {
            server.send(JSON.stringify({ type: "error", message: "unauthorized" }));
            server.close();
          }
        });
      }
      const snapshot = this.buildSnapshotForClient(this.clientMeta.get(server));
      safeSend(server, snapshot);
    }

    return new Response(null, {
      status: 101,
      webSocket: client
    });
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
    const token = request.headers.get("x-admin-token");
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
    await saveWorldState(this.state, this.world);
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
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,x-admin-token,authorization"
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

  private async handleWorldCreateFromRequest(request: Request): Promise<Response> {
    if (!this.world) {
      return this.jsonResponse({ error: "world_not_ready" }, 400);
    }
    const body = (await request.json().catch(() => ({}))) as {
      worldId?: string;
      seed?: string;
      type?: "public" | "sandbox";
      size?: number;
      tickRate?: number;
      config?: Partial<WorldState["config"]>;
    };
    const type = body.type ?? "sandbox";
    
    // Prevent creating public worlds via this endpoint - only sandbox allowed
    if (type === "public") {
      return this.jsonResponse({ error: "public_world_protected", message: "Public world is persistent and cannot be recreated" }, 403);
    }
    
    const size = body.size ?? this.world.config.size;
    const tickRate = body.tickRate ?? this.world.config.tickRate;
    const seed = body.seed ?? crypto.randomUUID();
    const worldId = body.worldId ?? `sandbox-${crypto.randomUUID()}`;
    this.world = createWorld(worldId, seed, size, tickRate, type, body.config ?? {});
    await this.persistWorld();
    return this.jsonResponse({ status: "created", worldId, seed, type });
  }

  private logAudit(entry: { id: string; type: string; data: unknown }): void {
    this.state.storage.sql.exec("INSERT OR REPLACE INTO audit_logs (id, data) VALUES (?, ?)", [
      entry.id,
      JSON.stringify(entry)
    ]);
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
    if (meta?.agentId && this.world.agents[meta.agentId]) {
      const fog = this.world.fog[meta.agentId];
      const tiles = fog ? filterTilesByFog(this.world, fog) : this.world.tiles;
      const units = fog ? filterUnitsByFog(this.world, fog) : this.world.units;
      return {
        type: "snapshot",
        protocolVersion: PROTOCOL_VERSION,
        snapshotVersion: SNAPSHOT_VERSION,
        worldId: this.world.worldId,
        worldType: this.world.type,
        seed: this.world.config.seed,
        tick: this.world.tick,
        serverTime: Date.now(),
        config: this.world.config,
        tiles,
        chunkOwnership: this.world.chunkOwnership,
        regions: this.world.regions,
        units,
        cities: this.world.cities,
        states: this.world.states,
        events: this.world.events,
        paused: this.world.paused,
        tickRate: this.world.config.tickRate,
        fog,
        heatmaps: fog ? filterHeatmapsForAgent(this.world.heatmaps, fog, this.world.config.size) : this.world.heatmaps
      };
    }
    if (meta?.spectator && this.authorizeToken(meta.token)) {
      const tiles = this.world.tiles;
      const units = this.world.units;
      return {
        type: "snapshot",
        protocolVersion: PROTOCOL_VERSION,
        snapshotVersion: SNAPSHOT_VERSION,
        worldId: this.world.worldId,
        worldType: this.world.type,
        seed: this.world.config.seed,
        tick: this.world.tick,
        serverTime: Date.now(),
        config: this.world.config,
        tiles: this.world.tiles,
        chunkOwnership: this.world.chunkOwnership,
        regions: this.world.regions,
        units: this.world.units,
        cities: this.world.cities,
        states: this.world.states,
        events: this.world.events,
        paused: this.world.paused,
        tickRate: this.world.config.tickRate,
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
    return {
      type: "snapshot",
      protocolVersion: PROTOCOL_VERSION,
      snapshotVersion: SNAPSHOT_VERSION,
      worldId: this.world.worldId,
      worldType: this.world.type,
      seed: this.world.config.seed,
      tick: this.world.tick,
      serverTime: Date.now(),
      config: this.world.config,
      tiles: [],
      chunkOwnership: this.world.chunkOwnership,
      regions: this.world.regions,
      units: {},
      cities: this.world.cities,
      states: this.world.states,
      events: this.world.events,
      paused: this.world.paused,
      tickRate: this.world.config.tickRate
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
    const url = new URL(request.url);
    const agentId = url.searchParams.get("agentId");
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
    if (!this.authorize(request)) {
      return this.jsonResponse({ error: "unauthorized" }, 401);
    }
    return this.jsonResponse({
      protocolVersion: PROTOCOL_VERSION,
      snapshotVersion: SNAPSHOT_VERSION,
      serverTime: Date.now(),
      ...this.world
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

