import type { Action, Agent, AgentObservation, City, Inventory, Tile, Unit, WorldState } from "./types";
import { clampPosition, createInventory } from "./world";
import { detectDramaEvents, updateWars, updateAgentStories, addDramaEvent } from "./drama";

const MAX_EVENTS = 50;
const CHUNK_SIZE = 16;
const BUILDING_TYPES = [
  "home",
  "storage",
  "farm",
  "lumberyard",
  "mine",
  "market",
  "barracks",
  "watchtower",
  "townhall"
];

export const tickWorld = (state: WorldState): { processed: Action[]; rejected: Array<{ action: Action; reason: string }> } => {
  if (state.paused) {
    return { processed: [], rejected: [] };
  }

  state.tick += 1;
  state.lastTickTime = Date.now();

  const processed: Action[] = [];
  const rejected: Array<{ action: Action; reason: string }> = [];

  for (const agent of Object.values(state.agents)) {
    if (agent.banned) {
      continue;
    }
    const queue = state.actionQueues[agent.id] ?? [];
    const limit = state.config.actionsPerTick;
    const toRun = queue.splice(0, limit);
    for (const action of toRun) {
      const result = applyAction(state, agent, action);
      if (result === true) {
        processed.push(action);
      } else {
        rejected.push({ action, reason: result });
        agent.reputation -= 1;
      }
    }
    state.actionQueues[agent.id] = queue;
  }

  updateEconomy(state);
  updateCities(state);
  if (state.tick % 2 === 0) {
    updateFogOfWar(state);
  }
  updateHeatmaps(state);
  updateTerritory(state);
  
  // Drama system: detect events and update wars
  const dramaEvents = detectDramaEvents(state);
  for (const event of dramaEvents) {
    addDramaEvent(state, event);
  }
  updateWars(state);
  
  if (state.type === "sandbox") {
    state.snapshots.unshift({
      tick: state.tick,
      units: structuredClone(state.units),
      cities: structuredClone(state.cities),
      states: structuredClone(state.states)
    });
    state.snapshots = state.snapshots.slice(0, 50);
  }

  return { processed, rejected };
};

export const sanitizeWorld = (state: WorldState): void => {
  const size = state.config.size;
  for (const unit of Object.values(state.units)) {
    if (!Number.isFinite(unit.position.x) || !Number.isFinite(unit.position.y)) {
      unit.position = { x: Math.floor(size / 2), y: Math.floor(size / 2) };
    }
    unit.position.x = clamp(unit.position.x, 0, size - 1);
    unit.position.y = clamp(unit.position.y, 0, size - 1);
    unit.hp = clamp(unit.hp, 0, 100);
    unit.stamina = clamp(unit.stamina, 0, 100);
    for (const key of Object.keys(unit.inventory)) {
      unit.inventory[key as keyof Inventory] = Math.max(0, unit.inventory[key as keyof Inventory] ?? 0);
    }
  }
};

