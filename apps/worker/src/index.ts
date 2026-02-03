import type { WorldState } from "./types";
import { createWorld } from "./world";
import { tickWorld } from "./simulation";

type Env = {
  WORLD_DO: DurableObjectNamespace;
  ADMIN_TOKEN: string;
  WORLD_SIZE?: string;
  NPC_COUNT?: string;
  TICK_RATE?: string;
};

type WsMessage = { type: "init" | "tick"; data: any };

const WORLD_ID = "primary";
const STORAGE_KEY = "world_state";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const id = env.WORLD_DO.idFromName(WORLD_ID);
    const stub = env.WORLD_DO.get(id);

    if (pathname === "/ws" || pathname.startsWith("/admin") || pathname.startsWith("/world")) {
      return stub.fetch(request);
    }

    if (pathname === "/health") {
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
};

export class WorldDurableObject {
  private state: DurableObjectState;
  private env: Env;
  private world: WorldState | null = null;
  private clients = new Set<WebSocket>();
  private initPromise: Promise<void>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS world_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)"
    );

    const result = this.state.storage.sql.exec("SELECT data FROM world_state WHERE id = 1");
    const row = (result as { rows?: Array<{ data: string }> }).rows?.[0];

    if (row?.data) {
      this.world = JSON.parse(row.data) as WorldState;
    } else {
      const size = Number(this.env.WORLD_SIZE ?? 128);
      const npcCount = Number(this.env.NPC_COUNT ?? 50);
      const tickRate = Number(this.env.TICK_RATE ?? 1);
      this.world = createWorld(size, npcCount, tickRate);
      await this.persistWorld();
    }

    await this.scheduleNextTick();
  }

  async fetch(request: Request): Promise<Response> {
    await this.initPromise;
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "content-type": "application/json" }
      });
    }

    if (pathname === "/world/snapshot") {
      return Response.json(this.world);
    }

    if (pathname === "/ws") {
      return this.handleWebSocket();
    }

    if (pathname === "/admin/pause" && request.method === "POST") {
      if (!this.authorize(request)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      if (this.world) {
        this.world.paused = true;
        await this.persistWorld();
      }
      return Response.json({ status: "paused" });
    }

    if (pathname === "/admin/resume" && request.method === "POST") {
      if (!this.authorize(request)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      if (this.world) {
        this.world.paused = false;
        await this.persistWorld();
        await this.scheduleNextTick();
      }
      return Response.json({ status: "running" });
    }

    if (pathname === "/admin/speed" && request.method === "POST") {
      if (!this.authorize(request)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      const body = (await request.json().catch(() => ({}))) as { rate?: number };
      const nextRate = Number(body?.rate);
      if (!Number.isFinite(nextRate) || nextRate <= 0 || nextRate > 10) {
        return new Response(JSON.stringify({ error: "rate must be between 0 and 10" }), { status: 400 });
      }
      if (this.world) {
        this.world.tickRate = nextRate;
        await this.persistWorld();
        await this.scheduleNextTick();
      }
      return Response.json({ status: "ok", tickRate: this.world?.tickRate ?? nextRate });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.initPromise;
    if (!this.world) {
      return;
    }
    if (!this.world.paused) {
      tickWorld(this.world);
      if (this.world.tick % 10 === 0) {
        await this.persistWorld();
      }
      this.broadcast({
        type: "tick",
        data: {
          tick: this.world.tick,
          npcs: this.world.npcs,
          homes: this.world.homes,
          villages: this.world.villages,
          events: this.world.events,
          paused: this.world.paused,
          tickRate: this.world.tickRate
        }
      });
    }
    await this.scheduleNextTick();
  }

  private handleWebSocket(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    this.clients.add(server);
    server.addEventListener("close", () => {
      this.clients.delete(server);
    });

    if (this.world) {
      const initMessage: WsMessage = {
        type: "init",
        data: {
          size: this.world.size,
          tiles: this.world.tiles,
          tick: this.world.tick,
          tickRate: this.world.tickRate,
          npcs: this.world.npcs,
          homes: this.world.homes,
          villages: this.world.villages,
          events: this.world.events,
          paused: this.world.paused
        }
      };
      server.send(JSON.stringify(initMessage));
    }

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  private authorize(request: Request): boolean {
    const token = request.headers.get("x-admin-token");
    return Boolean(this.env.ADMIN_TOKEN && token && token === this.env.ADMIN_TOKEN);
  }

  private async scheduleNextTick(): Promise<void> {
    if (!this.world) {
      return;
    }
    const intervalMs = Math.max(200, Math.floor(1000 / this.world.tickRate));
    await this.state.storage.setAlarm(Date.now() + intervalMs);
  }

  private async persistWorld(): Promise<void> {
    if (!this.world) {
      return;
    }
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO world_state (id, data) VALUES (1, ?)",
      JSON.stringify(this.world)
    );
  }

  private broadcast(message: WsMessage): void {
    const payload = JSON.stringify(message);
    for (const socket of this.clients) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  }
}

