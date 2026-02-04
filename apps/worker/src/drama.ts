import type { City, DramaEvent, State, Unit, War, WorldState } from "./types";
import type { Position } from "./types";

const MAX_DRAMA_EVENTS = 100;
const EVENT_COOLDOWN_TICKS = 50;
const MAX_EVENTS_PER_TICK = 3;

export const detectDramaEvents = (state: WorldState): DramaEvent[] => {
  const newEvents: DramaEvent[] = [];
  const now = Date.now();

  // Check city collapses
  for (const city of Object.values(state.cities)) {
    const cooldown = state.cityCooldowns[city.id] ?? 0;
    if (state.tick - cooldown < EVENT_COOLDOWN_TICKS) {
      continue;
    }

    // City collapse: food or stability too low
    const foodRatio = city.storage.food / Math.max(1, city.population * 10);
    const stability = city.security + (city.buildings.townhall ?? 0) * 2;
    
    if (foodRatio < 0.1 && city.population > 5) {
      const event: DramaEvent = {
        id: crypto.randomUUID(),
        type: "city_collapse",
        severity: city.population > 20 ? "major" : "minor",
        tick: state.tick,
        timestamp: now,
        location: city.center,
        cityId: city.id,
        message: `${city.name} is collapsing due to famine!`,
        metadata: { population: city.population, food: city.storage.food }
      };
      newEvents.push(event);
      state.cityCooldowns[city.id] = state.tick;
      
      // Trigger migration
      const migrationEvent: DramaEvent = {
        id: crypto.randomUUID(),
        type: "migration",
        severity: "minor",
        tick: state.tick,
        timestamp: now,
        location: city.center,
        cityId: city.id,
        message: `Mass migration from ${city.name}`,
        metadata: { population: Math.floor(city.population * 0.3) }
      };
      newEvents.push(migrationEvent);
      
      // Reduce population
      city.population = Math.max(1, Math.floor(city.population * 0.7));
    } else if (stability < 2 && city.population > 10) {
      const event: DramaEvent = {
        id: crypto.randomUUID(),
        type: "revolt",
        severity: "major",
        tick: state.tick,
        timestamp: now,
        location: city.center,
        cityId: city.id,
        message: `Revolt in ${city.name}!`,
        metadata: { stability, population: city.population }
      };
      newEvents.push(event);
      state.cityCooldowns[city.id] = state.tick;
    }
  }

  // Check wars
  for (const war of Object.values(state.wars)) {
    if (war.endTick) {
      continue; // War already ended
    }

    // Check for war exhaustion
    war.exhaustion += 0.1;
    if (war.exhaustion > 10) {
      const stateA = state.states[war.stateA];
      const stateB = state.states[war.stateB];
      if (stateA && stateB) {
        const event: DramaEvent = {
          id: crypto.randomUUID(),
          type: "peace_treaty",
          severity: "major",
          tick: state.tick,
          timestamp: now,
          stateId: war.stateA,
          targetStateId: war.stateB,
          message: `${stateA.name} and ${stateB.name} sign peace treaty`,
          metadata: { casualties: war.casualties }
        };
        newEvents.push(event);
        war.endTick = state.tick;
        state.states[war.stateA].relations[war.stateB] = "peace";
        state.states[war.stateB].relations[war.stateA] = "peace";
      }
    }
  }

  // Check for new wars (border conflicts)
  if (state.tick % 10 === 0) {
    for (const stateA of Object.values(state.states)) {
      for (const stateB of Object.values(state.states)) {
        if (stateA.id >= stateB.id) continue;
        if (stateA.relations[stateB.id] === "war") continue;
        
        // Check if states have border conflicts
        const conflict = checkBorderConflict(state, stateA.id, stateB.id);
        if (conflict) {
          const existingWar = Object.values(state.wars).find(
            (w) => (w.stateA === stateA.id && w.stateB === stateB.id) || (w.stateA === stateB.id && w.stateB === stateA.id)
          );
          if (!existingWar) {
            const warId = crypto.randomUUID();
            const war: War = {
              id: warId,
              stateA: stateA.id,
              stateB: stateB.id,
              startTick: state.tick,
              frontLines: conflict,
              casualties: 0,
              exhaustion: 0
            };
            state.wars[warId] = war;
            
            const event: DramaEvent = {
              id: crypto.randomUUID(),
              type: "war_declared",
              severity: "global",
              tick: state.tick,
              timestamp: now,
              stateId: stateA.id,
              targetStateId: stateB.id,
              message: `War declared between ${stateA.name} and ${stateB.name}!`,
              metadata: { warId }
            };
            newEvents.push(event);
            
            stateA.relations[stateB.id] = "war";
            stateB.relations[stateA.id] = "war";
          }
        }
      }
    }
  }

  // Check for capital captures
  for (const war of Object.values(state.wars)) {
    if (war.endTick) continue;
    
    const stateA = state.states[war.stateA];
    const stateB = state.states[war.stateB];
    if (!stateA || !stateB) continue;
    
    const capitalA = state.cities[stateA.capitalCityId];
    const capitalB = state.cities[stateB.capitalCityId];
    
    if (capitalA && capitalA.stateId === stateB.id) {
      const event: DramaEvent = {
        id: crypto.randomUUID(),
        type: "capital_fallen",
        severity: "global",
        tick: state.tick,
        timestamp: now,
        location: capitalA.center,
        cityId: capitalA.id,
        stateId: stateA.id,
        targetStateId: stateB.id,
        message: `${stateA.name}'s capital ${capitalA.name} has fallen!`,
        metadata: { warId: war.id }
      };
      newEvents.push(event);
      state.cityCooldowns[capitalA.id] = state.tick;
    }
    
    if (capitalB && capitalB.stateId === stateA.id) {
      const event: DramaEvent = {
        id: crypto.randomUUID(),
        type: "capital_fallen",
        severity: "global",
        tick: state.tick,
        timestamp: now,
        location: capitalB.center,
        cityId: capitalB.id,
        stateId: stateB.id,
        targetStateId: stateA.id,
        message: `${stateB.name}'s capital ${capitalB.name} has fallen!`,
        metadata: { warId: war.id }
      };
      newEvents.push(event);
      state.cityCooldowns[capitalB.id] = state.tick;
    }
  }

  // Cap events per tick
  return newEvents.slice(0, MAX_EVENTS_PER_TICK);
};