export const applyAction = (state: WorldState, agent: Agent, action: Action): true | string => {
  const unit = action.unitId ? state.units[action.unitId] : undefined;
  if (action.agentId !== agent.id) {
    return "agent_mismatch";
  }
  if (unit && unit.agentId !== agent.id) {
    return "unit_not_owned";
  }

  switch (action.type) {
    case "move": {
      if (!unit) {
        return "unit_required";
      }
      const payload = action.payload as { dx?: number; dy?: number } | undefined;
      if (!payload || typeof payload.dx !== "number" || typeof payload.dy !== "number") {
        return "invalid_payload";
      }
      const next = clampPosition(
        { x: unit.position.x + payload.dx, y: unit.position.y + payload.dy },
        state.config.size
      );
      if (!canTraverse(tileAt(state, next), unit)) {
        return "terrain_blocked";
      }
      unit.position = next;
      unit.stamina = Math.max(0, unit.stamina - 1);
      return true;
    }
    case "gather": {
      if (!unit) {
        return "unit_required";
      }
      const tile = tileAt(state, unit.position);
      if (tile.biome === "forest") {
        unit.inventory.wood += 1;
      } else if (tile.biome === "mountain") {
        unit.inventory.stone += 1;
      } else if (tile.biome === "plains") {
        unit.inventory.food += 1;
      } else {
        return "no_resource";
      }
      return true;
    }
    case "build": {
      if (!unit) {
        return "unit_required";
      }
      const payload = action.payload as { building?: string; cityId?: string } | undefined;
      if (!payload?.building) {
        return "invalid_payload";
      }
      if (!BUILDING_TYPES.includes(payload.building)) {
        return "invalid_building";
      }
      const city = payload.cityId ? state.cities[payload.cityId] : undefined;
      if (!city) {
        return "city_required";
      }
      const tile = tileAt(state, unit.position);
      if (tile.ownerStateId && city.stateId && tile.ownerStateId !== city.stateId) {
        return "border_violation";
      }
      if (tile.ownerStateId && !city.stateId) {
        return "border_violation";
      }
      if (unit.inventory.wood < 5 || unit.inventory.stone < 2) {
        return "insufficient_resources";
      }
      unit.inventory.wood -= 5;
      unit.inventory.stone -= 2;
      city.buildQueue.push({
        id: crypto.randomUUID(),
        type: payload.building,
        progress: 0,
        required: 3
      });
      pushEvent(state, `${city.name} started ${payload.building}`);
      return true;
    }
    case "found_city": {
      if (!unit) {
        return "unit_required";
      }
      if (unit.inventory.wood < 10) {
        return "insufficient_resources";
      }
      const tile = tileAt(state, unit.position);
      if (tile.ownerStateId) {
        return "border_violation";
      }
      const name = (action.payload as { name?: string } | undefined)?.name ?? `City-${state.tick}`;
      const city: City = {
        id: crypto.randomUUID(),
        name,
        center: { ...unit.position },
        population: 1,
        storage: createInventory(true),
        taxRate: 0.05,
        buildings: { townhall: 1 },
        buildQueue: [],
        policies: { trade: 1, welfare: 1 },
        security: 1,
        housingCapacity: 5,
        attraction: 1,
        level: "village",
        territoryRadius: 4
      };
      state.cities[city.id] = city;
      unit.cityId = city.id;
      unit.inventory.wood -= 10;
      pushEvent(state, `${city.name} founded`);
      return true;
    }
    case "form_state": {
      if (!unit) {
        return "unit_required";
      }
      const payload = action.payload as { name?: string; cityIds?: string[] } | undefined;
      const cityIds = payload?.cityIds ?? [];
      if (cityIds.length < 2) {
        return "insufficient_cities";
      }
      const cities = cityIds.map((id) => state.cities[id]).filter(Boolean);
      if (cities.length < 2) {
        return "invalid_city";
      }
      const stateId = crypto.randomUUID();
      const newState = {
        id: stateId,
        name: payload?.name ?? `State-${state.tick}`,
        capitalCityId: cities[0].id,
        treasury: createInventory(true),
        policies: {
          taxRate: 0.1,
          tradeOpen: 1,
          conscription: 0,
          borderControl: 1,
          propertyRights: 1,
          welfare: 1
        },
        diplomacy: {},
        laws: {},
        relations: {}
      };
      state.states[stateId] = newState;
      for (const city of cities) {
        city.stateId = stateId;
      }
      pushEvent(state, `${newState.name} formed`);
      return true;
    }
    case "join_city": {
      if (!unit) {
        return "unit_required";
      }
      const payload = action.payload as { cityId?: string } | undefined;
      if (!payload?.cityId || !state.cities[payload.cityId]) {
        return "invalid_city";
      }
      unit.cityId = payload.cityId;
      state.cities[payload.cityId].population += 1;
      return true;
    }
    case "apply_job": {
      if (!unit) {
        return "unit_required";
      }
      const payload = action.payload as { job?: Unit["job"] } | undefined;
      if (!payload?.job) {
        return "invalid_payload";
      }
      unit.job = payload.job;
      return true;
    }
    case "trade":
    case "craft":
    case "tax_policy_vote":
    case "attack":
    case "defend":
    case "negotiate": {
      const payload = action.payload as { targetStateId?: string; status?: string; duration?: number } | undefined;
      if (!payload?.targetStateId || !payload.status) {
        return "invalid_payload";
      }
      const unitStateId = unit?.stateId;
      if (!unitStateId || !state.states[unitStateId] || !state.states[payload.targetStateId]) {
        return "invalid_state";
      }
      const treaty = {
        id: crypto.randomUUID(),
        stateA: unitStateId,
        stateB: payload.targetStateId,
        status: payload.status,
        expiresAt: state.tick + (payload.duration ?? 200)
      };
      state.treaties.push(treaty);
      state.states[unitStateId].diplomacy[payload.targetStateId] = payload.status;
      state.states[payload.targetStateId].diplomacy[unitStateId] = payload.status;
      pushEvent(state, `Treaty ${payload.status} signed`);
      return true;
    }
    case "enlist":
    case "vote_policy":
      return true;
    case "coordinate_alliance":
    case "coordinate_war":
    case "coordinate_trade": {
      // Secret coordination - log internally but don't expose publicly
      const payload = action.payload as { targetAgentId?: string; targetStateId?: string; votes?: number } | undefined;
      state.coordinationLogs.push({
        tick: state.tick,
        agentId: agent.id,
        type: action.type,
        targetId: payload?.targetAgentId ?? payload?.targetStateId
      });
      
      // Keep logs minimal
      if (state.coordinationLogs.length > 1000) {
        state.coordinationLogs = state.coordinationLogs.slice(-500);
      }
      
      // Process coordination if threshold met (e.g., 30 agents vote for war)
      if (action.type === "coordinate_war" && payload?.targetStateId) {
        const votes = state.coordinationLogs.filter(
          (log) => log.type === "coordinate_war" && log.targetId === payload.targetStateId && state.tick - log.tick < 100
        ).length;
        
        if (votes >= 30) {
          // Trigger war declaration
          const stateA = state.states[unit?.stateId ?? ""];
          const stateB = state.states[payload.targetStateId];
          if (stateA && stateB && stateA.id !== stateB.id) {
            stateA.relations[stateB.id] = "war";
            stateB.relations[stateA.id] = "war";
            pushEvent(state, `War declared: ${stateA.name} vs ${stateB.name} (coordinated)`);
          }
        }
      }
      
      return true;
    }
    default:
      return "unsupported_action";
  }
};

