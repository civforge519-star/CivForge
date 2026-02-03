import type { Home, NPC, TileType, WorldState } from "./types";
import { createHome, createVillage } from "./world";

const HUNGER_THRESHOLD = 70;
const HUNGER_MAX = 100;
const HOME_WOOD_COST = 5;
const VILLAGE_RADIUS = 6;
const VILLAGE_MIN_HOMES = 5;
const STORAGE_RADIUS = 5;
const MAX_EVENTS = 20;

export const tickWorld = (state: WorldState): void => {
  if (state.paused) {
    return;
  }

  state.tick += 1;

  for (const npc of state.npcs) {
    if (!npc.alive) {
      tryRespawn(state, npc);
      continue;
    }

    npc.hunger = clamp(npc.hunger + 1, 0, HUNGER_MAX);

    if (npc.hunger >= HUNGER_MAX) {
      npc.hp -= 2;
      if (npc.hp <= 0) {
        npc.alive = false;
        npc.respawnTick = state.tick + 30;
        pushEvent(state, `NPC ${npc.id.slice(0, 6)} died`);
        continue;
      }
    }

    if (npc.hunger > HUNGER_THRESHOLD) {
      handleHunger(state, npc);
      continue;
    }

    if (!npc.homeId) {
      handleHomeless(state, npc);
      continue;
    }

    handleJob(state, npc);
  }

  updateVillages(state);
};

const tryRespawn = (state: WorldState, npc: NPC): void => {
  if (!npc.respawnTick || state.tick < npc.respawnTick) {
    return;
  }
  const spawn = pickSpawn(state);
  npc.position = spawn;
  npc.hp = 100;
  npc.hunger = 30;
  npc.inventory = { food: 2, wood: 0 };
  npc.alive = true;
  npc.respawnTick = undefined;
  pushEvent(state, `NPC ${npc.id.slice(0, 6)} respawned`);
};

const handleHunger = (state: WorldState, npc: NPC): void => {
  if (npc.inventory.food > 0) {
    npc.inventory.food -= 1;
    npc.hunger = clamp(npc.hunger - 40, 0, HUNGER_MAX);
    return;
  }

  const village = npc.villageId ? state.villages.find((v) => v.id === npc.villageId) : null;
  if (village && inRange(npc.position, village.center, STORAGE_RADIUS) && village.storage.food > 0) {
    village.storage.food -= 1;
    npc.hunger = clamp(npc.hunger - 30, 0, HUNGER_MAX);
    return;
  }

  const tile = tileAt(state, npc.position.x, npc.position.y);
  if (tile === "grass" || tile === "forest") {
    npc.inventory.food += 1;
  } else {
    moveTowardTile(state, npc, ["grass", "forest"]);
  }
};

const handleHomeless = (state: WorldState, npc: NPC): void => {
  if (npc.inventory.wood < HOME_WOOD_COST) {
    const tile = tileAt(state, npc.position.x, npc.position.y);
    if (tile === "forest") {
      npc.inventory.wood += 1;
    } else {
      moveTowardTile(state, npc, ["forest"]);
    }
    return;
  }

  const tile = tileAt(state, npc.position.x, npc.position.y);
  if (tile === "water" || tile === "mountain") {
    moveRandom(state, npc);
    return;
  }

  const home = createHome(npc.id, npc.position.x, npc.position.y);
  state.homes.push(home);
  npc.homeId = home.id;
  npc.inventory.wood = Math.max(0, npc.inventory.wood - HOME_WOOD_COST);
  pushEvent(state, `NPC ${npc.id.slice(0, 6)} built a home`);
};

const handleJob = (state: WorldState, npc: NPC): void => {
  switch (npc.job) {
    case "farmer": {
      const tile = tileAt(state, npc.position.x, npc.position.y);
      if (tile === "grass") {
        npc.inventory.food += 1;
      } else {
        moveTowardTile(state, npc, ["grass"]);
      }
      break;
    }
    case "woodcutter":
    case "builder": {
      const tile = tileAt(state, npc.position.x, npc.position.y);
      if (tile === "forest") {
        npc.inventory.wood += 1;
      } else {
        moveTowardTile(state, npc, ["forest"]);
      }
      break;
    }
    case "guard": {
      moveRandom(state, npc);
      break;
    }
    default:
      moveRandom(state, npc);
  }
};