const checkBorderConflict = (state: WorldState, stateAId: string, stateBId: string): Position[] | null => {
  const conflicts: Position[] = [];
  const size = state.config.size;
  
  // Check contested tiles
  for (let y = 0; y < size; y += 4) {
    for (let x = 0; x < size; x += 4) {
      const idx = y * size + x;
      const tile = state.tiles[idx];
      if (!tile) continue;
      
      if (tile.contested || (tile.ownerStateId === stateAId && tile.ownerStateId === stateBId)) {
        conflicts.push({ x, y });
      }
    }
  }
  
  return conflicts.length > 3 ? conflicts.slice(0, 10) : null;
};

export const updateWars = (state: WorldState): void => {
  for (const war of Object.values(state.wars)) {
    if (war.endTick) continue;
    
    // Simulate battles
    if (state.tick % 5 === 0) {
      const casualties = Math.floor(Math.random() * 3);
      war.casualties += casualties;
      
      // Update front lines
      if (war.frontLines.length > 0) {
        const front = war.frontLines[Math.floor(Math.random() * war.frontLines.length)];
        // Mark tiles as contested
        const idx = front.y * state.config.size + front.x;
        if (state.tiles[idx]) {
          state.tiles[idx].contested = true;
        }
      }
    }
  }
};

export const updateAgentStories = (state: WorldState, unit: Unit, event?: string): void => {
  const agentId = unit.agentId;
  if (!state.agentStories[agentId]) {
    state.agentStories[agentId] = {
      agentId,
      birthTick: state.tick,
      citiesLived: [],
      warsJoined: [],
      migrations: [],
      majorEvents: [],
      lastUpdated: Date.now()
    };
  }
  
  const story = state.agentStories[agentId];
  
  // Track city changes
  if (unit.cityId && !story.citiesLived.includes(unit.cityId)) {
    story.citiesLived.push(unit.cityId);
    if (story.citiesLived.length > 5) {
      story.citiesLived.shift();
    }
  }
  
  // Track state/war changes
  if (unit.stateId) {
    const stateObj = state.states[unit.stateId];
    if (stateObj) {
      for (const war of Object.values(state.wars)) {
        if ((war.stateA === unit.stateId || war.stateB === unit.stateId) && !war.endTick) {
          if (!story.warsJoined.includes(war.id)) {
            story.warsJoined.push(war.id);
            if (story.warsJoined.length > 3) {
              story.warsJoined.shift();
            }
          }
        }
      }
    }
  }
  
  // Track major events
  if (event) {
    story.majorEvents.push({ tick: state.tick, event });
    if (story.majorEvents.length > 10) {
      story.majorEvents.shift();
    }
  }
  
  story.lastUpdated = Date.now();
};

export const addDramaEvent = (state: WorldState, event: DramaEvent): void => {
  state.dramaEvents.unshift(event);
  if (state.dramaEvents.length > MAX_DRAMA_EVENTS) {
    state.dramaEvents = state.dramaEvents.slice(0, MAX_DRAMA_EVENTS);
  }
  
  // Also add to regular events for compatibility
  state.events.unshift(event.message);
  if (state.events.length > 50) {
    state.events = state.events.slice(0, 50);
  }
};