export const observeAgent = (state: WorldState, unit: Unit): AgentObservation => {
  const radius = state.config.visionRadius;
  const fog = state.fog[unit.agentId];
  const visibleChunks = fog ? new Set(fog.visibleChunks) : null;
  const nearbyTiles = state.tiles.filter((tile) => {
    if (!visibleChunks) {
      return Math.abs(tile.x - unit.position.x) <= radius && Math.abs(tile.y - unit.position.y) <= radius;
    }
    return visibleChunks.has(chunkKey(tile.x, tile.y));
  });
  const nearbyUnits = Object.values(state.units).filter(
    (other) =>
      other.id !== unit.id &&
      (visibleChunks
        ? visibleChunks.has(chunkKey(other.position.x, other.position.y))
        : Math.abs(other.position.x - unit.position.x) <= radius &&
          Math.abs(other.position.y - unit.position.y) <= radius)
  );
  const city = unit.cityId ? state.cities[unit.cityId] : undefined;
  return {
    protocolVersion: "1.0",
    worldId: state.worldId,
    tick: state.tick,
    unit,
    nearbyTiles,
    nearbyUnits,
    city,
    recentEvents: state.events.slice(0, 10)
  };
};

const updateEconomy = (state: WorldState): void => {
  for (const city of Object.values(state.cities)) {
    city.storage.food += Math.max(1, Math.floor(city.population * 0.2));
    city.storage.gold += Math.max(1, Math.floor(city.population * city.taxRate));
    const market = state.markets[city.id] ?? {
      cityId: city.id,
      prices: {
        food: 2,
        wood: 3,
        stone: 4,
        iron: 6,
        tools: 8,
        weapons: 10,
        gold: 1
      }
    };
    state.markets[city.id] = market;
  }
};