const updateVillages = (state: WorldState): void => {
  const existingCenters = state.villages.map((v) => v.center);
  const unassignedHomes = state.homes.filter((home) => !home.villageId);

  for (const home of unassignedHomes) {
    if (existingCenters.some((center) => inRange(center, home.position, VILLAGE_RADIUS))) {
      continue;
    }
    const nearby = unassignedHomes.filter((candidate) =>
      inRange(candidate.position, home.position, VILLAGE_RADIUS)
    );
    if (nearby.length >= VILLAGE_MIN_HOMES) {
      const center = averagePosition(nearby);
      const village = createVillage(center.x, center.y, nearby.map((h) => h.id));
      state.villages.push(village);
      for (const target of nearby) {
        target.villageId = village.id;
      }
      for (const npc of state.npcs) {
        if (npc.homeId && village.homeIds.includes(npc.homeId)) {
          npc.villageId = village.id;
        }
      }
      pushEvent(state, `${village.name} founded`);
      break;
    }
  }
};

const pickSpawn = (state: WorldState): { x: number; y: number } => {
  if (state.villages.length > 0) {
    const village = state.villages[Math.floor(Math.random() * state.villages.length)];
    return jitterPosition(state, village.center);
  }
  return {
    x: Math.floor(Math.random() * state.size),
    y: Math.floor(Math.random() * state.size)
  };
};

const jitterPosition = (state: WorldState, position: { x: number; y: number }) => ({
  x: clamp(position.x + randInt(-2, 2), 0, state.size - 1),
  y: clamp(position.y + randInt(-2, 2), 0, state.size - 1)
});

const tileAt = (state: WorldState, x: number, y: number): TileType => {
  return state.tiles[y]?.[x] ?? "grass";
};

const moveRandom = (state: WorldState, npc: NPC): void => {
  const dx = randInt(-1, 1);
  const dy = randInt(-1, 1);
  npc.position = {
    x: clamp(npc.position.x + dx, 0, state.size - 1),
    y: clamp(npc.position.y + dy, 0, state.size - 1)
  };
};

const moveTowardTile = (state: WorldState, npc: NPC, desired: TileType[]): void => {
  const target = findNearbyTile(state, npc.position.x, npc.position.y, desired, 6);
  if (!target) {
    moveRandom(state, npc);
    return;
  }
  const stepX = Math.sign(target.x - npc.position.x);
  const stepY = Math.sign(target.y - npc.position.y);
  npc.position = {
    x: clamp(npc.position.x + stepX, 0, state.size - 1),
    y: clamp(npc.position.y + stepY, 0, state.size - 1)
  };
};

const findNearbyTile = (
  state: WorldState,
  startX: number,
  startY: number,
  desired: TileType[],
  radius: number
): { x: number; y: number } | null => {
  for (let r = 1; r <= radius; r += 1) {
    for (let y = startY - r; y <= startY + r; y += 1) {
      for (let x = startX - r; x <= startX + r; x += 1) {
        if (x < 0 || y < 0 || x >= state.size || y >= state.size) {
          continue;
        }
        if (desired.includes(tileAt(state, x, y))) {
          return { x, y };
        }
      }
    }
  }
  return null;
};

const averagePosition = (homes: Home[]): { x: number; y: number } => {
  const sum = homes.reduce(
    (acc, home) => ({ x: acc.x + home.position.x, y: acc.y + home.position.y }),
    { x: 0, y: 0 }
  );
  return {
    x: Math.round(sum.x / homes.length),
    y: Math.round(sum.y / homes.length)
  };
};

const inRange = (a: { x: number; y: number }, b: { x: number; y: number }, radius: number): boolean => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy) <= radius;
};

const pushEvent = (state: WorldState, message: string): void => {
  state.events.unshift(message);
  if (state.events.length > MAX_EVENTS) {
    state.events.length = MAX_EVENTS;
  }
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const randInt = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

