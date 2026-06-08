// ─── Profit Calculator ────────────────────────────────────────────────────────
// GP/hr and XP/hr estimates for skilling, bossing, and GE flipping.

import { getPriceByName, calcTax, calcMarginAfterTax, type PriceResult } from "./ge-price-cache.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProfitMethod = {
  name: string;
  category: "skilling" | "bossing" | "processing" | "flipping";
  gpPerHour: number;
  xpPerHour?: number;
  skill?: string;
  itemsConsumed?: { name: string; quantityPerHour: number }[];
  itemsProduced?: { name: string; quantityPerHour: number }[];
  requirements?: string[];
  notes?: string;
};

export type FlipAnalysis = {
  itemName:        string;
  itemId:          number;
  buyPrice:        number;
  sellPrice:       number;
  margin:          number;
  marginAfterTax:  number;
  tax:             number;
  geLimit:         number;
  maxProfitPerLot: number;   // margin * geLimit
  roi:             number;   // marginAfterTax / buyPrice as %
  flipTimeMinutes: number;   // estimated time to complete one lot
  gpPerHour:       number;   // estimated GP/hr
  worthFlipping:   boolean;
  reason:          string;
};

// ─── Skilling profit methods (curated) ────────────────────────────────────────

const SKILLING_METHODS: ProfitMethod[] = [
  {
    name: "Cutting yew logs",
    category: "skilling",
    gpPerHour: 50_000,
    xpPerHour: 35_000,
    skill: "Woodcutting",
    itemsProduced: [{ name: "Yew logs", quantityPerHour: 150 }],
    requirements: ["Woodcutting 60"],
    notes: "F2P viable. Falador park or Edgeville yews.",
  },
  {
    name: "Cutting magic logs",
    category: "skilling",
    gpPerHour: 90_000,
    xpPerHour: 20_000,
    skill: "Woodcutting",
    itemsProduced: [{ name: "Magic logs", quantityPerHour: 80 }],
    requirements: ["Woodcutting 75"],
    notes: "Members only. Best near bank.",
  },
  {
    name: "Mining iron ore (3-tick)",
    category: "skilling",
    gpPerHour: 130_000,
    xpPerHour: 60_000,
    skill: "Mining",
    itemsProduced: [{ name: "Iron ore", quantityPerHour: 750 }],
    requirements: ["Mining 15"],
    notes: "3-tick method. Al Kharid or Varrock East mine.",
  },
  {
    name: "Mining coal",
    category: "skilling",
    gpPerHour: 80_000,
    xpPerHour: 25_000,
    skill: "Mining",
    itemsProduced: [{ name: "Coal", quantityPerHour: 420 }],
    requirements: ["Mining 30"],
    notes: "Mining Guild for best rates.",
  },
  {
    name: "Fishing lobsters (Karamja)",
    category: "skilling",
    gpPerHour: 55_000,
    xpPerHour: 30_000,
    skill: "Fishing",
    itemsProduced: [{ name: "Raw lobster", quantityPerHour: 330 }],
    requirements: ["Fishing 40"],
    notes: "F2P. Best with Amulet of Glory for banking.",
  },
  {
    name: "Fishing sharks",
    category: "skilling",
    gpPerHour: 120_000,
    xpPerHour: 35_000,
    skill: "Fishing",
    itemsProduced: [{ name: "Raw shark", quantityPerHour: 150 }],
    requirements: ["Fishing 76"],
    notes: "Members. Catherby or Fishing Guild.",
  },
  {
    name: "Tanning leather (Al Kharid)",
    category: "processing",
    gpPerHour: 450_000,
    xpPerHour: 0,
    skill: "Crafting",
    itemsConsumed: [{ name: "Cowhide", quantityPerHour: 5_400 }, { name: "Coins", quantityPerHour: 81_000 }],
    itemsProduced: [{ name: "Leather", quantityPerHour: 5_400 }],
    requirements: ["Crafting 1"],
    notes: "GE buy cowhides, tan at Al Kharid tanner. High volume, small margin per item.",
  },
  {
    name: "Crafting gold bars into amulets",
    category: "processing",
    gpPerHour: -50_000,
    xpPerHour: 130_000,
    skill: "Crafting",
    itemsConsumed: [{ name: "Gold bar", quantityPerHour: 2_800 }],
    itemsProduced: [{ name: "Gold amulet (u)", quantityPerHour: 2_800 }],
    requirements: ["Crafting 8"],
    notes: "XP-focused. Usually a loss unless enchanting.",
  },
  {
    name: "Green dragon killing",
    category: "bossing",
    gpPerHour: 350_000,
    xpPerHour: 50_000,
    skill: "Combat",
    itemsConsumed: [{ name: "Food", quantityPerHour: 30 }],
    itemsProduced: [{ name: "Green dragonhide", quantityPerHour: 250 }, { name: "Dragon bones", quantityPerHour: 250 }],
    requirements: ["Combat ~70+", "Antifire shield or antifire potion (members)"],
    notes: "Members wilderness or Resource Area. High risk in wildy.",
  },
  {
    name: "Killing hill giants (F2P)",
    category: "bossing",
    gpPerHour: 100_000,
    xpPerHour: 25_000,
    skill: "Combat",
    itemsProduced: [{ name: "Big bones", quantityPerHour: 180 }, { name: "Limpwurt root", quantityPerHour: 30 }],
    requirements: ["Combat ~40+"],
    notes: "F2P. Edgeville dungeon. Big bones for prayer training.",
  },
];

