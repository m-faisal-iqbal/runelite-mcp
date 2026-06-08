// ─── GE Price Cache ───────────────────────────────────────────────────────────
// Live price lookup with staleness TTL and refresh logic.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(moduleDir, "..", "..", "data", "knowledge");
const PRICES_FILE = path.join(DATA_DIR, "ge_prices.json");
const ITEMS_FILE  = path.join(DATA_DIR, "items.json");

const PRICE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const GE_TAX_RATE  = 0.01;           // 1% GE tax (capped at 5M gp)
const GE_TAX_CAP   = 5_000_000;  // only hits at 500M+ gp sell prices

export type PriceEntry = {
  id: number;
  high?: number;
  low?: number;
  highTime?: number;
  lowTime?: number;
};

export type WikiItem = {
  id: number;
  name: string;
  members: boolean;
  geLimit?: number;
  storeValue?: number;
  highAlch?: number;
  lowAlch?: number;
};

export type PriceResult = {
  id: number;
  name: string;
  high: number;
  low: number;
  midpoint: number;
  margin: number;
  marginAfterTax: number;
  tax: number;
  geLimit?: number;
  highAlch?: number;
  members: boolean;
  stale: boolean;
  fetchedAt: number;
};

// ─── Module-level caches ──────────────────────────────────────────────────────

let _priceMap: Map<number, PriceEntry> | null = null;
let _itemMap:  Map<string, WikiItem>   | null = null;
let _itemById: Map<number, WikiItem>   | null = null;
let _fetchedAt = 0;

function loadPrices(): Map<number, PriceEntry> {
  if (_priceMap && Date.now() - _fetchedAt < PRICE_TTL_MS) return _priceMap;

  _priceMap = new Map();
  if (!existsSync(PRICES_FILE)) return _priceMap;

  try {
    const raw = JSON.parse(readFileSync(PRICES_FILE, "utf8"));
    const arr: PriceEntry[] = Array.isArray(raw)
      ? raw
      : Array.isArray(raw.prices)
      ? raw.prices
      : Object.entries(raw).map(([k, v]: [string, unknown]) => ({ id: Number(k), ...(v as object) }));

    for (const e of arr) {
      if (e?.id != null) _priceMap.set(Number(e.id), e);
    }
    _fetchedAt = Date.now();
  } catch {
    // silently return empty map
  }
  return _priceMap;
}

function loadItems(): { byName: Map<string, WikiItem>; byId: Map<number, WikiItem> } {
  if (_itemMap && _itemById) return { byName: _itemMap, byId: _itemById };

  _itemMap  = new Map();
  _itemById = new Map();
  if (!existsSync(ITEMS_FILE)) return { byName: _itemMap, byId: _itemById };

  try {
    const raw = JSON.parse(readFileSync(ITEMS_FILE, "utf8")) as WikiItem[];
    for (const item of raw) {
      if (!item?.name) continue;
      _itemMap.set(item.name.toLowerCase().trim(), item);
      if (item.id != null) _itemById.set(Number(item.id), item);
    }
  } catch {
    // silently return empty maps
  }
  return { byName: _itemMap, byId: _itemById };
}

// ─── GE Tax calculation ───────────────────────────────────────────────────────

export function calcTax(sellPrice: number): number {
  return Math.min(Math.floor(sellPrice * GE_TAX_RATE), GE_TAX_CAP);
}

export function calcMarginAfterTax(high: number, low: number): number {
  return high - low - calcTax(high);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getPrice(itemId: number): PriceEntry | undefined {
  return loadPrices().get(itemId);
}

export function getPriceByName(name: string): PriceResult | undefined {
  const { byName, byId } = loadItems();
  const item = byName.get(name.toLowerCase().trim())
    ?? [...byName.values()].find((i) => i.name.toLowerCase().includes(name.toLowerCase()));
  if (!item) return undefined;

  const prices = loadPrices();
  const price  = prices.get(item.id);
  const high   = price?.high ?? item.storeValue ?? 0;
  const low    = price?.low  ?? Math.floor((item.storeValue ?? 0) * 0.8);
  const mid    = Math.floor((high + low) / 2);
  const tax    = calcTax(high);
  const margin = high - low;
  const stale  = !price || Date.now() - _fetchedAt > PRICE_TTL_MS;

  return {
    id:             item.id,
    name:           item.name,
    high,
    low,
    midpoint:       mid,
    margin,
    marginAfterTax: margin - tax,
    tax,
    geLimit:        item.geLimit,
    highAlch:       item.highAlch,
    members:        item.members,
    stale,
    fetchedAt:      _fetchedAt,
  };
}

export function getPriceById(itemId: number): PriceResult | undefined {
  const { byId } = loadItems();
  const item = byId.get(itemId);
  if (!item) return undefined;
  return getPriceByName(item.name);
}

/** Reload prices from disk (call after scraper refresh) */
export function invalidatePriceCache(): void {
  _priceMap  = null;
  _fetchedAt = 0;
}

/** Items with best flip margins (high-low-tax), optionally filtered by GE limit */
export function getTopMarginItems(
  topN = 20,
  minGeLimit = 0
): PriceResult[] {
  const { byName } = loadItems();
  const prices = loadPrices();
  const results: PriceResult[] = [];

  for (const item of byName.values()) {
    const price = prices.get(item.id);
    if (!price?.high || !price?.low) continue;
    if (minGeLimit > 0 && (item.geLimit ?? 0) < minGeLimit) continue;
    const margin = calcMarginAfterTax(price.high, price.low);
    if (margin <= 0) continue;
    results.push({
      id: item.id, name: item.name,
      high: price.high, low: price.low,
      midpoint: Math.floor((price.high + price.low) / 2),
      margin: price.high - price.low,
      marginAfterTax: margin,
      tax: calcTax(price.high),
      geLimit: item.geLimit, highAlch: item.highAlch,
      members: item.members, stale: false, fetchedAt: _fetchedAt,
    });
  }

  return results.sort((a, b) => b.marginAfterTax - a.marginAfterTax).slice(0, topN);
}


