import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { buildHttpBase, buildWsUrl, safeParseJson } from "./net";
import { createCamera, screenToWorld, updateCamera, worldToScreen, clamp, resetToFit } from "./camera";
import { drawBorders, drawFog, drawOverlay, getChunkCanvas, drawCheckerboard } from "./renderer";

type Biome =
  | "ocean"
  | "coast"
  | "plains"
  | "forest"
  | "desert"
  | "tundra"
  | "snow"
  | "mountain"
  | "river";

type Position = { x: number; y: number };
type Tile = {
  x: number;
  y: number;
  elevation: number;
  temperature: number;
  humidity: number;
  biome: Biome;
  river: boolean;
  ownerCityId?: string;
  ownerStateId?: string;
  contested?: boolean;
};
type Unit = { id: string; agentId: string; role: string; position: Position; hp: number; stamina: number };
type City = {
  id: string;
  name: string;
  center: Position;
  population: number;
  territoryRadius: number;
  storage?: { food: number; wood: number; stone: number; iron: number; tools: number; weapons: number; gold: number };
  buildings?: Record<string, number>;
  policies?: Record<string, number>;
  security?: number;
  level?: string;
  stateId?: string;
};
type State = { id: string; name: string; capitalCityId: string };
type AgentInfo = {
  id: string;
  name: string;
  role: string;
  units: string[];
  reputation: number;
  minuteQuota: number;
  banned: boolean;
  worldId: string;
};

type DramaEvent = {
  id: string;
  type: "famine" | "city_collapse" | "war_declared" | "war_ended" | "revolt" | "alliance" | "migration" | "capital_fallen" | "peace_treaty" | "city_captured";
  severity: "minor" | "major" | "global";
  tick: number;
  timestamp: number;
  location?: Position;
  cityId?: string;
  stateId?: string;
  targetStateId?: string;
  message: string;
};

type AgentStory = {
  agentId: string;
  birthTick: number;
  citiesLived: string[];
  warsJoined: string[];
  migrations: Array<{ from: string; to: string; tick: number }>;
  majorEvents: Array<{ tick: number; event: string }>;
  lastUpdated: number;
};

type WorldState = {
  worldId: string;
  tick: number;
  type?: "public" | "sandbox";
  config: { seed: string; size: number; tickRate: number; fogOfWar?: boolean; visionRadius?: number };
  tiles: Array<Tile | null>;
  chunkOwnership?: Record<string, { cityId?: string; stateId?: string; contested?: boolean }>;
  regions: { id: string; name: string; type: "continent" | "sea"; center: Position }[];
  units: Record<string, Unit>;
  cities: Record<string, City>;
  states: Record<string, State>;
  events: string[];
  paused: boolean;
  fog?: { exploredChunks: string[]; visibleChunks: string[] };
  heatmaps?: Record<string, { updatedAt: number; chunks: Record<string, number[]> }>;
  dramaEvents?: DramaEvent[];
  wars?: Array<{ id: string; stateA: string; stateB: string; startTick: number; casualties: number; exhaustion: number }>;
};

type SnapshotMessage = {
  type: "snapshot";
  protocolVersion: string;
  snapshotVersion?: number;
  worldId: string;
  worldType?: "public" | "sandbox";
  seed: string;
  tick: number;
  serverTime: number;
  config: WorldState["config"];
  tiles: Tile[];
  chunkOwnership?: Record<string, { cityId?: string; stateId?: string; contested?: boolean }>;
  regions: WorldState["regions"];
  units: WorldState["units"];
  cities: WorldState["cities"];
  states: WorldState["states"];
  events: string[];
  paused: boolean;
  tickRate: number;
  fog?: { exploredChunks: string[]; visibleChunks: string[] };
  heatmaps?: WorldState["heatmaps"];
  dramaEvents?: DramaEvent[];
  wars?: Array<{ id: string; stateA: string; stateB: string; startTick: number; casualties: number; exhaustion: number }>;
};

type TickMessage = {
  type: "tick";
  tick: number;
  serverTime: number;
  units: WorldState["units"];
  cities: WorldState["cities"];
  states: WorldState["states"];
  events: string[];
};

type LobbyResponse = { worlds: string[] };
type WorldSummary = { worldId: string; seed?: string; type?: string; size?: number; tickRate?: number; createdAt?: number };

