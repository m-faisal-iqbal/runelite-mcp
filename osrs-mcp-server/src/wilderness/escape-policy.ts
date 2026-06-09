// ─── Escape Policy ────────────────────────────────────────────────────────────
// Ordered escape sequence when a PvP threat is detected in the wilderness.
// Priority: teleport spell → teleport item → run to ditch → emergency drop → logout

import type { RuneLiteSnapshot } from "../client.js";
import { getWildernessLevelFromSnapshot } from "./wilderness-risk.js";
import { assessThreats } from "./threat-detector.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EscapeMethod =
  | "TELEPORT_SPELL"
  | "TELEPORT_ITEM"
  | "RUN_TO_DITCH"
  | "EMERGENCY_DROP"
  | "LOGOUT";

export type EscapeAction = {
  method:      EscapeMethod;
  priority:    number;         // lower = higher priority
  action:      string;
  tool:        string;
  toolArgs:    Record<string, unknown>;
  description: string;
  available:   boolean;
  blockedReason?: string;
};

export type EscapePlan = {
  threat:          string;
  wildernessLevel: number;
  bestMethod:      EscapeMethod | null;
  actions:         EscapeAction[];
  canEscape:       boolean;
  urgency:         "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
};

// ─── Teleport spell definitions ───────────────────────────────────────────────

const TELEPORT_SPELLS = [
  { name: "Lumbridge Teleport",  magicLevel: 31, runeIds: [556, 557, 563], runeNames: ["Air rune", "Earth rune", "Law rune"] },
  { name: "Falador Teleport",    magicLevel: 37, runeIds: [556, 555, 563], runeNames: ["Air rune", "Water rune", "Law rune"] },
  { name: "Camelot Teleport",    magicLevel: 45, runeIds: [556, 563],      runeNames: ["Air rune", "Law rune"] },
  { name: "Varrock Teleport",    magicLevel: 25, runeIds: [556, 554, 563], runeNames: ["Air rune", "Fire rune", "Law rune"] },
];

// Teleport items in priority order (most common/accessible first)
const TELEPORT_ITEMS = [
  { name: "Amulet of glory(6)", aliases: ["amulet of glory(5)", "amulet of glory(4)", "amulet of glory(3)", "amulet of glory(2)", "amulet of glory(1)"] },
  { name: "Ring of dueling(8)", aliases: ["ring of dueling(7)", "ring of dueling(6)", "ring of dueling(5)", "ring of dueling(4)", "ring of dueling(3)", "ring of dueling(2)", "ring of dueling(1)"] },
  { name: "Combat bracelet(6)", aliases: ["combat bracelet(5)", "combat bracelet(4)", "combat bracelet(3)", "combat bracelet(2)", "combat bracelet(1)"] },
  { name: "Skills necklace(6)", aliases: ["skills necklace(5)", "skills necklace(4)", "skills necklace(3)", "skills necklace(2)", "skills necklace(1)"] },
  { name: "Teleport to house", aliases: ["teleport to house(p)"] },
];

// ─── Inventory helpers ────────────────────────────────────────────────────────

function getInventoryNames(snapshot: RuneLiteSnapshot): string[] {
  const inv = Array.isArray(snapshot?.inventory) ? snapshot.inventory : [];
  return inv.map((i) => String(i?.name ?? "").toLowerCase().trim()).filter(Boolean);
}

function getSkillLevel(snapshot: RuneLiteSnapshot, skill: string): number {
  const skills = snapshot?.skills;
  if (!skills) return 1;
  const val = (skills as Record<string, unknown>)[skill.toLowerCase()];
  if (!val) return 1;
  if (typeof val === "number") return val;
  if (typeof val === "object") return Number((val as Record<string, unknown>).level ?? 1);
  return 1;
}

function hasRunesFor(inventory: string[], runeNames: string[]): boolean {
  return runeNames.every((rune) =>
    inventory.some((item) => item.includes(rune.toLowerCase().replace(" rune", "")))
  );
}

function findTeleportItem(inventory: string[]): { name: string } | null {
  for (const tele of TELEPORT_ITEMS) {
    const allNames = [tele.name, ...tele.aliases].map((n) => n.toLowerCase());
    if (inventory.some((item) => allNames.includes(item))) {
      return { name: tele.name };
    }
  }
  return null;
}

// ─── Build escape plan ────────────────────────────────────────────────────────