export function getSkillingMethods(
  skill?: string,
  category?: ProfitMethod["category"]
): ProfitMethod[] {
  return SKILLING_METHODS.filter((m) => {
    if (skill && m.skill?.toLowerCase() !== skill.toLowerCase()) return false;
    if (category && m.category !== category) return false;
    return true;
  }).sort((a, b) => b.gpPerHour - a.gpPerHour);
}

// ─── Flip analysis ────────────────────────────────────────────────────────────

const MIN_MARGIN_GP      = 100;
const MIN_ROI_PERCENT    = 0.5;
const FLIP_TIME_MINUTES  = 5;   // assume ~5 min average flip time per lot

export function analyseFlip(
  itemName: string,
  overrideBuy?: number,
  overrideSell?: number
): FlipAnalysis | null {
  const price = getPriceByName(itemName);
  if (!price) return null;

  const buy  = overrideBuy  ?? price.low;
  const sell = overrideSell ?? price.high;
  const tax  = calcTax(sell);
  const margin = sell - buy;
  const marginAfterTax = margin - tax;
  const geLimit = price.geLimit ?? 1;
  const maxProfitPerLot = marginAfterTax * geLimit;
  const roi = buy > 0 ? (marginAfterTax / buy) * 100 : 0;
  const gpPerHour = (maxProfitPerLot / FLIP_TIME_MINUTES) * 60;

  const worthFlipping = marginAfterTax >= MIN_MARGIN_GP && roi >= MIN_ROI_PERCENT;
  let reason = worthFlipping
    ? `Margin ${marginAfterTax.toLocaleString()} gp after tax, ROI ${roi.toFixed(2)}%`
    : marginAfterTax < MIN_MARGIN_GP
    ? `Margin too low (${marginAfterTax} gp < ${MIN_MARGIN_GP} minimum)`
    : `ROI too low (${roi.toFixed(2)}% < ${MIN_ROI_PERCENT}% minimum)`;

  return {
    itemName: price.name,
    itemId:   price.id,
    buyPrice:  buy,
    sellPrice: sell,
    margin,
    marginAfterTax,
    tax,
    geLimit,
    maxProfitPerLot,
    roi,
    flipTimeMinutes: FLIP_TIME_MINUTES,
    gpPerHour:  Math.round(gpPerHour),
    worthFlipping,
    reason,
  };
}

/** Calculate net profit from a completed session */
export function calcSessionProfit(
  gpStart: number,
  gpEnd: number,
  itemsCollected: { name: string; quantity: number }[]
): {
  rawGpChange:  number;
  itemValue:    number;
  totalProfit:  number;
  profitPerHour: (sessionMinutes: number) => number;
} {
  const rawGpChange = gpEnd - gpStart;
  let itemValue = 0;
  for (const item of itemsCollected) {
    const price = getPriceByName(item.name);
    if (price) itemValue += price.low * item.quantity;
  }
  const totalProfit = rawGpChange + itemValue;
  return {
    rawGpChange,
    itemValue,
    totalProfit,
    profitPerHour: (mins: number) => Math.round((totalProfit / mins) * 60),
  };
}
