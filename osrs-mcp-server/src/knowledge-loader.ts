import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { KnowledgeMonster, KnowledgeQuest } from "./knowledge-base.js";

function readJson(filename: string): unknown {
  return JSON.parse(
    readFileSync(
      join(fileURLToPath(import.meta.url), "..", "..", "data", "knowledge", filename),
      "utf-8"
    )
  );
}

// ---------------------------------------------------------------------------
// Raw JSON shapes (matching the scraped wiki data)
// ---------------------------------------------------------------------------

interface RawMonster {
  name: string;
  members: boolean;
  combat_level: number | null;
  attack_style: string[] | null;
  slayer_level: number | null;
}

interface RawQuest {
  name: string;
  members: boolean;
  difficulty: string;
  quest_points: number;
}

export interface WikiItem {
  id: number;
  name: string;
  members: boolean;
  geLimit: number;
  storeValue: number;
  highAlch: number;
  lowAlch: number;
}

interface RawItem {
  id: number;
  name: string;
  members: boolean;
  limit: number;
  value: number;
  highalch: number;
  lowalch: number;
}

interface PriceEntry {
  high: number;
  low: number;
  highTime: number;
  lowTime: number;
}

// GE prices file is keyed by item ID string: { "2": { high, low, ... } }
type RawGePrices = Record<string, PriceEntry>;

interface SkillIndexEntry {
  f2p_guide?: string | null;
  p2p_guide?: string | null;
  f2p_training?: string[];
  p2p_training?: string[];
}

type RawSkillIndex = Record<string, SkillIndexEntry>;

// ---------------------------------------------------------------------------
// Module-level caches (loaded once on first access)
// ---------------------------------------------------------------------------

let monstersCache: KnowledgeMonster[] | undefined;
let questsCache: KnowledgeQuest[] | undefined;
let itemsCache: WikiItem[] | undefined;
let itemsByNameCache: Map<string, WikiItem> | undefined;
let monstersByNameCache: Map<string, KnowledgeMonster> | undefined;
let questsByNameCache: Map<string, KnowledgeQuest> | undefined;
let pricesCache: Map<number, { high: number; low: number }> | undefined;
let skillIndexCache: RawSkillIndex | undefined;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "_");
}

function normalizeDifficulty(raw: string): KnowledgeQuest["difficulty"] {
  const lower = raw.toLowerCase();
  if (lower === "tutorial") return "tutorial";
  if (lower === "novice") return "novice";
  if (lower === "intermediate") return "intermediate";
  if (lower === "experienced") return "experienced";
  if (lower === "master") return "master";
  if (lower === "grandmaster") return "grandmaster";
  return "novice"; // safe fallback
}

// ---------------------------------------------------------------------------
// Public loaders
// ---------------------------------------------------------------------------

export function loadMonsters(): KnowledgeMonster[] {
  if (monstersCache) return monstersCache;

  const raw = readJson("monsters.json") as RawMonster[];
  monstersCache = raw.map((m) => ({
    id: slug(m.name),
    name: m.name,
    members: m.members,
    combatLevel: m.combat_level ?? undefined,
    locations: [],
    attackStyle: (m.attack_style ?? []).join(", ") || undefined,
    weaknesses: [],
    usefulDrops: [],
    requirements: m.slayer_level ? [`Slayer level ${m.slayer_level}`] : [],
    tactics: [],
    risks: [],
  }));

  monstersByNameCache = new Map(monstersCache.map((m) => [m.name.toLowerCase(), m]));
  return monstersCache;
}

export function loadQuests(): KnowledgeQuest[] {
  if (questsCache) return questsCache;

  const raw = readJson("quests.json") as RawQuest[];
  questsCache = raw.map((q) => ({
    id: slug(q.name),
    name: q.name,
    members: q.members,
    difficulty: normalizeDifficulty(q.difficulty),
    requirements: [],
    recommended: [],
    rewards: [`${q.quest_points} quest point${q.quest_points !== 1 ? "s" : ""}`],
    start: "",
    steps: [],
    risks: [],
    notes: [],
  }));

  questsByNameCache = new Map(questsCache.map((q) => [q.name.toLowerCase(), q]));
  return questsCache;
}

export function loadItems(): WikiItem[] {
  if (itemsCache) return itemsCache;

  const raw = readJson("items.json") as RawItem[];
  itemsCache = raw.map((item) => ({
    id: item.id,
    name: item.name,
    members: item.members,
    geLimit: item.limit ?? 0,
    storeValue: item.value ?? 0,
    highAlch: item.highalch ?? 0,
    lowAlch: item.lowalch ?? 0,
  }));

  itemsByNameCache = new Map(itemsCache.map((item) => [item.name.toLowerCase(), item]));
  return itemsCache;
}

export function loadGePrices(): Map<number, { high: number; low: number }> {
  if (pricesCache) return pricesCache;

  const raw = readJson("ge_prices.json") as RawGePrices;
  pricesCache = new Map();

  for (const [key, entry] of Object.entries(raw)) {
    const id = Number(key);
    if (Number.isFinite(id) && entry.high != null && entry.low != null) {
      pricesCache.set(id, { high: entry.high, low: entry.low });
    }
  }

  return pricesCache;
}

export function getCachedPrice(itemId: number): { high: number; low: number } | undefined {
  return loadGePrices().get(itemId);
}

export function findItemByName(name: string): WikiItem | undefined {
  loadItems();
  return itemsByNameCache?.get(name.toLowerCase());
}

export function findMonsterByName(name: string): KnowledgeMonster | undefined {
  loadMonsters();
  return monstersByNameCache?.get(name.toLowerCase());
}

export function findQuestByName(name: string): KnowledgeQuest | undefined {
  loadQuests();
  return questsByNameCache?.get(name.toLowerCase());
}

export function loadSkillIndex(): RawSkillIndex {
  if (skillIndexCache) return skillIndexCache;
  skillIndexCache = readJson("skill_index.json") as RawSkillIndex;
  return skillIndexCache;
}
