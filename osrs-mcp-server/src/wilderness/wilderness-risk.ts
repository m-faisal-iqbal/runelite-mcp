// ─── Wilderness Risk Calculator ───────────────────────────────────────────────
// Determines wilderness level from world coordinates, estimates carried risk
// (items lost on death), and enforces wilderness entry gate.

import type { RuneLiteSnapshot } from "../client.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WildernessLevel = {
  level: number;          // 0 = not in wilderness, 1-56 = wilderness level
  inWilderness: boolean;
  zoneName: string;
  canTeleport: boolean;   // teleport blocked above level 20
  canUseTeleItems: boolean; // item teles blocked above 30
};

export type ItemRisk = {
  name: string;
  id: number;
  quantity: number;
  estimatedValue: number;
  kept: boolean;           // true if item is kept on death
};

export type CarriedRisk = {
  totalValue:     number;
  keptValue:      number;  // value of items kept on death (top 3, +skull affects this)
  riskValue:      number;  // value of items that WILL be lost
  items:          ItemRisk[];
  isSkulled:      boolean;
  keptOnDeath:    number;  // number of items kept (3 normal, 0 if skulled, +1 with prayer)
  riskRating:     "NONE" | "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
  recommendation: string;
};

// ─── Wilderness coordinate bounds ─────────────────────────────────────────────
// OSRS wilderness region: Y >= 3523 (surface), or specific underground regions

const WILDERNESS_FLOOR_Y    = 3523;
const WILDERNESS_CEILING_Y  = 3966;
const WILDERNESS_FLOOR_X_MIN = 2944;
const WILDERNESS_FLOOR_X_MAX = 3392;

// Wilderness level 1 starts at y=3523, each level = 8 tiles northward
const WILDERNESS_Y_ORIGIN = 3522;
const TILES_PER_LEVEL     = 8;

// Named wilderness zones by approximate level range
const WILDERNESS_ZONES: { minLevel: number; maxLevel: number; name: string }[] = [
  { minLevel: 1,  maxLevel: 5,  name: "Low Wilderness (Edge/Ditch area)" },
  { minLevel: 6,  maxLevel: 10, name: "Low-Mid Wilderness (Chaos Temple area)" },
  { minLevel: 11, maxLevel: 19, name: "Mid Wilderness (Green Dragons area)" },
  { minLevel: 20, maxLevel: 29, name: "Mid Wilderness (Teleport blocked)" },
  { minLevel: 30, maxLevel: 39, name: "Deep Wilderness (Item teleport blocked)" },
  { minLevel: 40, maxLevel: 49, name: "Deep Wilderness (Resource Area)" },
  { minLevel: 50, maxLevel: 56, name: "Very Deep Wilderness (KBD lair approach)" },
];

// Risk thresholds in GP
const RISK_THRESHOLDS = {
  LOW:     100_000,
  MEDIUM:  500_000,
  HIGH:  2_000_000,
};

// ─── Wilderness level from coordinates ───────────────────────────────────────

export function calcWildernessLevel(worldX: number, worldY: number): WildernessLevel {
  const inBounds =
    worldY >= WILDERNESS_FLOOR_Y &&
    worldY <= WILDERNESS_CEILING_Y &&
    worldX >= WILDERNESS_FLOOR_X_MIN &&
    worldX <= WILDERNESS_FLOOR_X_MAX;

  if (!inBounds) {
    return { level: 0, inWilderness: false, zoneName: "Not in wilderness", canTeleport: true, canUseTeleItems: true };
  }

  const level = Math.max(1, Math.ceil((worldY - WILDERNESS_Y_ORIGIN) / TILES_PER_LEVEL));
  const clampedLevel = Math.min(level, 56);

  const zone = WILDERNESS_ZONES.find((z) => clampedLevel >= z.minLevel && clampedLevel <= z.maxLevel);

  return {
    level:           clampedLevel,
    inWilderness:    true,
    zoneName:        zone?.name ?? `Wilderness level ${clampedLevel}`,
    canTeleport:     clampedLevel <= 20,
    canUseTeleItems: clampedLevel <= 30,
  };
}