const updateCities = (state: WorldState): void => {
  for (const city of Object.values(state.cities)) {
    city.territoryRadius = Math.min(12, 4 + Math.floor(city.population / 5));
    city.housingCapacity = Math.max(5, city.buildings.home ? city.buildings.home * 2 : 5);
    city.security = Math.max(1, city.buildings.watchtower ?? 0);
    city.attraction = Math.min(5, 1 + (city.buildings.market ?? 0));
    for (const building of city.buildQueue) {
      building.progress += 1;
    }
    const completed = city.buildQueue.filter((item) => item.progress >= item.required);
    city.buildQueue = city.buildQueue.filter((item) => item.progress < item.required);
    for (const item of completed) {
      city.buildings[item.type] = (city.buildings[item.type] ?? 0) + 1;
      pushEvent(state, `${city.name} completed ${item.type}`);
    }
    const previousLevel = city.level;
    if (city.population >= 25) {
      city.level = "city";
    } else if (city.population >= 10) {
      city.level = "town";
    } else {
      city.level = "village";
    }
    if (previousLevel !== city.level) {
      pushEvent(state, `${city.name} upgraded to ${city.level}`);
    }
  }
  for (const unit of Object.values(state.units)) {
    if (unit.cityId) {
      unit.stateId = state.cities[unit.cityId]?.stateId;
    }
  }
};

const updateTerritory = (state: WorldState): void => {
  const size = state.config.size;
  const cities = Object.values(state.cities);
  const chunkOwnership: WorldState["chunkOwnership"] = {};
  if (cities.length === 0) {
    for (const tile of state.tiles) {
      tile.ownerCityId = undefined;
      tile.ownerStateId = undefined;
      tile.contested = false;
    }
    state.chunkOwnership = {};
    return;
  }
  for (const tile of state.tiles) {
    let bestCity: City | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    let secondScore = Number.NEGATIVE_INFINITY;
    for (const city of cities) {
      const distance = Math.hypot(tile.x - city.center.x, tile.y - city.center.y);
      if (distance > city.territoryRadius) {
        continue;
      }
      const terrainPenalty = tile.biome === "mountain" || tile.biome === "ocean" ? 2 : tile.biome === "forest" ? 1 : 0;
      const score = city.territoryRadius - distance - terrainPenalty + (city.buildings.road ?? 0) * 0.2;
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        bestCity = city;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
    if (bestCity && bestScore > 0) {
      tile.ownerCityId = bestCity.id;
      tile.ownerStateId = bestCity.stateId;
      tile.contested = secondScore > bestScore - 0.5;
    } else {
      tile.ownerCityId = undefined;
      tile.ownerStateId = undefined;
      tile.contested = false;
    }
  }
  for (let cy = 0; cy < size; cy += CHUNK_SIZE) {
    for (let cx = 0; cx < size; cx += CHUNK_SIZE) {
      const counts: Record<string, number> = {};
      let contested = false;
      for (let y = cy; y < Math.min(size, cy + CHUNK_SIZE); y += 1) {
        for (let x = cx; x < Math.min(size, cx + CHUNK_SIZE); x += 1) {
          const tile = state.tiles[y * size + x];
          if (tile.contested) {
            contested = true;
          }
          const owner = tile.ownerStateId ?? tile.ownerCityId;
          if (owner) {
            counts[owner] = (counts[owner] ?? 0) + 1;
          }
        }
      }
      const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      const top = entries[0]?.[0];
      if (top) {
        chunkOwnership[chunkKey(cx, cy)] = { stateId: state.states[top] ? top : undefined, cityId: state.cities[top] ? top : undefined, contested };
      }
    }
  }
  state.chunkOwnership = chunkOwnership;
};

const updateFogOfWar = (state: WorldState): void => {
  if (!state.config.fogOfWar) {
    return;
  }
  for (const agent of Object.values(state.agents)) {
    const visible = new Set<string>();
    const explored = new Set<string>(state.fog[agent.id]?.exploredChunks ?? []);
    for (const unitId of agent.units) {
      const unit = state.units[unitId];
      if (!unit) {
        continue;
      }
      const base = state.config.visionRadius;
      const city = unit.cityId ? state.cities[unit.cityId] : undefined;
      const towerBonus = city?.buildings.watchtower ? state.config.towerBonus : 0;
      const radius = base + towerBonus;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const x = unit.position.x + dx;
          const y = unit.position.y + dy;
          if (x < 0 || y < 0 || x >= state.config.size || y >= state.config.size) {
            continue;
          }
          const tile = state.tiles[y * state.config.size + x];
          const distance = Math.hypot(dx, dy);
          if (distance > radius) {
            continue;
          }
          if (tile.biome === "forest") {
            if (distance > radius - state.config.forestPenalty) {
              continue;
            }
          }
          if (state.config.mountainBlocks && tile.biome === "mountain" && distance > 1) {
            continue;
          }
          const key = chunkKey(x, y);
          visible.add(key);
          explored.add(key);
        }
      }
    }
    state.fog[agent.id] = { visibleChunks: Array.from(visible), exploredChunks: Array.from(explored) };
  }
};

