// ─── Loot Filter ─────────────────────────────────────────────────────────────

export type LootRule = {
  itemName: string;       // exact match, case-insensitive
  mode: "always" | "never" | "value_threshold";
  minValue?: number;      // used when mode === "value_threshold"
};

export type LootFilterConfig = {
  rules: LootRule[];
  defaultMinValue: number;   // min GP value to pick up (high price * qty)
  alwaysLootBones: boolean;
  alwaysLootCoins: boolean;
  alwaysLootSeeds: boolean;
  alwaysLootRunes: boolean;
  neverLootJunk: boolean;    // noted herbs, headless arrows, etc.
};

const JUNK_ITEMS = new Set([
  "bones", "burnt bones", "headless arrows", "cave goblin wire",
  "broken arrow", "broken staff", "pot", "bucket", "empty jug",
]);

const BONE_NAMES = new Set([
  "bones", "big bones", "dragon bones", "wyvern bones", "lava dragon bones",
  "superior dragon bones", "dagannoth bones", "babydragon bones",
  "ourg bones", "zogre bones", "shaikahan bones", "jogre bones",
  "monkey bones", "wolf bones", "bat bones", "burnt bones",
]);

const RUNE_PATTERN = /rune|arrow|bolt|dart/i;

export function defaultLootConfig(): LootFilterConfig {
  return {
    rules: [
      { itemName: "clue scroll (easy)",    mode: "always" },
      { itemName: "clue scroll (medium)",  mode: "always" },
      { itemName: "clue scroll (hard)",    mode: "always" },
      { itemName: "clue scroll (elite)",   mode: "always" },
      { itemName: "clue scroll (master)",  mode: "always" },
      { itemName: "ensouled head",         mode: "always" },
      { itemName: "loop half of key",      mode: "always" },
      { itemName: "tooth half of key",     mode: "always" },
      { itemName: "dragon med helm",       mode: "always" },
      { itemName: "uncut dragonstone",     mode: "always" },
    ],
    defaultMinValue: 1_000,
    alwaysLootBones: true,
    alwaysLootCoins: true,
    alwaysLootSeeds: false,
    alwaysLootRunes: true,
    neverLootJunk: true,
  };
}

export function shouldLoot(
  itemName: string,
  itemId: number,
  quantity: number,
  config: LootFilterConfig,
  getPrice: (id: number) => { high?: number; low?: number } | undefined
): boolean {
  const name = itemName.toLowerCase().trim();

  // Explicit rules take highest priority
  for (const rule of config.rules) {
    if (rule.itemName.toLowerCase() === name) {
      if (rule.mode === "always") return true;
      if (rule.mode === "never")  return false;
      if (rule.mode === "value_threshold") {
        const price = getPrice(itemId);
        const value = (price?.high ?? 0) * quantity;
        return value >= (rule.minValue ?? config.defaultMinValue);
      }
    }
  }

  // Coins always
  if (config.alwaysLootCoins && (name === "coins" || name === "coin")) return true;

  // Bones
  if (config.alwaysLootBones && BONE_NAMES.has(name)) return true;

  // Runes / ammo
  if (config.alwaysLootRunes && RUNE_PATTERN.test(name)) return true;

  // Seeds
  if (config.alwaysLootSeeds && name.includes("seed")) return true;

  // Junk exclusion
  if (config.neverLootJunk && JUNK_ITEMS.has(name)) return false;

  // Default: value threshold
  const price = getPrice(itemId);
  if (!price?.high && !price?.low) return false; // untradeable — skip unless ruled
  const value = (price?.high ?? price?.low ?? 0) * quantity;
  return value >= config.defaultMinValue;
}