/** Read wilderness level from snapshot varbits (more accurate than coordinate calc) */
export function getWildernessLevelFromSnapshot(snapshot: RuneLiteSnapshot): WildernessLevel {
  const varbits = snapshot?.state?.varbits ?? {};
  // Varbit 406 = wilderness level (0 when not in wilderness)
  const varbitLevel = Number(varbits[406] ?? varbits["406"] ?? 0);

  if (varbitLevel > 0) {
    const zone = WILDERNESS_ZONES.find((z) => varbitLevel >= z.minLevel && varbitLevel <= z.maxLevel);
    return {
      level:           varbitLevel,
      inWilderness:    true,
      zoneName:        zone?.name ?? `Wilderness level ${varbitLevel}`,
      canTeleport:     varbitLevel <= 20,
      canUseTeleItems: varbitLevel <= 30,
    };
  }

  // Fallback: coordinate-based
  const loc = snapshot?.state?.location;
  if (loc) {
    return calcWildernessLevel(Number(loc.x ?? 0), Number(loc.y ?? 0));
  }

  return { level: 0, inWilderness: false, zoneName: "Not in wilderness", canTeleport: true, canUseTeleItems: true };
}

// ─── Carried risk estimator ───────────────────────────────────────────────────

export function calcCarriedRisk(
  snapshot: RuneLiteSnapshot,
  getPriceById: (id: number) => { high?: number; low?: number } | undefined,
  prayingProtectItem = false
): CarriedRisk {
  // Check skull status — varbit 4 = skull timer (>0 = skulled)
  const varbits = snapshot?.state?.varbits ?? {};
  const skullTimer = Number(varbits[4] ?? varbits["4"] ?? 0);
  const isSkulled  = skullTimer > 0;

  // Items kept on death: 3 normally, 0 if skulled, +1 if using Protect Item prayer
  const keptCount = isSkulled
    ? (prayingProtectItem ? 1 : 0)
    : (prayingProtectItem ? 4 : 3);

  // Read inventory + equipment
  const inventory  = Array.isArray(snapshot?.inventory) ? snapshot.inventory : [];
  const equipment  = snapshot?.equipment;
  const equipItems = equipment && typeof equipment === "object"
    ? Object.values(equipment).filter((e) => e && typeof e === "object")
    : [];

  const allItems = [...inventory, ...equipItems].filter(
    (i): i is Record<string, unknown> => i != null && typeof i === "object"
  );

  const itemRisks: ItemRisk[] = allItems
    .map((item) => {
      const id  = Number(item["id"] ?? 0);
      const qty = Number(item["quantity"] ?? item["qty"] ?? 1);
      const name = String(item["name"] ?? "Unknown");
      const price = getPriceById(id);
      const estimatedValue = (price?.high ?? 0) * qty;
      return { name, id, quantity: qty, estimatedValue, kept: false };
    })
    .filter((i) => i.estimatedValue > 0 || i.id > 0)
    .sort((a, b) => b.estimatedValue - a.estimatedValue);

  // Mark top N items as kept
  itemRisks.forEach((item, idx) => {
    item.kept = idx < keptCount;
  });

  const keptValue  = itemRisks.filter((i) => i.kept).reduce((s, i) => s + i.estimatedValue, 0);
  const riskValue  = itemRisks.filter((i) => !i.kept).reduce((s, i) => s + i.estimatedValue, 0);
  const totalValue = keptValue + riskValue;

  let riskRating: CarriedRisk["riskRating"] = "NONE";
  if      (riskValue >= RISK_THRESHOLDS.HIGH)   riskRating = "EXTREME";
  else if (riskValue >= RISK_THRESHOLDS.MEDIUM) riskRating = "HIGH";
  else if (riskValue >= RISK_THRESHOLDS.LOW)    riskRating = "MEDIUM";
  else if (riskValue > 0)                       riskRating = "LOW";

  const recommendations: string[] = [];
  if (riskRating === "EXTREME") recommendations.push("DO NOT ENTER WILDERNESS — extreme risk");
  else if (riskRating === "HIGH") recommendations.push("Consider banking valuable items before entering");
  else if (isSkulled) recommendations.push("SKULLED — lose all items on death, teleport immediately if threatened");
  if (!snapshot?.state?.location) recommendations.push("Location unknown");

  return {
    totalValue,
    keptValue,
    riskValue,
    items:          itemRisks,
    isSkulled,
    keptOnDeath:    keptCount,
    riskRating,
    recommendation: recommendations.join(". ") || "Risk acceptable",
  };
}

/** Combat level range who can attack you at a given wilderness level */
export function pvpCombatRange(playerCombatLevel: number, wildernessLevel: number): {
  minLevel: number;
  maxLevel: number;
} {
  return {
    minLevel: Math.max(3,   playerCombatLevel - wildernessLevel),
    maxLevel: Math.min(126, playerCombatLevel + wildernessLevel),
  };
}