export function buildEscapePlan(
  snapshot: RuneLiteSnapshot,
  wildernessLevel: number
): EscapePlan {
  const threat      = assessThreats(snapshot, wildernessLevel);
  const inventory   = getInventoryNames(snapshot);
  const magicLevel  = getSkillLevel(snapshot, "magic");
  const canTele     = wildernessLevel <= 20;
  const canTeleItem = wildernessLevel <= 30;

  const urgency = threat.overallThreat === "CRITICAL" ? "CRITICAL"
    : threat.overallThreat === "HIGH"     ? "HIGH"
    : threat.overallThreat === "MEDIUM"   ? "MEDIUM"
    : "LOW";

  const actions: EscapeAction[] = [];

  // ── 1. Teleport spell ───────────────────────────────────────────────────
  const bestSpell = TELEPORT_SPELLS
    .filter((s) => s.magicLevel <= magicLevel && hasRunesFor(inventory, s.runeNames))
    .sort((a, b) => a.magicLevel - b.magicLevel)[0];

  actions.push({
    method:       "TELEPORT_SPELL",
    priority:     1,
    action:       bestSpell ? `Cast ${bestSpell.name}` : "No teleport spell available",
    tool:         "perform_action",
    toolArgs:     bestSpell ? { type: "cast_spell", spell: bestSpell.name } : {},
    description:  bestSpell ? `Cast ${bestSpell.name} (Magic ${bestSpell.magicLevel})` : "No spell runes in inventory",
    available:    !!bestSpell && canTele,
    blockedReason: !canTele ? `Teleport blocked above level 20 wilderness (currently ${wildernessLevel})`
      : !bestSpell ? "No spell available — missing magic level or runes"
      : undefined,
  });

  // ── 2. Teleport item ────────────────────────────────────────────────────
  const teleItem = findTeleportItem(inventory);
  actions.push({
    method:       "TELEPORT_ITEM",
    priority:     2,
    action:       teleItem ? `Use ${teleItem.name}` : "No teleport item in inventory",
    tool:         "interact_with",
    toolArgs:     teleItem ? { itemName: teleItem.name, action: "Rub" } : {},
    description:  teleItem ? `Rub ${teleItem.name} to teleport` : "No charged teleport jewellery found",
    available:    !!teleItem && canTeleItem,
    blockedReason: !canTeleItem ? `Item teleports blocked above level 30 wilderness (currently ${wildernessLevel})`
      : !teleItem ? "No teleport items found in inventory"
      : undefined,
  });

  // ── 3. Run to wilderness ditch ──────────────────────────────────────────
  actions.push({
    method:       "RUN_TO_DITCH",
    priority:     3,
    action:       "Run south to wilderness ditch",
    tool:         "walk_route_to",
    toolArgs:     { destination: "wilderness_level_1", runMode: true, urgency: "high" },
    description:  "Run south to the wilderness ditch — safest option if no teleport",
    available:    true,
  });

  // ── 4. Emergency drop ───────────────────────────────────────────────────
  // Drop most valuable non-kept items to reduce risk before dying
  actions.push({
    method:       "EMERGENCY_DROP",
    priority:     4,
    action:       "Drop valuable items to reduce death risk",
    tool:         "skill_manage_inventory",
    toolArgs:     { action: "emergency_drop_valuables" },
    description:  "Drop items above kept threshold to minimise GP lost on death",
    available:    urgency === "CRITICAL",
    blockedReason: urgency !== "CRITICAL" ? "Emergency drop only triggered at CRITICAL urgency" : undefined,
  });

  // ── 5. Logout ────────────────────────────────────────────────────────────
  actions.push({
    method:       "LOGOUT",
    priority:     5,
    action:       "Log out immediately",
    tool:         "perform_action",
    toolArgs:     { type: "logout" },
    description:  "Last resort — log out (10-tick delay, blocked if in combat)",
    available:    true,
  });

  const available = actions.filter((a) => a.available);
  const bestAction = available.sort((a, b) => a.priority - b.priority)[0] ?? null;

  return {
    threat:          threat.fleeReason || `${threat.overallThreat} threat`,
    wildernessLevel,
    bestMethod:      bestAction?.method ?? null,
    actions,
    canEscape:       available.length > 0,
    urgency,
  };
}

/**
 * Get the single best escape action to execute right now.
 * Returns null if no escape needed or all methods blocked.
 */
export function getBestEscapeAction(
  snapshot: RuneLiteSnapshot,
  wildernessLevel: number
): EscapeAction | null {
  const plan = buildEscapePlan(snapshot, wildernessLevel);
  if (!plan.canEscape) return null;
  return plan.actions.filter((a) => a.available).sort((a, b) => a.priority - b.priority)[0] ?? null;
}

/**
 * Full escape check — call every tick when in wilderness.
 * Returns null if safe, or the action to take if threatened.
 */
export function checkAndEscape(
  snapshot: RuneLiteSnapshot
): EscapeAction | null {
  const wildy = getWildernessLevelFromSnapshot(snapshot);
  if (!wildy.inWilderness) return null;

  const threat = assessThreats(snapshot, wildy.level);
  if (!threat.shouldFlee) return null;

  return getBestEscapeAction(snapshot, wildy.level);
}

/** Format escape plan for dashboard display */
export function formatEscapePlan(plan: EscapePlan): string {
  const lines = [
    `Escape Plan [${plan.urgency}] — Wildy ${plan.wildernessLevel}`,
    `Threat: ${plan.threat}`,
    `Best method: ${plan.bestMethod ?? "NONE AVAILABLE"}`,
    "Available options:",
  ];
  for (const action of plan.actions) {
    const status = action.available ? "✓" : `✗ (${action.blockedReason ?? "unavailable"})`;
    lines.push(`  ${action.priority}. ${action.method}: ${action.description} [${status}]`);
  }
  return lines.join("\n");
}