const updateHeatmaps = (state: WorldState): void => {
  if (state.tick % 5 !== 0) {
    return;
  }
  const size = state.config.size;
  const chunkSize = 16;
  const heatmaps = ["food", "wealth", "danger", "density", "trade", "state"];
  for (const type of heatmaps) {
    const chunks: Record<string, number[]> = {};
    for (let cy = 0; cy < size; cy += chunkSize) {
      for (let cx = 0; cx < size; cx += chunkSize) {
        const values: number[] = [];
        for (let y = cy; y < Math.min(size, cy + chunkSize); y += 1) {
          for (let x = cx; x < Math.min(size, cx + chunkSize); x += 1) {
            values.push(computeHeat(type, state, x, y));
          }
        }
        chunks[`${cx}:${cy}`] = values;
      }
    }
    state.heatmaps[type] = { updatedAt: state.tick, chunks };
  }
};

const tileAt = (state: WorldState, position: { x: number; y: number }): Tile => {
  return state.tiles[position.y * state.config.size + position.x];
};

const canTraverse = (tile: Tile, unit: Unit): boolean => {
  if (tile.biome === "ocean") {
    return false;
  }
  if (tile.biome === "mountain" && unit.role === "citizen") {
    return false;
  }
  return true;
};

const pushEvent = (state: WorldState, message: string): void => {
  state.events.unshift(message);
  if (state.events.length > MAX_EVENTS) {
    state.events.length = MAX_EVENTS;
  }
};

const computeHeat = (type: string, state: WorldState, x: number, y: number): number => {
  const tile = state.tiles[y * state.config.size + x];
  switch (type) {
    case "food":
      return tile.biome === "plains" ? 0.8 : tile.biome === "forest" ? 0.6 : 0.2;
    case "wealth": {
      const city = Object.values(state.cities).find((c) => Math.abs(c.center.x - x) <= 3 && Math.abs(c.center.y - y) <= 3);
      return city ? Math.min(1, city.storage.gold / 100) : 0.1;
    }
    case "danger":
      return tile.biome === "mountain" ? 0.7 : tile.biome === "forest" ? 0.4 : 0.2;
    case "density":
      return Object.values(state.units).filter((u) => Math.abs(u.position.x - x) <= 2 && Math.abs(u.position.y - y) <= 2).length / 5;
    case "trade":
      return tile.biome === "coast" ? 0.6 : 0.3;
    case "state":
      return tile.ownerStateId ? 0.7 : 0;
    default:
      return 0;
  }
};

const chunkKey = (x: number, y: number): string =>
  `${Math.floor(x / CHUNK_SIZE) * CHUNK_SIZE}:${Math.floor(y / CHUNK_SIZE) * CHUNK_SIZE}`;

