import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
function readJson(filename) {
    return JSON.parse(readFileSync(join(fileURLToPath(import.meta.url), "..", "..", "data", "knowledge", filename), "utf-8"));
}
// ---------------------------------------------------------------------------
// Module-level caches (loaded once on first access)
// ---------------------------------------------------------------------------
let monstersCache;
let questsCache;
let itemsCache;
let itemsByNameCache;
let monstersByNameCache;
let questsByNameCache;
let pricesCache;
let skillIndexCache;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function slug(name) {
    return name.toLowerCase().replace(/\s+/g, "_");
}
function normalizeDifficulty(raw) {
    const lower = raw.toLowerCase();
    if (lower === "tutorial")
        return "tutorial";
    if (lower === "novice")
        return "novice";
    if (lower === "intermediate")
        return "intermediate";
    if (lower === "experienced")
        return "experienced";
    if (lower === "master")
        return "master";
    if (lower === "grandmaster")
        return "grandmaster";
    return "novice"; // safe fallback
}
// ---------------------------------------------------------------------------
// Public loaders
// ---------------------------------------------------------------------------
export function loadMonsters() {
    if (monstersCache)
        return monstersCache;
    const raw = readJson("monsters.json");
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
export function loadQuests() {
    if (questsCache)
        return questsCache;
    const raw = readJson("quests.json");
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
export function loadItems() {
    if (itemsCache)
        return itemsCache;
    const raw = readJson("items.json");
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
export function loadGePrices() {
    if (pricesCache)
        return pricesCache;
    const raw = readJson("ge_prices.json");
    pricesCache = new Map();
    for (const [key, entry] of Object.entries(raw)) {
        const id = Number(key);
        if (Number.isFinite(id) && entry.high != null && entry.low != null) {
            pricesCache.set(id, { high: entry.high, low: entry.low });
        }
    }
    return pricesCache;
}
export function getCachedPrice(itemId) {
    return loadGePrices().get(itemId);
}
export function findItemByName(name) {
    loadItems();
    return itemsByNameCache?.get(name.toLowerCase());
}
export function findMonsterByName(name) {
    loadMonsters();
    return monstersByNameCache?.get(name.toLowerCase());
}
export function findQuestByName(name) {
    loadQuests();
    return questsByNameCache?.get(name.toLowerCase());
}
export function loadSkillIndex() {
    if (skillIndexCache)
        return skillIndexCache;
    skillIndexCache = readJson("skill_index.json");
    return skillIndexCache;
}
