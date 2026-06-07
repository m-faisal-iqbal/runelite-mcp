// ─── Prerequisite Checker ─────────────────────────────────────────────────────
// Verifies all requirements before starting or continuing a quest.

import type { RuneLiteSnapshot } from "../client.js";
import { getQuestDefinition } from "./quest-registry.js";
import { getQuestState } from "./quest-state-machine.js";

export type SkillLevels = Record<string, number>;

export type PrereqResult = {
  questId: string;
  questName: string;
  canStart: boolean;
  blockers: PrereqBlocker[];
  warnings: string[];
  readyItems: string[];
  missingItems: string[];
};

export type PrereqBlocker = {
  type: "skill" | "quest" | "item" | "quest_points" | "members";
  description: string;
  current?: number | string;
  required?: number | string;
};

/** Read a skill level from snapshot */
function getSkillLevel(snapshot: RuneLiteSnapshot, skillName: string): number {
  const skills = snapshot?.skills;
  if (!skills || typeof skills !== "object") return 1;
  const key = skillName.toLowerCase();
  // Plugin may use various shapes: {attack: {level:40}} or {attack: 40}
  const val = skills[key] ?? skills[skillName];
  if (val == null) return 1;
  if (typeof val === "number") return val;
  if (typeof val === "object") return Number(val.level ?? val.boosted ?? 1);
  return 1;
}

/** Read inventory item names from snapshot */
function getInventoryItems(snapshot: RuneLiteSnapshot): string[] {
  const inv = snapshot?.inventory;
  if (!Array.isArray(inv)) return [];
  return inv
    .filter((i) => i && i.name)
    .map((i) => String(i.name).toLowerCase().trim());
}

/** Count how many of an item are in inventory */
function countInInventory(snapshot: RuneLiteSnapshot, itemName: string): number {
  const inv = snapshot?.inventory;
  if (!Array.isArray(inv)) return 0;
  const norm = itemName.toLowerCase().trim();
  return inv.filter((i) => i && String(i.name ?? "").toLowerCase().trim() === norm)
            .reduce((sum, i) => sum + (Number(i.quantity) || 1), 0);
}

/** Read quest point count from snapshot state */
function getQuestPoints(snapshot: RuneLiteSnapshot): number {
  const state = snapshot?.state;
  if (!state) return 0;
  return Number(state.questPoints ?? state.quest_points ?? 0);
}

/**
 * Check all prerequisites for a quest.
 * Uses live snapshot for skill levels, inventory, and completed quests.
 */
export function checkPrerequisites(
  questName: string,
  snapshot: RuneLiteSnapshot
): PrereqResult {
  const def = getQuestDefinition(questName);

  if (!def) {
    return {
      questId: questName,
      questName,
      canStart: false,
      blockers: [{ type: "quest", description: `Quest "${questName}" not found in registry` }],
      warnings: [],
      readyItems: [],
      missingItems: [],
    };
  }

  const blockers: PrereqBlocker[] = [];
  const warnings: string[] = [];
  const readyItems: string[] = [];
  const missingItems: string[] = [];

  // ── Members check ─────────────────────────────────────────────────────────
  if (def.members) {
    warnings.push("This is a members-only quest — requires P2P account");
  }

  // ── Skill requirements ────────────────────────────────────────────────────
  for (const req of def.requirements) {
    if (req.skill === "Quest Points") {
      const current = getQuestPoints(snapshot);
      if (current < req.level) {
        blockers.push({
          type: "quest_points",
          description: `Need ${req.level} Quest Points (have ${current})`,
          current,
          required: req.level,
        });
      }
      continue;
    }
    const current = getSkillLevel(snapshot, req.skill);
    if (current < req.level) {
      blockers.push({
        type: "skill",
        description: `Need ${req.skill} level ${req.level} (have ${current})`,
        current,
        required: req.level,
      });
    }
  }

  // ── Item requirements ─────────────────────────────────────────────────────
  for (const itemReq of def.itemRequirements) {
    const have = countInInventory(snapshot, itemReq.item);
    if (have >= itemReq.quantity) {
      readyItems.push(`${itemReq.item} x${itemReq.quantity}`);
    } else {
      missingItems.push(`${itemReq.item} x${itemReq.quantity} (have ${have})`);
      // Missing consumable items are warnings not hard blockers
      // (agent can go collect them)
      warnings.push(`Missing: ${itemReq.item} x${itemReq.quantity}`);
    }
  }

  // ── Prerequisite quests ───────────────────────────────────────────────────
  // (registry doesn't track inter-quest deps yet beyond QP requirement)
  // Placeholder for future inter-quest dependency checking

  const canStart = blockers.length === 0;

  return {
    questId: def.id,
    questName: def.name,
    canStart,
    blockers,
    warnings,
    readyItems,
    missingItems,
  };
}

/**
 * Quick check: can the player start this quest right now?
 * Returns true only if zero hard blockers.
 */
export function canStartQuest(questName: string, snapshot: RuneLiteSnapshot): boolean {
  return checkPrerequisites(questName, snapshot).canStart;
}

/**
 * Build a preparation plan: what the agent needs to do before starting a quest.
 * Returns ordered list of tasks.
 */
export function buildPrepPlan(
  questName: string,
  snapshot: RuneLiteSnapshot
): { task: string; priority: "blocker" | "recommended" }[] {
  const result = checkPrerequisites(questName, snapshot);
  const plan: { task: string; priority: "blocker" | "recommended" }[] = [];

  for (const blocker of result.blockers) {
    plan.push({ task: blocker.description, priority: "blocker" });
  }
  for (const item of result.missingItems) {
    plan.push({ task: `Obtain ${item}`, priority: "recommended" });
  }
  // Warnings that are not already covered by missing items
  for (const warn of result.warnings) {
    const alreadyCovered = result.missingItems.some((m) => warn.includes(m.split(" x")[0]));
    if (!alreadyCovered && !plan.some((p) => p.task === warn)) {
      plan.push({ task: warn, priority: "recommended" });
    }
  }

  return plan;
}