const biomeColors: Record<Biome, string> = {
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

const CHUNK_SIZE = 16;
const decodeChunkSet = (chunks?: string[] | null): Set<string> | null => {
  if (!chunks) {
    return null;
  }
  return new Set(chunks);
};
const App = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);
  const [world, setWorld] = useState<WorldState | null>(null);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const [speed, setSpeed] = useState(1);
  // Single global world - humans observe the persistent "public" world
  const [worldId] = useState("public");
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  // Sandbox creation only (admin-only, separate from global world)
  const [newWorldId, setNewWorldId] = useState("");
  const [newWorldSeed, setNewWorldSeed] = useState("");
  const [newWorldType, setNewWorldType] = useState<"public" | "sandbox">("sandbox");
  const [newWorldSize, setNewWorldSize] = useState("128");
  const [newWorldTickRate, setNewWorldTickRate] = useState("1");
  const [selected, setSelected] = useState<{ type: "tile" | "unit" | "city"; id?: string; position?: Position } | null>(
    null
  );
  const [hoverPos, setHoverPos] = useState<Position | null>(null);
  const [followAgent, setFollowAgent] = useState(false);
  const [followAgentId, setFollowAgentId] = useState<string | null>(null);
  const [followSmoothness, setFollowSmoothness] = useState<"low" | "medium" | "high">("medium");
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [dramaEvents, setDramaEvents] = useState<DramaEvent[]>([]);
  const [dramaFilter, setDramaFilter] = useState<"all" | "war" | "collapse" | "revolt" | "migration">("all");
  const [dramaSeverityFilter, setDramaSeverityFilter] = useState<"all" | "minor" | "major" | "global">("all");
  const [pinnedEvent, setPinnedEvent] = useState<string | null>(null);
  const [autoFocus, setAutoFocus] = useState(false);
  const [lastAutoFocus, setLastAutoFocus] = useState(0);
  const [selectedAgentStory, setSelectedAgentStory] = useState<AgentStory | null>(null);
  const [agentSearch, setAgentSearch] = useState("");
  const [showTimeline, setShowTimeline] = useState(true);
  const [showAgentPanel, setShowAgentPanel] = useState(false);
  const [wsDebug, setWsDebug] = useState<{ lastType?: string; lastSize?: number }>({});
  const [overlay, setOverlay] = useState<"biome" | "borders" | "food" | "wealth" | "danger" | "density" | "trade" | "state">(
    "biome"
  );
  const [quality, setQuality] = useState<"low" | "medium" | "high">("high");
  const [showFogDebug, setShowFogDebug] = useState(false);
  // Humans are always spectators - agents connect externally via API
  const spectatorMode = true;
  const [agents, setAgents] = useState<Record<string, AgentInfo>>({});
  const [agentLogs, setAgentLogs] = useState<Record<string, { actions: Array<{ action: any; status: string; reason?: string }>; lastObservationSize: number }>>(
    {}
  );
  const [godX, setGodX] = useState("");
  const [godY, setGodY] = useState("");
  const [godBiome, setGodBiome] = useState("");
  const [godElevation, setGodElevation] = useState("");
  const [godEvent, setGodEvent] = useState("");

  const HTTP_BASE = buildHttpBase(import.meta.env.VITE_HTTP_URL ?? "http://127.0.0.1:8787");
  const WS_URL_RAW = import.meta.env.VITE_WS_URL ?? "ws://127.0.0.1:8787/ws";
  const buildId = import.meta.env.VITE_BUILD_ID ?? "dev";
  const reconnectAttempts = useRef(0);
  const chunkCache = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const camera = useRef(createCamera());
  const wsRef = useRef<WebSocket | null>(null);
  const lastViewport = useRef<string>("");
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchState = useRef<{ distance: number; zoom: number } | null>(null);
  const needsRender = useRef(true);
  const lastPong = useRef(Date.now());
  const canvasSize = useRef({ width: 0, height: 0 });
  const lastRenderError = useRef<string | null>(null);
  const lastSnapshotTime = useRef<number | null>(null);
  const hasFittedCamera = useRef(false);
  const lastTickRef = useRef(0);

  const resolvedWsUrl = useMemo(() => buildWsUrl(WS_URL_RAW), [WS_URL_RAW]);

  const adminToken = import.meta.env.VITE_ADMIN_TOKEN ?? "";

  const aliveCount = useMemo(() => (world ? Object.keys(world.units).length : 0), [world]);
  const citiesCount = useMemo(() => (world ? Object.keys(world.cities).length : 0), [world]);
  const exploredChunks = useMemo(() => decodeChunkSet(world?.fog?.exploredChunks), [world?.fog?.exploredChunks]);
  const visibleChunks = useMemo(() => decodeChunkSet(world?.fog?.visibleChunks), [world?.fog?.visibleChunks]);

  const fetchWorlds = useCallback(async () => {
    try {
      const response = await fetch(`${HTTP_BASE}/worlds`);
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as { worlds: WorldSummary[] };
      setWorlds(data.worlds ?? []);
    } catch (error) {
      console.error("Failed to fetch worlds", error);
    }
  }, [HTTP_BASE]);

  const fetchAgents = useCallback(async () => {
    try {
      const response = await fetch(`${HTTP_BASE}/admin/agents?worldId=${worldId}`, {
        headers: { "x-admin-token": adminToken }
      });
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as { agents: Record<string, AgentInfo>; logs: Record<string, any> };
      setAgents(data.agents ?? {});
      setAgentLogs(data.logs ?? {});
    } catch (error) {
      console.error("Failed to fetch agents", error);
    }
  }, [HTTP_BASE, worldId, adminToken]);

  const createWorldRequest = useCallback(async () => {
    try {
      // Only allow creating sandbox worlds
      const worldId = newWorldId || `sandbox-${crypto.randomUUID()}`;
      await fetch(`${HTTP_BASE}/worlds`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": adminToken
        },
        body: JSON.stringify({
          worldId: worldId.startsWith("sandbox-") ? worldId : `sandbox-${worldId}`,
          seed: newWorldSeed || undefined,
          type: "sandbox", // Force sandbox type
          size: Number(newWorldSize),
          tickRate: Number(newWorldTickRate)
        })
      });
      setNewWorldId("");
      setNewWorldSeed("");
      setNewWorldType("sandbox");
      setNewWorldSize("128");
      setNewWorldTickRate("1");
      fetchWorlds();
    } catch (error) {
      console.error("Failed to create world", error);
    }
  }, [HTTP_BASE, adminToken, newWorldId, newWorldSeed, newWorldSize, newWorldTickRate, fetchWorlds]);

  const fetchSnapshot = useCallback(async () => {
    try {
      const url = new URL(`${HTTP_BASE}/world/snapshot`);
      url.searchParams.set("worldId", worldId);
      url.searchParams.set("spectator", "1");
      // Spectator mode - no admin token needed
      const response = await fetch(url.toString());
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as WorldState & { tickRate?: number; tiles?: Tile[] };
      const size = data.config?.size ?? 128;
      const tiles = new Array<Tile | null>(size * size).fill(null);
      if (data.tiles) {
        for (const tile of data.tiles) {
          tiles[tile.y * size + tile.x] = tile;
        }
      }
      setWorld({ ...data, tiles, chunkOwnership: data.chunkOwnership });
      needsRender.current = true;
      setEvents(data.events ?? []);
      setSpeed(data.config?.tickRate ?? 1);
    } catch (error) {
      console.error("Failed to fetch snapshot", error);
    }
  }, [HTTP_BASE, worldId]);

  const connectWs = useCallback(() => {
    const url = new URL(resolvedWsUrl);
    url.searchParams.set("worldId", worldId);
    // Humans always connect as spectators
    url.searchParams.set("spectator", "1");
    if (adminToken) {
      url.searchParams.set("token", adminToken);
    }
    const socket = new WebSocket(url.toString());
    let reconnectTimer: number | null = null;
    wsRef.current = socket;

    let heartbeat: number | null = null;
    socket.onopen = () => {
      reconnectAttempts.current = 0;
      setConnected(true);
      const viewport = getViewport();
      socket.send(JSON.stringify({ type: "subscribe", viewport }));
      lastPong.current = Date.now();
      if (heartbeat) {
        window.clearInterval(heartbeat);
      }
      heartbeat = window.setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }
        socket.send(JSON.stringify({ type: "ping" }));
        if (Date.now() - lastPong.current > 30000) {
          socket.close();
        }
      }, 10000);
    };
    socket.onmessage = (event) => {
      try {
        const parsed = safeParseJson<
          | SnapshotMessage
          | TickMessage
          | { type: "chunk_update"; chunks: Tile[] }
          | { type: "heatmap_update"; typeKey: string; chunks: Record<string, number[]> }
          | { type: "border_update"; chunks: Array<{ key: string; tiles: Tile[] }> }
          | { type: "drama_events"; events: DramaEvent[] }
          | { type: "pong" }
        >(event.data);
        
        // WS Debug tracking
        if (parsed) {
          setWsDebug({ lastType: parsed.type, lastSize: JSON.stringify(event.data).length });
        }
        if (!parsed) {
          return;
        }
        if (parsed.type === "pong") {
          lastPong.current = Date.now();
          return;
        }
        const message = parsed;
        if (message.type === "snapshot") {
          const size = message.config.size;
          const tiles = new Array<Tile | null>(size * size).fill(null);
          for (const tile of message.tiles) {
            tiles[tile.y * size + tile.x] = tile;
          }
          setWorld({
            worldId: message.worldId,
            type: message.worldType,
            tick: message.tick,
            config: message.config,
            tiles,
            chunkOwnership: message.chunkOwnership,
            regions: message.regions,
            units: message.units,
            cities: message.cities,
            states: message.states,
            events: message.events,
            paused: message.paused,
            fog: message.fog,
            heatmaps: message.heatmaps,
            dramaEvents: message.dramaEvents,
            wars: message.wars
          });
          setEvents(message.events ?? []);
          // Initialize drama events from snapshot
          if (message.dramaEvents) {
            setDramaEvents(message.dramaEvents);
          }
          setSpeed(message.tickRate ?? 1);
          setLastUpdate(Date.now());
          lastTickRef.current = message.tick;
          needsRender.current = true;
          return;
        }
        if (message.type === "tick") {
          if (message.tick <= lastTickRef.current) {
            return;
          }
          lastTickRef.current = message.tick;
          setWorld((prev) =>
            prev
              ? {
                  ...prev,
                  tick: message.tick,
                  units: message.units,
                  cities: message.cities,
                  states: message.states,
                  events: message.events
                }
              : prev
          );
          setEvents(message.events ?? []);
          setLastUpdate(Date.now());
          needsRender.current = true;
          return;
        }
        if (message.type === "chunk_update") {
          setWorld((prev) => {
            if (!prev) {
              return prev;
            }
            const tiles = [...prev.tiles];
            for (const tile of message.chunks) {
              tiles[tile.y * prev.config.size + tile.x] = tile;
            }
            return { ...prev, tiles };
          });
          needsRender.current = true;
          return;
        }
        if (message.type === "border_update") {
          setWorld((prev) => {
            if (!prev) {
              return prev;
            }
            const tiles = [...prev.tiles];
            for (const chunk of message.chunks) {
              for (const tile of chunk.tiles) {
                tiles[tile.y * prev.config.size + tile.x] = tile;
              }
            }
            return { ...prev, tiles };
          });
          needsRender.current = true;
          return;
        }
        if (message.type === "heatmap_update") {
          setWorld((prev) => {
            if (!prev) {
              return prev;
            }
            const heatmaps = { ...(prev.heatmaps ?? {}) };
            heatmaps[message.typeKey] = {
              updatedAt: prev.tick,
              chunks: {
                ...(heatmaps[message.typeKey]?.chunks ?? {}),
                ...message.chunks
              }
            };
            return { ...prev, heatmaps };
          });
          needsRender.current = true;
          return;
        }
        if (message.type === "drama_events") {
          setDramaEvents((prev) => {
            const existingIds = new Set(prev.map((e) => e.id));
            const newEvents = message.events.filter((e) => !existingIds.has(e.id));
            const merged = [...newEvents, ...prev];
            // Cap at 200 events
            return merged.slice(0, 200);
          });
          
          // Auto-focus on major/global events if enabled
          if (autoFocus && message.events.length > 0) {
            const now = Date.now();
            if (now - lastAutoFocus > 5000) { // 5 second cooldown
              const majorEvent = message.events.find((e) => e.severity === "major" || e.severity === "global");
              if (majorEvent && majorEvent.location && !followAgent) {
                setLastAutoFocus(now);
                // Smooth pan to event location
                const cam = camera.current;
                const targetX = majorEvent.location.x;
                const targetY = majorEvent.location.y;
                cam.x = targetX;
                cam.y = targetY;
                if (cam.zoom < 1.0) {
                  cam.zoom = 1.0;
                }
                needsRender.current = true;
              }
            }
          }
          needsRender.current = true;
          return;
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
      if (heartbeat) {
        window.clearInterval(heartbeat);
      }
      const attempt = Math.min(reconnectAttempts.current + 1, 6);
      reconnectAttempts.current = attempt;
      const delay = Math.min(1000 * 2 ** attempt, 15000);
      reconnectTimer = window.setTimeout(connectWs, delay);
    };
    socket.onerror = () => socket.close();

    return () => {
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      if (heartbeat) {
        window.clearInterval(heartbeat);
      }
      socket.close();
    };
  }, [resolvedWsUrl, worldId, adminToken]);

  useEffect(() => {
    fetchWorlds();
  }, [fetchWorlds]);

  useEffect(() => {
    fetchSnapshot();
  }, [fetchSnapshot]);

  useEffect(() => {
    needsRender.current = true;
  }, [overlay, quality, showFogDebug, followAgent]);

  useEffect(() => {
    console.log("CivForge URLs", { HTTP_BASE, WS: resolvedWsUrl, buildId });
    const cleanup = connectWs();
    return () => cleanup();
  }, [connectWs, HTTP_BASE, resolvedWsUrl, buildId]);

  useEffect(() => {
    if (!world || !canvasRef.current) {
      return;
    }
    chunkCache.current.clear();
    
    // Auto-fit camera on first world load
    if (!hasFittedCamera.current && canvasSize.current.width > 0 && canvasSize.current.height > 0) {
      resetToFit(camera.current, world.config.size, canvasSize.current.width, canvasSize.current.height);
      hasFittedCamera.current = true;
    } else {
      camera.current.x = world.config.size / 2;
      camera.current.y = world.config.size / 2;
    }
    
    renderMinimap(world);
    needsRender.current = true;
    lastSnapshotTime.current = Date.now();
  }, [world?.worldId]);

  // ResizeObserver for canvas sizing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          canvasSize.current = { width, height };
          needsRender.current = true;
        }
      }
    });
    
    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    let animationFrame: number;
    let lastFrame = 0;
    const renderLoop = () => {
      try {
        const now = performance.now();
        const cap = quality === "low" ? 20 : quality === "medium" ? 40 : camera.current.zoom < 0.6 ? 30 : 60;
        const cam = camera.current;
        const moving = Math.abs(cam.vx) > 0.01 || Math.abs(cam.vy) > 0.01;
        if ((needsRender.current || moving) && now - lastFrame >= 1000 / cap) {
          drawWorld();
          needsRender.current = false;
          lastFrame = now;
        }
      } catch (error) {
        console.error("Render loop error:", error);
        lastRenderError.current = String(error);
      }
      // Always continue the loop, never stop
      animationFrame = requestAnimationFrame(renderLoop);
    };
    animationFrame = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(animationFrame);
  }, [world, followAgent, followAgentId, followSmoothness, selected, quality, pinnedEvent]);

  const callAdmin = async (path: string, body?: Record<string, number | string | undefined>) => {
    try {
      await fetch(`${HTTP_BASE}${path}?worldId=${worldId}`, {
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

  const centerOnEvent = (event: DramaEvent) => {
    if (event.location) {
      const cam = camera.current;
      cam.x = event.location.x;
      cam.y = event.location.y;
      if (cam.zoom < 1.0) {
        cam.zoom = 1.0;
      }
      needsRender.current = true;
    }
  };

  const fetchAgentStory = useCallback(async (agentId: string) => {
    try {
      const response = await fetch(`${HTTP_BASE}/agent/${agentId}/story?worldId=${worldId}`);
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as { story: AgentStory };
      return data.story;
    } catch (error) {
      console.error("Failed to fetch agent story", error);
      return null;
    }
  }, [HTTP_BASE, worldId]);

  const handleSelectAgent = async (agentId: string) => {
    const unit = Object.values(world?.units ?? {}).find((u) => u.agentId === agentId);
    if (unit) {
      setSelected({ type: "unit", id: unit.id, position: unit.position });
      setFollowAgentId(agentId);
      setShowAgentPanel(true);
      const story = await fetchAgentStory(agentId);
      if (story) {
        setSelectedAgentStory(story);
      }
    }
  };

  const getEventIcon = (type: DramaEvent["type"]): string => {
    switch (type) {
      case "war_declared": return "⚔️";
      case "war_ended": return "🕊️";
      case "city_collapse": return "💥";
      case "capital_fallen": return "🏰";
      case "revolt": return "🔥";
      case "migration": return "🚶";
      case "alliance": return "🤝";
      case "peace_treaty": return "📜";
      case "famine": return "🌾";
      case "city_captured": return "🏛️";
      default: return "📢";
    }
  };

  const filteredDramaEvents = useMemo(() => {
    let filtered = dramaEvents;
    if (dramaFilter !== "all") {
      filtered = filtered.filter((e) => {
        if (dramaFilter === "war") return e.type.includes("war") || e.type === "capital_fallen" || e.type === "city_captured";
        if (dramaFilter === "collapse") return e.type === "city_collapse" || e.type === "famine";
        if (dramaFilter === "revolt") return e.type === "revolt";
        if (dramaFilter === "migration") return e.type === "migration";
        return true;
      });
    }
    if (dramaSeverityFilter !== "all") {
      filtered = filtered.filter((e) => e.severity === dramaSeverityFilter);
    }
    return filtered;
  }, [dramaEvents, dramaFilter, dramaSeverityFilter]);

  const getViewport = () => {
    const canvas = canvasRef.current;
    if (!canvas || !world) {
      return { x: 0, y: 0, w: 0, h: 0, lod: 1 };
    }
    const rect = canvas.getBoundingClientRect();
    const cam = camera.current;
    const halfW = rect.width / (2 * cam.zoom);
    const halfH = rect.height / (2 * cam.zoom);
    return {
      x: Math.max(0, cam.x - halfW),
      y: Math.max(0, cam.y - halfH),
      w: halfW * 2,
      h: halfH * 2,
      lod: cam.zoom < 0.6 ? 0 : cam.zoom < 1.4 ? 1 : 2
    };
  };

  const renderMinimap = (worldState: WorldState) => {
    const canvas = minimapRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const size = worldState.config.size;
    canvas.width = 200;
    canvas.height = 200;
    const scale = canvas.width / size;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const tile of worldState.tiles) {
      if (!tile) {
        continue;
      }
      ctx.fillStyle = biomeColors[tile.biome];
      ctx.fillRect(tile.x * scale, tile.y * scale, scale, scale);
    }
  };

  const drawWorld = () => {
    try {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }
      
      // Update canvas size from stored size (set by ResizeObserver)
      const dpr = window.devicePixelRatio || 1;
      const width = canvasSize.current.width || canvas.getBoundingClientRect().width;
      const height = canvasSize.current.height || canvas.getBoundingClientRect().height;
      
      if (width <= 0 || height <= 0) {
        // Schedule retry if size is invalid
        setTimeout(() => needsRender.current = true, 100);
        return;
      }
      
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      
      // Clear with visible background
      ctx.fillStyle = "#0b0f14";
      ctx.fillRect(0, 0, width, height);
      
      // Draw checkerboard fallback if no world or tiles missing
      const hasTiles = world && world.tiles && world.tiles.length > 0;
      if (!world || !hasTiles) {
        drawCheckerboard(ctx, width, height, 32);
        ctx.fillStyle = "#ffffff";
        ctx.font = "16px Inter";
        ctx.textAlign = "center";
        ctx.fillText(world ? "Waiting for tiles..." : "Waiting for world...", width / 2, height / 2);
        
        // Still draw agents as dots if we have world but no tiles
        if (world && world.units) {
          const worldSize = world.config?.size || 128;
          const normalizedSize = Math.min(width, height) * 0.8;
          const scale = normalizedSize / worldSize;
          const offsetX = (width - normalizedSize) / 2;
          const offsetY = (height - normalizedSize) / 2;
          
          for (const unit of Object.values(world.units)) {
            const x = offsetX + unit.position.x * scale;
            const y = offsetY + unit.position.y * scale;
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        
        // Update debug
        if (typeof window !== "undefined") {
          (window as any).__CIVFORGE_DEBUG__ = {
            world: world ? { worldId: world.worldId, tick: world.tick } : null,
            tilesCount: hasTiles ? world.tiles.length : 0,
            agentsCount: world ? Object.keys(world.units).length : 0,
            camera: { x: camera.current.x, y: camera.current.y, zoom: camera.current.zoom },
            zoom: camera.current.zoom,
            lastSnapshot: lastSnapshotTime.current,
            lastRenderError: lastRenderError.current,
            canvasSize: { width, height },
            dpr
          };
        }
        
        lastRenderError.current = null;
        return;
      }

    // Follow agent mode
    let followPos: Position | undefined = undefined;
    if (followAgent && followAgentId) {
      const unit = Object.values(world.units).find((u) => u.agentId === followAgentId);
      if (unit) {
        followPos = unit.position;
      } else {
        // Agent unit not found, disable follow
        setFollowAgent(false);
        setFollowAgentId(null);
      }
    } else if (followAgent && selected?.type === "unit" && selected.id && world.units[selected.id]) {
      followPos = world.units[selected.id].position;
      setFollowAgentId(world.units[selected.id].agentId);
    }
    
    // Smooth follow with configurable smoothness
    if (followPos) {
      const cam = camera.current;
      const smoothFactor = followSmoothness === "low" ? 0.3 : followSmoothness === "medium" ? 0.15 : 0.08;
      cam.x += (followPos.x - cam.x) * smoothFactor;
      cam.y += (followPos.y - cam.y) * smoothFactor;
      // Auto-zoom if too far out
      if (cam.zoom < 0.8) {
        cam.zoom = Math.min(1.2, cam.zoom + 0.02);
      }
    }
    
    updateCamera(camera.current, world.config.size, width, height, followPos);

    const cam = camera.current;
    const halfW = width / (2 * cam.zoom);
    const halfH = height / (2 * cam.zoom);
    const view = {
      left: Math.max(0, cam.x - halfW),
      top: Math.max(0, cam.y - halfH),
      right: Math.min(world.config.size, cam.x + halfW),
      bottom: Math.min(world.config.size, cam.y + halfH)
    };
    const viewportKey = `${Math.floor(view.left)}:${Math.floor(view.top)}:${Math.floor(view.right)}:${Math.floor(
      view.bottom
    )}:${cam.zoom.toFixed(2)}`;
    if (viewportKey !== lastViewport.current && wsRef.current?.readyState === WebSocket.OPEN) {
      lastViewport.current = viewportKey;
      wsRef.current.send(
        JSON.stringify({
          type: "subscribe",
          viewport: {
            x: view.left,
            y: view.top,
            w: view.right - view.left,
            h: view.bottom - view.top,
            lod: cam.zoom < 0.6 ? 0 : cam.zoom < 1.4 ? 1 : 2
          }
        })
      );
    }

    const startChunkX = Math.floor(view.left / CHUNK_SIZE);
    const startChunkY = Math.floor(view.top / CHUNK_SIZE);
    const endChunkX = Math.floor(view.right / CHUNK_SIZE);
    const endChunkY = Math.floor(view.bottom / CHUNK_SIZE);

    for (let cy = startChunkY; cy <= endChunkY; cy += 1) {
      for (let cx = startChunkX; cx <= endChunkX; cx += 1) {
        const chunkCanvas = getChunkCanvas(world, cx, cy, CHUNK_SIZE, chunkCache.current, biomeColors);
        const screenX = (cx * CHUNK_SIZE - view.left) * cam.zoom;
        const screenY = (cy * CHUNK_SIZE - view.top) * cam.zoom;
        ctx.drawImage(chunkCanvas, screenX, screenY, CHUNK_SIZE * cam.zoom, CHUNK_SIZE * cam.zoom);
      }
    }

    if (quality !== "low") {
      if (overlay !== "biome" && overlay !== "borders") {
        drawOverlay(ctx, view, cam.zoom, overlay, world.heatmaps, CHUNK_SIZE);
      }
      if (overlay === "borders") {
        drawBorders(ctx, view, cam.zoom, CHUNK_SIZE, world.chunkOwnership ?? {});
      }
    }

    if (world.config.fogOfWar && exploredChunks && visibleChunks) {
      drawFog(
        ctx,
        view,
        cam.zoom,
        CHUNK_SIZE,
        exploredChunks,
        visibleChunks,
        showFogDebug,
        selected?.position ?? null,
        world.config.visionRadius ?? 6
      );
    }

    // Draw drama event markers
    if (quality !== "low" && world.dramaEvents && cam.zoom > 0.8) {
      const recentEvents = world.dramaEvents.filter((e) => world.tick - e.tick < 100 && e.location);
      for (const event of recentEvents.slice(0, 20)) {
        if (!event.location) continue;
        const pos = worldToScreen(event.location, view, cam.zoom);
        if (pos.x < -20 || pos.x > width + 20 || pos.y < -20 || pos.y > height + 20) continue;
        
        // Draw event pulse effect
        const age = world.tick - event.tick;
        if (age < 10) {
          const pulseRadius = (age / 10) * 15;
          ctx.strokeStyle = event.severity === "global" ? "rgba(255,93,93,0.6)" : event.severity === "major" ? "rgba(255,165,0,0.6)" : "rgba(78,161,255,0.6)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, pulseRadius, 0, Math.PI * 2);
          ctx.stroke();
        }
        
        // Draw event icon
        ctx.fillStyle = event.severity === "global" ? "#ff5d5d" : event.severity === "major" ? "#ffa500" : "#4ea1ff";
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    
    // Draw war zones
    if (quality !== "low" && world.wars && cam.zoom > 0.6) {
      for (const war of world.wars) {
        const stateA = world.states[war.stateA];
        const stateB = world.states[war.stateB];
        if (stateA && stateB) {
          const capitalA = world.cities[stateA.capitalCityId];
          const capitalB = world.cities[stateB.capitalCityId];
          if (capitalA) {
            const pos = worldToScreen(capitalA.center, view, cam.zoom);
            ctx.strokeStyle = "rgba(255,93,93,0.8)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
            ctx.stroke();
          }
          if (capitalB) {
            const pos = worldToScreen(capitalB.center, view, cam.zoom);
            ctx.strokeStyle = "rgba(255,93,93,0.8)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
    }

    if (quality !== "low" && cam.zoom > 1.2) {
      for (const city of Object.values(world.cities)) {
        const pos = worldToScreen(city.center, view, cam.zoom);
        ctx.fillStyle = "#f2c94c";
        ctx.fillRect(pos.x - 4, pos.y - 4, 8, 8);
        ctx.fillStyle = "#0b0f14";
        ctx.fillText(city.name, pos.x + 6, pos.y);
      }
      for (const unit of Object.values(world.units)) {
        const pos = worldToScreen(unit.position, view, cam.zoom);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (quality !== "low" && cam.zoom <= 0.7) {
      for (const state of Object.values(world.states)) {
        const capital = world.cities[state.capitalCityId];
        if (!capital) {
          continue;
        }
        const pos = worldToScreen(capital.center, view, cam.zoom);
        ctx.fillStyle = "#f2c94c";
        ctx.fillText(state.name, pos.x + 4, pos.y);
      }
    }

    if (selected?.position) {
      const pos = worldToScreen(selected.position, view, cam.zoom);
      ctx.strokeStyle = "#ffcc00";
      ctx.lineWidth = 2;
      ctx.strokeRect(pos.x - 6, pos.y - 6, 12, 12);
    }
    
    // Highlight pinned event
    if (pinnedEvent && world.dramaEvents) {
      const event = world.dramaEvents.find((e) => e.id === pinnedEvent);
      if (event && event.location) {
        const pos = worldToScreen(event.location, view, cam.zoom);
        ctx.strokeStyle = "#ffcc00";
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 20, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    
    // Update debug object
    if (typeof window !== "undefined") {
      (window as any).__CIVFORGE_DEBUG__ = {
        world: { worldId: world.worldId, tick: world.tick, size: world.config.size },
        tilesCount: world.tiles?.length || 0,
        agentsCount: Object.keys(world.units || {}).length,
        camera: { x: cam.x, y: cam.y, zoom: cam.zoom },
        zoom: cam.zoom,
        lastSnapshot: lastSnapshotTime.current,
        lastRenderError: lastRenderError.current,
        canvasSize: { width, height },
        dpr
      };
    }
    
    lastRenderError.current = null;
    } catch (error) {
      console.error("Render error:", error);
      lastRenderError.current = String(error);
      
      // Still try to show something
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const width = canvasSize.current.width || 800;
          const height = canvasSize.current.height || 600;
          drawCheckerboard(ctx, width, height, 32);
          ctx.fillStyle = "#ff5d5d";
          ctx.font = "14px Inter";
          ctx.textAlign = "center";
          ctx.fillText("Render Error: " + String(error).substring(0, 50), width / 2, height / 2);
        }
      }
      
      // Update debug with error
      if (typeof window !== "undefined") {
        (window as any).__CIVFORGE_DEBUG__ = {
          ...((window as any).__CIVFORGE_DEBUG__ || {}),
          lastRenderError: String(error)
        };
      }
    }
  };

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const cam = camera.current;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) {
      cam.isDragging = true;
      cam.lastX = event.clientX;
      cam.lastY = event.clientY;
    }
    if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      pinchState.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: cam.zoom };
    }
  };

  const handleCanvasPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const cam = camera.current;
    if (!pointers.current.has(event.pointerId)) {
      return;
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2 && pinchState.current) {
      const [a, b] = Array.from(pointers.current.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const scale = distance / pinchState.current.distance;
      cam.zoom = clamp(pinchState.current.zoom * scale, 0.3, 4);
      return;
    }
    if (cam.isDragging) {
      const dx = event.clientX - cam.lastX;
      const dy = event.clientY - cam.lastY;
      cam.lastX = event.clientX;
      cam.lastY = event.clientY;
      cam.vx = -dx / cam.zoom / 6;
      cam.vy = -dy / cam.zoom / 6;
      cam.x += -dx / cam.zoom;
      cam.y += -dy / cam.zoom;
      needsRender.current = true;
    }
    if (canvasRef.current && world) {
      const rect = canvasRef.current.getBoundingClientRect();
      setHoverPos(screenToWorld(event.clientX - rect.left, event.clientY - rect.top, camera.current, world.config.size, rect));
    }
  };

  const handleCanvasPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const cam = camera.current;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) {
      pinchState.current = null;
    }
    cam.isDragging = false;
    if (event.type === "pointerup" && world) {
      const rect = (event.target as HTMLCanvasElement).getBoundingClientRect();
      const pos = screenToWorld(event.clientX - rect.left, event.clientY - rect.top, camera.current, world.config.size, rect);
      selectAt(pos);
    }
  };

  const handleWheel = useCallback((event: WheelEvent) => {
    event.preventDefault();
    const cam = camera.current;
    const delta = -event.deltaY * 0.001;
    cam.zoom = clamp(cam.zoom + delta, 0.3, 4);
    needsRender.current = true;
  }, []);

  // Native wheel event listener with passive: false for preventDefault
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", handleWheel);
    };
  }, [handleWheel]);

  const handleMinimapClick = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!world || !minimapRef.current) {
      return;
    }
    const rect = minimapRef.current.getBoundingClientRect();
    const scale = world.config.size / rect.width;
    const x = (event.clientX - rect.left) * scale;
    const y = (event.clientY - rect.top) * scale;
    camera.current.x = x;
    camera.current.y = y;
    needsRender.current = true;
  };

  const selectAt = (pos: Position) => {
    if (!world) {
      return;
    }
    const unit = Object.values(world.units).find(
      (item) => Math.abs(item.position.x - pos.x) <= 1 && Math.abs(item.position.y - pos.y) <= 1
    );
    if (unit) {
      setSelected({ type: "unit", id: unit.id, position: unit.position });
      needsRender.current = true;
      return;
    }
    const city = Object.values(world.cities).find(
      (item) => Math.abs(item.center.x - pos.x) <= 2 && Math.abs(item.center.y - pos.y) <= 2
    );
    if (city) {
      setSelected({ type: "city", id: city.id, position: city.center });
      needsRender.current = true;
      return;
    }
    setSelected({ type: "tile", position: pos });
    needsRender.current = true;
  };

  const getHeatValueAt = (pos: Position | null) => {
    if (!world || !pos || overlay === "biome" || overlay === "borders") {
      return null;
    }
    const heatmap = world.heatmaps?.[overlay];
    if (!heatmap) {
      return null;
    }
    const chunkSize = CHUNK_SIZE;
    const chunkX = Math.floor(pos.x / chunkSize) * chunkSize;
    const chunkY = Math.floor(pos.y / chunkSize) * chunkSize;
    const key = `${chunkX}:${chunkY}`;
    const values = heatmap.chunks[key];
    if (!values) {
      return null;
    }
    const index = (pos.y - chunkY) * chunkSize + (pos.x - chunkX);
    return values[index] ?? null;
  };

  return (
    <main>
      <h1>CivForge • Global Simulation Observer</h1>
      <div className="layout">
        <div>
          <canvas
            ref={canvasRef}
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={handleCanvasPointerUp}
            onPointerLeave={handleCanvasPointerUp}
          />
          <canvas
            ref={minimapRef}
            onPointerDown={handleMinimapClick}
            style={{ width: 200, height: 200, marginTop: 12, borderRadius: 8, cursor: "pointer" }}
          />
        </div>
        <section className="panel">
          <h2>Observer Dashboard</h2>
          <div className="stat">
            <span>World</span>
            <span style={{ color: "var(--accent)", flex: 1, marginLeft: 12 }}>
              {worldId} (Global Persistent World)
            </span>
          </div>
          <div className="controls">
            <button onClick={() => fetchSnapshot()}>Refresh View</button>
            <button onClick={() => fetchWorlds()}>Refresh Lobby</button>
            {world && canvasSize.current.width > 0 && (
              <button onClick={() => {
                resetToFit(camera.current, world.config.size, canvasSize.current.width, canvasSize.current.height);
                needsRender.current = true;
              }}>Reset View</button>
            )}
          </div>
          
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", color: "var(--muted)", fontSize: "0.9rem" }}>RENDER DEBUG</summary>
            <div style={{ marginTop: 8, fontSize: "0.85rem", color: "var(--muted)", fontFamily: "monospace" }}>
              <div>Canvas: {canvasSize.current.width}×{canvasSize.current.height}</div>
              <div>DPR: {window.devicePixelRatio || 1}</div>
              <div>World Size: {world?.config?.size || "N/A"}</div>
              <div>Tiles: {world?.tiles?.length || 0} {world?.tiles?.length ? "✓" : "✗"}</div>
              <div>Agents: {world ? Object.keys(world.units || {}).length : 0} {world && Object.keys(world.units || {}).length > 0 ? "✓" : "✗"}</div>
              <div>Last Snapshot: {lastSnapshotTime.current ? new Date(lastSnapshotTime.current).toLocaleTimeString() : "Never"}</div>
              <div>Camera: x={camera.current.x.toFixed(1)} y={camera.current.y.toFixed(1)} zoom={camera.current.zoom.toFixed(2)}</div>
              {lastRenderError.current && (
                <div style={{ color: "#ff5d5d", marginTop: 4 }}>Error: {lastRenderError.current.substring(0, 60)}</div>
              )}
            </div>
          </details>
          <div className="stat">
            <span>Mode</span>
            <span style={{ color: "var(--accent)" }}>Spectator (Read-Only)</span>
          </div>
          {adminToken ? (
            <>
              <h3>Create Sandbox (Admin Only)</h3>
              <div className="stat">
                <span>Sandbox ID</span>
                <input
                  value={newWorldId}
                  onChange={(event) => setNewWorldId(event.target.value)}
                  placeholder="sandbox-..."
                  style={{ flex: 1, marginLeft: 12 }}
                />
              </div>
              <div className="stat">
                <span>Seed</span>
                <input
                  value={newWorldSeed}
                  onChange={(event) => setNewWorldSeed(event.target.value)}
                  style={{ flex: 1, marginLeft: 12 }}
                />
              </div>
              <div className="stat">
                <span>Type</span>
                <span style={{ color: "var(--muted)" }}>Sandbox Only</span>
              </div>
              <div className="stat">
                <span>Size</span>
                <input value={newWorldSize} onChange={(event) => setNewWorldSize(event.target.value)} />
              </div>
              <div className="stat">
                <span>Tick Rate</span>
                <input value={newWorldTickRate} onChange={(event) => setNewWorldTickRate(event.target.value)} />
              </div>
              <div className="controls">
                <button onClick={() => createWorldRequest()}>Create Sandbox</button>
              </div>
            </>
          ) : null}
          <div className="events">
            {worlds.map((entry) => (
              <span key={entry.worldId}>
                {entry.worldId} ({entry.type ?? "public"}) seed {entry.seed ?? "—"}
              </span>
            ))}
          </div>
          <h2>World Status</h2>
          <div className="stat">
            <span>Status</span>
            <span style={{ color: world?.paused ? "#ff5d5d" : "#4ea1ff" }}>
              {world?.paused ? "Paused" : "Running"}
            </span>
          </div>
          <div className="stat">
            <span>World Type</span>
            <span>{world?.type ?? "public"}</span>
          </div>
          <div className="stat">
            <span>Fog</span>
            <span>{world?.config.fogOfWar ? "On" : "Off"}</span>
          </div>
          <div className="stat">
            <span>Tick</span>
            <span>{world?.tick ?? 0}</span>
          </div>
          <div className="stat">
            <span>Alive Units</span>
            <span>{aliveCount}</span>
          </div>
          <div className="stat">
            <span>Cities</span>
            <span>{citiesCount}</span>
          </div>
          <div className="stat">
            <span>Connection</span>
            <span>{connected ? "Live" : "Reconnecting"}</span>
          </div>
          <div className="stat">
            <span>Retries</span>
            <span>{reconnectAttempts.current}</span>
          </div>
          <div className="stat">
            <span>Zoom</span>
            <span>{camera.current.zoom.toFixed(2)}x</span>
          </div>
          <div className="stat">
            <span>Cursor</span>
            <span>{hoverPos ? `${hoverPos.x},${hoverPos.y}` : "—"}</span>
          </div>
          <div className="stat">
            <span>Tile</span>
            <span>
              {hoverPos && world
                ? (() => {
                    const tile = world.tiles[hoverPos.y * world.config.size + hoverPos.x];
                    if (!tile) {
                      return "Hidden";
                    }
                    return `${tile.biome}${tile.ownerStateId ? ` | ${tile.ownerStateId}` : ""}`;
                  })()
                : "—"}
            </span>
          </div>
          <div className="stat">
            <span>Last Update</span>
            <span>{lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : "—"}</span>
          </div>
          {adminToken ? (
            <>
              <h3>Admin Controls</h3>
              <div className="controls">
                <button onClick={() => callAdmin("/admin/pause")}>Pause</button>
                <button onClick={() => callAdmin("/admin/resume")}>Resume</button>
                {[1, 2, 5].map((rate) => (
                  <button key={rate} className={speed === rate ? "active" : ""} onClick={() => handleSpeed(rate)}>
                    x{rate}
                  </button>
                ))}
              </div>
              <div className="controls">
                <button onClick={() => setFollowAgent((prev) => !prev)}>
                  {followAgent ? "Unfollow" : "Follow Selected"}
                </button>
                {world?.type === "sandbox" ? (
                  <button onClick={() => callAdmin("/admin/reset", { seed: crypto.randomUUID() })}>Reset Sandbox</button>
                ) : null}
                <button className={showFogDebug ? "active" : ""} onClick={() => setShowFogDebug((prev) => !prev)}>
                  Fog Debug
                </button>
                {world?.type === "sandbox" ? (
                  <button onClick={() => callAdmin("/admin/step", { ticks: 10 })}>Step x10</button>
                ) : null}
              </div>
            </>
          ) : null}
          <div className="controls">
            <button className={quality === "low" ? "active" : ""} onClick={() => setQuality("low")}>
              Quality Low
            </button>
            <button className={quality === "medium" ? "active" : ""} onClick={() => setQuality("medium")}>
              Quality Med
            </button>
            <button className={quality === "high" ? "active" : ""} onClick={() => setQuality("high")}>
              Quality High
            </button>
          </div>
          <h2>Overlays</h2>
          <div className="controls">
            {["biome", "borders", "food", "wealth", "danger", "density", "trade", "state"].map((key) => (
              <button key={key} className={overlay === key ? "active" : ""} onClick={() => setOverlay(key as any)}>
                {key}
              </button>
            ))}
          </div>
          
          <h2>Drama Timeline {showTimeline ? "▼" : "▶"}</h2>
          <div className="controls">
            <button onClick={() => setShowTimeline(!showTimeline)}>
              {showTimeline ? "Hide" : "Show"} Timeline
            </button>
            <button className={autoFocus ? "active" : ""} onClick={() => setAutoFocus(!autoFocus)}>
              Auto-Focus
            </button>
          </div>
          {showTimeline ? (
            <>
              <div className="controls" style={{ flexWrap: "wrap", gap: "4px" }}>
                <button className={dramaFilter === "all" ? "active" : ""} onClick={() => setDramaFilter("all")}>
                  All
                </button>
                <button className={dramaFilter === "war" ? "active" : ""} onClick={() => setDramaFilter("war")}>
                  War
                </button>
                <button className={dramaFilter === "collapse" ? "active" : ""} onClick={() => setDramaFilter("collapse")}>
                  Collapse
                </button>
                <button className={dramaFilter === "revolt" ? "active" : ""} onClick={() => setDramaFilter("revolt")}>
                  Revolt
                </button>
                <button className={dramaFilter === "migration" ? "active" : ""} onClick={() => setDramaFilter("migration")}>
                  Migration
                </button>
              </div>
              <div className="controls" style={{ flexWrap: "wrap", gap: "4px" }}>
                <button className={dramaSeverityFilter === "all" ? "active" : ""} onClick={() => setDramaSeverityFilter("all")}>
                  All Severity
                </button>
                <button className={dramaSeverityFilter === "minor" ? "active" : ""} onClick={() => setDramaSeverityFilter("minor")}>
                  Minor
                </button>
                <button className={dramaSeverityFilter === "major" ? "active" : ""} onClick={() => setDramaSeverityFilter("major")}>
                  Major
                </button>
                <button className={dramaSeverityFilter === "global" ? "active" : ""} onClick={() => setDramaSeverityFilter("global")}>
                  Global
                </button>
              </div>
              <div className="events" style={{ maxHeight: "300px", overflowY: "auto" }}>
                {filteredDramaEvents.length === 0 ? (
                  <span style={{ color: "var(--muted)" }}>No events yet</span>
                ) : (
                  filteredDramaEvents.slice(0, 50).map((event) => (
                    <div
                      key={event.id}
                      style={{
                        padding: "8px",
                        marginBottom: "4px",
                        background: pinnedEvent === event.id ? "rgba(78,161,255,0.2)" : "rgba(16,20,28,0.5)",
                        borderRadius: "4px",
                        cursor: "pointer",
                        borderLeft: `3px solid ${
                          event.severity === "global" ? "#ff5d5d" : event.severity === "major" ? "#ffa500" : "#4ea1ff"
                        }`
                      }}
                      onClick={() => {
                        centerOnEvent(event);
                        if (pinnedEvent === event.id) {
                          setPinnedEvent(null);
                        } else {
                          setPinnedEvent(event.id);
                        }
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "18px" }}>{getEventIcon(event.type)}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: "bold", fontSize: "13px" }}>{event.message}</div>
                          <div style={{ fontSize: "11px", color: "var(--muted)", marginTop: "2px" }}>
                            Tick {event.tick} • {new Date(event.timestamp).toLocaleTimeString()}
                            {event.severity && (
                              <span
                                style={{
                                  marginLeft: "8px",
                                  padding: "2px 6px",
                                  borderRadius: "3px",
                                  background:
                                    event.severity === "global"
                                      ? "rgba(255,93,93,0.3)"
                                      : event.severity === "major"
                                      ? "rgba(255,165,0,0.3)"
                                      : "rgba(78,161,255,0.3)"
                                }}
                              >
                                {event.severity}
                              </span>
                            )}
                          </div>
                        </div>
                        {pinnedEvent === event.id && <span>📌</span>}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : null}
          
          <h2>Agent Follow Mode</h2>
          <div className="controls">
            <button className={followAgent ? "active" : ""} onClick={() => {
              if (followAgent) {
                setFollowAgent(false);
                setFollowAgentId(null);
              } else if (selected?.type === "unit" && selected.id) {
                const unit = world?.units[selected.id];
                if (unit) {
                  setFollowAgent(true);
                  setFollowAgentId(unit.agentId);
                }
              }
            }}>
              {followAgent ? "Stop Following" : "Follow Selected"}
            </button>
            {followAgent && (
              <button onClick={() => {
                const unit = Object.values(world?.units ?? {}).find((u) => u.agentId === followAgentId);
                if (unit) {
                  const cam = camera.current;
                  cam.x = unit.position.x;
                  cam.y = unit.position.y;
                  needsRender.current = true;
                }
              }}>
                Focus
              </button>
            )}
          </div>
          {followAgent && (
            <div className="stat">
              <span>Smoothness</span>
              <div className="controls">
                <button className={followSmoothness === "low" ? "active" : ""} onClick={() => setFollowSmoothness("low")}>
                  Low
                </button>
                <button className={followSmoothness === "medium" ? "active" : ""} onClick={() => setFollowSmoothness("medium")}>
                  Med
                </button>
                <button className={followSmoothness === "high" ? "active" : ""} onClick={() => setFollowSmoothness("high")}>
                  High
                </button>
              </div>
            </div>
          )}
          
          <h2>Agent Story {showAgentPanel ? "▼" : "▶"}</h2>
          <div className="controls">
            <button onClick={() => setShowAgentPanel(!showAgentPanel)}>
              {showAgentPanel ? "Hide" : "Show"} Panel
            </button>
          </div>
          {showAgentPanel ? (
            <>
              <div className="stat">
                <span>Search Agent</span>
                <input
                  value={agentSearch}
                  onChange={(e) => setAgentSearch(e.target.value)}
                  placeholder="Agent ID or name"
                  style={{ flex: 1, marginLeft: 12 }}
                />
              </div>
              <div className="events" style={{ maxHeight: "200px", overflowY: "auto" }}>
                {Object.values(agents)
                  .filter((a) => !agentSearch || a.id.includes(agentSearch) || a.name.toLowerCase().includes(agentSearch.toLowerCase()))
                  .slice(0, 20)
                  .map((agent) => (
                    <span
                      key={agent.id}
                      style={{ cursor: "pointer", display: "block", padding: "4px" }}
                      onClick={() => handleSelectAgent(agent.id)}
                    >
                      {agent.name} ({agent.role}) • {agent.units.length} units
                    </span>
                  ))}
              </div>
              {selectedAgentStory && (
                <div style={{ marginTop: "12px", padding: "8px", background: "rgba(16,20,28,0.5)", borderRadius: "4px" }}>
                  <h3 style={{ fontSize: "14px", marginBottom: "8px" }}>Story</h3>
                  <div style={{ fontSize: "12px" }}>
                    <div>Born: Tick {selectedAgentStory.birthTick}</div>
                    {selectedAgentStory.citiesLived.length > 0 && (
                      <div>Cities: {selectedAgentStory.citiesLived.length}</div>
                    )}
                    {selectedAgentStory.warsJoined.length > 0 && (
                      <div>Wars: {selectedAgentStory.warsJoined.length}</div>
                    )}
                    {selectedAgentStory.migrations.length > 0 && (
                      <div>Migrations: {selectedAgentStory.migrations.length}</div>
                    )}
                    {selectedAgentStory.majorEvents.length > 0 && (
                      <div style={{ marginTop: "8px" }}>
                        <strong>Events:</strong>
                        {selectedAgentStory.majorEvents.slice(0, 5).map((e, i) => (
                          <div key={i} style={{ fontSize: "11px", color: "var(--muted)", marginTop: "2px" }}>
                            T{e.tick}: {e.event}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : null}
          <div className="stat">
            <span>Legend</span>
            <span>{overlay === "biome" ? "Biome colors" : `${overlay} heatmap (0-1)`}</span>
          </div>
          {showFogDebug && hoverPos ? (
            <div className="stat">
              <span>Heat Value</span>
              <span>{getHeatValueAt(hoverPos)?.toFixed(2) ?? "—"}</span>
            </div>
          ) : null}
          <h2>Active Agents</h2>
          <div className="controls">
            <button onClick={() => fetchAgents()}>Refresh</button>
          </div>
          <div className="events">
            {Object.values(agents).length === 0 ? <span>No active agents.</span> : null}
            {Object.values(agents).map((agent) => (
              <span key={agent.id} style={{ cursor: "pointer" }} onClick={() => {
                handleSelectAgent(agent.id);
              }}>
                {agent.name} ({agent.role}) • {agent.units.length} units • Rep: {agent.reputation}
                {agent.banned ? " [BANNED]" : ""}
              </span>
            ))}
          </div>
          {selected?.type === "unit" && selected.id && world?.units[selected.id] ? (
            <>
              <h3>Selected Agent Unit</h3>
              <div className="events">
                {(() => {
                  const unit = world.units[selected.id!];
                  if (!unit) return null;
                  const logs = agentLogs[unit.agentId];
                  if (!logs?.actions?.length) return <span>No action history</span>;
                  return logs.actions.slice(0, 5).map((entry, index) => (
                    <span key={`${unit.agentId}-${index}`} style={{ 
                      color: entry.status === "accepted" ? "#4ea1ff" : "#ff5d5d" 
                    }}>
                      {entry.status}: {entry.action?.type} {entry.reason ? `(${entry.reason})` : ""}
                    </span>
                  ));
                })()}
              </div>
            </>
          ) : null}
          {adminToken && world?.type === "sandbox" ? (
            <>
              <h2>Sandbox Tools (Admin)</h2>
              <div className="stat">
                <span>X</span>
                <input value={godX} onChange={(event) => setGodX(event.target.value)} />
              </div>
              <div className="stat">
                <span>Y</span>
                <input value={godY} onChange={(event) => setGodY(event.target.value)} />
              </div>
              <div className="stat">
                <span>Biome</span>
                <input value={godBiome} onChange={(event) => setGodBiome(event.target.value)} />
              </div>
              <div className="stat">
                <span>Elevation</span>
                <input value={godElevation} onChange={(event) => setGodElevation(event.target.value)} />
              </div>
              <div className="controls">
                <button
                  onClick={() =>
                    callAdmin("/admin/paint", {
                      x: Number(godX),
                      y: Number(godY),
                      biome: godBiome || undefined,
                      elevation: godElevation ? Number(godElevation) : undefined
                    })
                  }
                >
                  Paint
                </button>
              </div>
              <div className="stat">
                <span>Event</span>
                <input value={godEvent} onChange={(event) => setGodEvent(event.target.value)} />
              </div>
              <div className="controls">
                <button onClick={() => callAdmin("/admin/event", { message: godEvent })}>Inject Event</button>
              </div>
            </>
          ) : null}
          <h2>Selection (Read-Only)</h2>
          <div className="events">
            {selected?.type === "city" && selected.id && world?.cities[selected.id] ? (
              <>
                <span>
                  <strong>{world.cities[selected.id].name}</strong>
                </span>
                <span>Population: {world.cities[selected.id].population}</span>
                <span>Territory Radius: {world.cities[selected.id].territoryRadius}</span>
                <span>Level: {world.cities[selected.id].level ?? "village"}</span>
                <span>Security: {world.cities[selected.id].security ?? 0}</span>
                <span>Buildings: {JSON.stringify(world.cities[selected.id].buildings ?? {})}</span>
                <span>Storage: {JSON.stringify(world.cities[selected.id].storage ?? {})}</span>
                {(() => {
                  const city = world.cities[selected.id!];
                  if (!city?.stateId) return null;
                  return <span>State: {world.states[city.stateId]?.name ?? city.stateId}</span>;
                })()}
              </>
            ) : selected?.type === "unit" && selected.id && world?.units[selected.id] ? (
              <>
                {(() => {
                  const unit = world.units[selected.id!];
                  if (!unit) return null;
                  return (
                    <>
                      <span>
                        <strong>Unit {selected.id.slice(0, 8)}</strong>
                      </span>
                      <span>Agent: {unit.agentId.slice(0, 8)}</span>
                      <span>HP: {unit.hp} / Stamina: {unit.stamina}</span>
                      <span>Position: ({unit.position.x}, {unit.position.y})</span>
                      <span>Role: {unit.role}</span>
                    </>
                  );
                })()}
              </>
            ) : selected?.type === "tile" && selected.position ? (
              <>
                <span>
                  <strong>Tile ({selected.position.x}, {selected.position.y})</strong>
                </span>
                {hoverPos && world ? (
                  <>
                    {(() => {
                      const idx = hoverPos.y * world.config.size + hoverPos.x;
                      const tile = world.tiles[idx];
                      if (!tile) return null;
                      return (
                        <>
                          <span>Biome: {tile.biome}</span>
                          {tile.ownerCityId ? <span>City: {world.cities[tile.ownerCityId]?.name ?? tile.ownerCityId}</span> : null}
                          {tile.ownerStateId ? <span>State: {world.states[tile.ownerStateId]?.name ?? tile.ownerStateId}</span> : null}
                          {tile.contested ? <span style={{ color: "#ff5d5d" }}>Contested</span> : null}
                        </>
                      );
                    })()}
                  </>
                ) : null}
              </>
            ) : (
              <span style={{ color: "var(--muted)" }}>Click on map to inspect</span>
            )}
          </div>
          <h2>Events</h2>
          <div className="events">
            {events.length === 0 ? <span>No events yet.</span> : null}
            {events.map((event, index) => (
              <span key={`${event}-${index}`}>{event}</span>
            ))}
          </div>
          <div className="stat">
            <span>Build</span>
            <span>{buildId}</span>
          </div>
        </section>
      </div>
    </main>
  );
};

export default App;

