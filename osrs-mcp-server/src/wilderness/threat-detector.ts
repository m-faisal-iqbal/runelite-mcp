// ─── Threat Detector ─────────────────────────────────────────────────────────
// Analyses visible players + minimap to detect PvP threats.

import type { RuneLiteSnapshot } from "../client.js";
import { pvpCombatRange } from "./wilderness-risk.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ThreatLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type PlayerThreat = {
  name:          string;
  combatLevel:   number;
  worldX:        number;
  worldY:        number;
  distanceTiles: number;
  isFollowing:   boolean;    // interacting with local player
  canAttackUs:   boolean;    // within our PvP level range
  threatLevel:   ThreatLevel;
  reason:        string;
};

export type ThreatAssessment = {
  overallThreat:  ThreatLevel;
  threatCount:    number;
  closestThreat:  PlayerThreat | null;
  allThreats:     PlayerThreat[];
  shouldFlee:     boolean;
  fleeReason:     string;
  minimapDots:    number;    // total red dots on minimap
};

// Threat distance thresholds (tiles)
const CRITICAL_DISTANCE = 5;
const HIGH_DISTANCE     = 10;
const MEDIUM_DISTANCE   = 20;

// ─── Parse visible players from snapshot ─────────────────────────────────────

type RawPlayer = {
  name?: string;
  combatLevel?: number;
  worldX?: number;
  worldY?: number;
  distanceToPlayer?: number;
  interactingWith?: string;
};

function getVisiblePlayers(snapshot: RuneLiteSnapshot): RawPlayer[] {
  const players = snapshot?.players;
  if (!Array.isArray(players)) return [];
  return players.filter((p) => p && typeof p === "object") as RawPlayer[];
}

function getLocalPlayerName(snapshot: RuneLiteSnapshot): string {
  return String(snapshot?.state?.name ?? "");
}

function getLocalPlayerCombat(snapshot: RuneLiteSnapshot): number {
  return Number(snapshot?.state?.combatLevel ?? snapshot?.combat?.combatLevel ?? 3);
}

function getMinimapDotCount(snapshot: RuneLiteSnapshot): number {
  // minimapIcons not on RuneLiteSnapshot type — derive from visible players array
  // as a proxy for minimap dot count, plus any count exposed via state
  const stateCount = Number((snapshot?.state as Record<string, unknown>)?.minimapPlayerCount ?? 0);
  if (stateCount > 0) return stateCount;
  return Array.isArray(snapshot?.players) ? snapshot.players.length : 0;
}

// ─── Assess a single visible player ──────────────────────────────────────────

function assessPlayer(
  raw: RawPlayer,
  localName: string,
  localCombat: number,
  wildernessLevel: number
): PlayerThreat | null {
  const name        = String(raw.name ?? "Unknown");
  const combatLevel = Number(raw.combatLevel ?? 0);
  const worldX      = Number(raw.worldX ?? 0);
  const worldY      = Number(raw.worldY ?? 0);
  const distance    = Number(raw.distanceToPlayer ?? 999);
  const interacting = String(raw.interactingWith ?? "");

  // Skip local player
  if (name === localName || name === "") return null;

  const isFollowing = interacting === localName;
  const pvpRange    = pvpCombatRange(localCombat, wildernessLevel);
  const canAttack   = combatLevel >= pvpRange.minLevel && combatLevel <= pvpRange.maxLevel;

  // Determine threat level
  let threatLevel: ThreatLevel = "NONE";
  let reason = "";

  if (!canAttack) {
    threatLevel = "NONE";
    reason = `Combat ${combatLevel} outside our PvP range ${pvpRange.minLevel}-${pvpRange.maxLevel}`;
  } else if (isFollowing && distance <= CRITICAL_DISTANCE) {
    threatLevel = "CRITICAL";
    reason = `Following us at ${distance} tiles — imminent attack`;
  } else if (isFollowing) {
    threatLevel = "HIGH";
    reason = `Interacting with us at ${distance} tiles`;
  } else if (distance <= CRITICAL_DISTANCE) {
    threatLevel = "HIGH";
    reason = `Within ${distance} tiles — within melee range`;
  } else if (distance <= HIGH_DISTANCE) {
    threatLevel = "MEDIUM";
    reason = `Within ${distance} tiles — closing distance possible`;
  } else if (distance <= MEDIUM_DISTANCE) {
    threatLevel = "LOW";
    reason = `Visible at ${distance} tiles`;
  } else {
    threatLevel = "NONE";
    reason = `Far away at ${distance} tiles`;
  }

  return { name, combatLevel, worldX, worldY, distanceTiles: distance, isFollowing, canAttackUs: canAttack, threatLevel, reason };
}

// ─── Overall threat assessment ────────────────────────────────────────────────

const THREAT_ORDER: ThreatLevel[] = ["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

function maxThreat(a: ThreatLevel, b: ThreatLevel): ThreatLevel {
  return THREAT_ORDER.indexOf(a) >= THREAT_ORDER.indexOf(b) ? a : b;
}

export function assessThreats(
  snapshot: RuneLiteSnapshot,
  wildernessLevel: number
): ThreatAssessment {
  const localName   = getLocalPlayerName(snapshot);
  const localCombat = getLocalPlayerCombat(snapshot);
  const rawPlayers  = getVisiblePlayers(snapshot);
  const minimapDots = getMinimapDotCount(snapshot);

  const threats: PlayerThreat[] = rawPlayers
    .map((p) => assessPlayer(p, localName, localCombat, wildernessLevel))
    .filter((t): t is PlayerThreat => t !== null && t.threatLevel !== "NONE");

  threats.sort((a, b) => THREAT_ORDER.indexOf(b.threatLevel) - THREAT_ORDER.indexOf(a.threatLevel));

  const overallThreat: ThreatLevel = threats.length > 0
    ? threats[0].threatLevel
    : minimapDots > 2 ? "LOW" : "NONE";

  const shouldFlee = overallThreat === "CRITICAL" || overallThreat === "HIGH"
    || (minimapDots > 3 && wildernessLevel > 20);

  const fleeReason = shouldFlee
    ? threats[0]
      ? `${threats[0].name} (${threats[0].combatLevel} cb) — ${threats[0].reason}`
      : `${minimapDots} players visible in deep wilderness`
    : "";

  return {
    overallThreat,
    threatCount:   threats.length,
    closestThreat: threats[0] ?? null,
    allThreats:    threats,
    shouldFlee,
    fleeReason,
    minimapDots,
  };
}

/** Quick check: is there an immediate threat requiring action this tick? */
export function isImmediateThreat(snapshot: RuneLiteSnapshot, wildernessLevel: number): boolean {
  const assessment = assessThreats(snapshot, wildernessLevel);
  return assessment.shouldFlee;
}

/** Format a threat summary for the dashboard/log */
export function formatThreatSummary(assessment: ThreatAssessment): string {
  if (assessment.overallThreat === "NONE") {
    return `SAFE — ${assessment.minimapDots} players visible, none threatening`;
  }
  const lines = [
    `THREAT: ${assessment.overallThreat} — ${assessment.threatCount} hostile player(s), ${assessment.minimapDots} minimap dots`,
  ];
  for (const t of assessment.allThreats.slice(0, 3)) {
    lines.push(`  ${t.name} (cb${t.combatLevel}) @ ${t.distanceTiles}t — ${t.reason}`);
  }
  if (assessment.shouldFlee) lines.push(`  → FLEE: ${assessment.fleeReason}`);
  return lines.join("\n");
}

