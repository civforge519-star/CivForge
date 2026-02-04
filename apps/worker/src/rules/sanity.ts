import type { Inventory, WorldState } from "../types";

export const sanitizeWorld = (state: WorldState): string[] => {
  const issues: string[] = [];
  const size = state.config.size;
  for (const unit of Object.values(state.units)) {
    if (!Number.isFinite(unit.position.x) || !Number.isFinite(unit.position.y)) {
      unit.position = { x: Math.floor(size / 2), y: Math.floor(size / 2) };
      issues.push(`unit:${unit.id}:position_nan`);
    }
    unit.position.x = clamp(unit.position.x, 0, size - 1);
    unit.position.y = clamp(unit.position.y, 0, size - 1);
    unit.hp = clamp(unit.hp, 0, 100);
    unit.stamina = clamp(unit.stamina, 0, 100);
    for (const key of Object.keys(unit.inventory)) {
      unit.inventory[key as keyof Inventory] = Math.max(0, unit.inventory[key as keyof Inventory] ?? 0);
    }
  }
  return issues;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

