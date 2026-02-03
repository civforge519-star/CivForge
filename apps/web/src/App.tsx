import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type TileType = "grass" | "forest" | "water" | "mountain";
type Position = { x: number; y: number };
type NPC = {
  id: string;
  hp: number;
  hunger: number;
  inventory: { food: number; wood: number };
  job: string;
  position: Position;
  alive: boolean;
};
type Home = { id: string; ownerId: string; position: Position; villageId?: string };
type Village = { id: string; name: string; center: Position; storage: { food: number; wood: number } };

type WorldPayload = {
  tick: number;
  size: number;
  tiles: TileType[][];
  npcs: NPC[];
  homes: Home[];
  villages: Village[];
  events: string[];
  paused?: boolean;
  tickRate?: number;
};

const tileColors: Record<TileType, string> = {
  grass: "#2d9c5b",
  forest: "#1e6b3a",
  water: "#2463a6",
  mountain: "#6b717c"
};

const App = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [world, setWorld] = useState<WorldPayload | null>(null);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const [speed, setSpeed] = useState(1);

  const httpUrl = import.meta.env.VITE_HTTP_URL ?? "http://127.0.0.1:8787";
  const wsUrl = import.meta.env.VITE_WS_URL ?? "ws://127.0.0.1:8787/ws";
  const adminToken = import.meta.env.VITE_ADMIN_TOKEN ?? "";

  const aliveCount = useMemo(
    () => (world ? world.npcs.filter((npc) => npc.alive).length : 0),
    [world]
  );
  const villagesCount = useMemo(() => (world ? world.villages.length : 0), [world]);

  const fetchSnapshot = useCallback(async () => {
    try {
      const response = await fetch(`${httpUrl}/world/snapshot`);
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as WorldPayload;
      setWorld(data);
      setEvents(data.events ?? []);
      if (data.tickRate) {
        setSpeed(data.tickRate);
      }
    } catch (error) {
      console.error("Failed to fetch snapshot", error);
    }
  }, [httpUrl]);

  const connectWs = useCallback(() => {
    const socket = new WebSocket(wsUrl);
    let reconnectTimer: number | null = null;

    socket.onopen = () => setConnected(true);
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as { type: string; data: any };
        if (message.type === "init") {
          setWorld(message.data);
          setEvents(message.data.events ?? []);
          setSpeed(message.data.tickRate ?? 1);
          return;
        }
        if (message.type === "tick") {
          setWorld((prev) => (prev ? { ...prev, ...message.data } : message.data));
          setEvents(message.data.events ?? []);
        }
      } catch (error) {
        console.error("WS message error", error);
      }
    };
    socket.onclose = () => {
      setConnected(false);
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      reconnectTimer = window.setTimeout(connectWs, 1500);
    };
    socket.onerror = () => socket.close();

    return () => {
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      socket.close();
    };
  }, [wsUrl]);

  useEffect(() => {
    fetchSnapshot();
  }, [fetchSnapshot]);

  useEffect(() => {
    const cleanup = connectWs();
    return () => cleanup();
  }, [connectWs]);

  useEffect(() => {
    if (!world || !canvasRef.current) {
      return;
    }
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    const tileSize = rect.width / world.size;
    for (let y = 0; y < world.size; y += 1) {
      for (let x = 0; x < world.size; x += 1) {
        const tile = world.tiles?.[y]?.[x] ?? "grass";
        ctx.fillStyle = tileColors[tile];
        ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
      }
    }

    for (const village of world.villages) {
      ctx.fillStyle = "#f2c94c";
      ctx.fillRect(
        village.center.x * tileSize - tileSize,
        village.center.y * tileSize - tileSize,
        tileSize * 2,
        tileSize * 2
      );
    }

    for (const home of world.homes) {
      ctx.fillStyle = "#b07c4f";
      ctx.fillRect(home.position.x * tileSize, home.position.y * tileSize, tileSize, tileSize);
    }

    for (const npc of world.npcs) {
      if (!npc.alive) {
        continue;
      }
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(
        npc.position.x * tileSize + tileSize / 2,
        npc.position.y * tileSize + tileSize / 2,
        Math.max(2, tileSize / 3),
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  }, [world]);

  const callAdmin = async (path: string, body?: Record<string, number>) => {
    try {
      await fetch(`${httpUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": adminToken
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (error) {
      console.error("Admin request failed", error);
    }
  };

  const handleSpeed = async (nextSpeed: number) => {
    setSpeed(nextSpeed);
    await callAdmin("/admin/speed", { rate: nextSpeed });
  };

  return (
    <main>
      <h1>WorldBox Cloud MVP</h1>
      <div className="layout">
        <canvas ref={canvasRef} />
        <section className="panel">
          <h2>World Status</h2>
          <div className="stat">
            <span>Tick</span>
            <span>{world?.tick ?? 0}</span>
          </div>
          <div className="stat">
            <span>Alive NPCs</span>
            <span>{aliveCount}</span>
          </div>
          <div className="stat">
            <span>Villages</span>
            <span>{villagesCount}</span>
          </div>
          <div className="stat">
            <span>Connection</span>
            <span>{connected ? "Live" : "Reconnecting"}</span>
          </div>
          <div className="controls">
            <button onClick={() => callAdmin("/admin/pause")}>Pause</button>
            <button onClick={() => callAdmin("/admin/resume")}>Resume</button>
            {[1, 2, 5].map((rate) => (
              <button
                key={rate}
                className={speed === rate ? "active" : ""}
                onClick={() => handleSpeed(rate)}
              >
                x{rate}
              </button>
            ))}
          </div>
          <h2>Events</h2>
          <div className="events">
            {events.length === 0 ? <span>No events yet.</span> : null}
            {events.map((event, index) => (
              <span key={`${event}-${index}`}>{event}</span>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
};

export default App;

