#!/usr/bin/env python3
"""
Scrape OSRS knowledge from the wiki Cargo API and GE price API.
Saves structured JSON files for the agent brain's knowledge base.

Data sources:
  - Wiki Cargo API: cargo table "Monsters"  → monsters.json
  - Wiki Cargo API: cargo table "Quests"    → quests.json
  - GE API: /mapping                        → items.json
  - GE API: /latest                         → ge_prices.json
"""

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

# ── Config ──────────────────────────────────────────────────────────────────

WIKI_API = "https://oldschool.runescape.wiki/api.php"
GE_API = "https://prices.runescape.wiki/api/v1/osrs"
OUT_DIR = Path(__file__).resolve().parent.parent / "osrs-mcp-server" / "data" / "knowledge"
UA = "osrs-agent-brain/1.0 (github.com/faisal-iqbal/osrs-mcp)"
MAX_RETRIES = 5
BACKOFF_BASE = 2
CARGO_LIMIT = 500  # max rows per Cargo query

# ── HTTP helpers ────────────────────────────────────────────────────────────

session = requests.Session()
session.headers.update({"User-Agent": UA})


def fetch(url: str, params: dict | None = None, *, retries: int = MAX_RETRIES) -> dict | list:
    """GET with retry + exponential backoff."""
    for attempt in range(1, retries + 1):
        try:
            resp = session.get(url, params=params, timeout=30)
            if resp.status_code == 429:
                wait = int(resp.headers.get("Retry-After", BACKOFF_BASE ** attempt))
                print(f"  [wait] Rate-limited, waiting {wait}s …")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        except (requests.RequestException, json.JSONDecodeError) as exc:
            wait = BACKOFF_BASE ** attempt
            print(f"  [warn] Attempt {attempt}/{retries} failed: {exc} -- retrying in {wait}s")
            time.sleep(wait)
    raise RuntimeError(f"Gave up after {retries} attempts: {url}")


# ── Cargo helpers ───────────────────────────────────────────────────────────

def query_cargo_table(
    table: str,
    fields: list[str],
    *,
    where: str | None = None,
    order_by: str | None = None,
) -> list[dict]:
    """Fetch all rows from a Cargo table, paginating via offset."""
    all_rows: list[dict] = []
    offset = 0

    while True:
        params: dict[str, str] = {
            "action": "cargoquery",
            "tables": table,
            "fields": ",".join(fields),
            "limit": str(CARGO_LIMIT),
            "offset": str(offset),
            "format": "json",
        }
        if where:
            params["where"] = where
        if order_by:
            params["order by"] = order_by

        data = fetch(WIKI_API, params)
        rows = data.get("cargoquery", [])
        if not rows:
            break

        for row in rows:
            all_rows.append(row["title"])

        if len(rows) < CARGO_LIMIT:
            break
        offset += CARGO_LIMIT
        time.sleep(0.5)  # polite rate limiting

    return all_rows


# ── Scrapers ────────────────────────────────────────────────────────────────

def _int(val) -> int | None:
    """Try to parse an integer from a string; return None on failure."""
    if val is None or val == "":
        return None
    val = str(val).strip()
    # Handle ranges like "2-5" by taking the first number
    import re
    m = re.match(r"(\d+)", val)
    return int(m.group(1)) if m else None


def scrape_monsters() -> list[dict]:
    """Fetch all monsters from Cargo table 'Monsters'."""
    print("\n[1/4] Scraping monsters from Cargo table …")

    fields = ["name", "members", "combat_level", "attack_style", "slayer_level"]
    raw_rows = query_cargo_table("Monsters", fields, order_by="name")

    monsters = []
    seen = set()
    for row in raw_rows:
        name = (row.get("name") or "").strip()
        if not name:
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)

        members_raw = (row.get("members") or "").lower()
        attack_raw = row.get("attack_style") or ""
        # attack_style can be comma-separated or contain wiki links
        import re
        attack_raw = re.sub(r"\[\[.*?\|(.*?)\]\]", r"\1", attack_raw)
        attack_raw = re.sub(r"\[\[(.*?)\]\]", r"\1", attack_raw)
        attack_styles = [s.strip() for s in attack_raw.split(",") if s.strip()]

        monsters.append({
            "name": name,
            "members": "yes" in members_raw or "true" in members_raw,
            "combat_level": _int(row.get("combat_level")),
            "attack_style": attack_styles,
            "slayer_level": _int(row.get("slayer_level")),
        })

    print(f"  [ok] {len(monsters)} unique monsters")
    return monsters


def scrape_quests() -> list[dict]:
    """Fetch all quests from Cargo table 'Quests'."""
    print("\n[2/4] Scraping quests from Cargo table …")

    fields = ["name", "members", "difficulty", "quest_points"]
    raw_rows = query_cargo_table("Quests", fields, order_by="name")

    quests = []
    seen = set()
    for row in raw_rows:
        name = (row.get("name") or "").strip()
        if not name:
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)

        members_raw = (row.get("members") or "").lower()
        difficulty = (row.get("difficulty") or "Unknown").strip()
        # Clean wiki links from difficulty
        import re
        difficulty = re.sub(r"\[\[.*?\|(.*?)\]\]", r"\1", difficulty)
        difficulty = re.sub(r"\[\[(.*?)\]\]", r"\1", difficulty)

        quests.append({
            "name": name,
            "members": "yes" in members_raw or "true" in members_raw or "members" in members_raw,
            "difficulty": difficulty,
            "quest_points": _int(row.get("quest_points")),
        })

    print(f"  [ok] {len(quests)} unique quests")
    return quests


def scrape_items() -> list[dict]:
    """Fetch all tradeable items from GE mapping endpoint."""
    print("\n[3/4] Scraping GE item mapping …")
    data = fetch(f"{GE_API}/mapping")

    items = []
    for entry in data:
        name = (entry.get("name") or "").strip()
        if not name:
            continue
        items.append({
            "id": entry.get("id"),
            "name": name,
            "members": entry.get("members", False) in ("true", True, "True", "yes", "Yes"),
            "limit": entry.get("limit"),
            "value": entry.get("value"),
            "highalch": entry.get("highalch"),
            "lowalch": entry.get("lowalch"),
        })

    print(f"  [ok] {len(items)} tradeable items")
    return items


def scrape_ge_prices() -> dict:
    """Fetch current GE prices from latest endpoint."""
    print("\n[4/4] Scraping GE latest prices …")
    data = fetch(f"{GE_API}/latest")
    prices = data.get("data", {})
    print(f"  [ok] prices for {len(prices)} items")
    return prices


# ── I/O ─────────────────────────────────────────────────────────────────────

def save_json(filename: str, data) -> int:
    """Write data as pretty-printed JSON. Returns byte size."""
    path = OUT_DIR / filename
    text = json.dumps(data, indent=2, ensure_ascii=False)
    path.write_text(text, encoding="utf-8")
    size_kb = len(text.encode("utf-8")) / 1024
    print(f"  [saved] {path} ({size_kb:.1f} KB)")
    return len(text.encode("utf-8"))


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("  OSRS Knowledge Scraper")
    print("  Source: Wiki Cargo API + GE Price API")
    print("=" * 60)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    manifest: dict = {
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "wiki_api": WIKI_API,
            "ge_api": GE_API,
        },
        "files": {},
    }

    # 1 -- Monsters
    t0 = time.time()
    monsters = scrape_monsters()
    size = save_json("monsters.json", monsters)
    manifest["files"]["monsters.json"] = {
        "count": len(monsters), "bytes": size, "seconds": round(time.time() - t0, 1)
    }

    # 2 -- Quests
    t0 = time.time()
    quests = scrape_quests()
    size = save_json("quests.json", quests)
    manifest["files"]["quests.json"] = {
        "count": len(quests), "bytes": size, "seconds": round(time.time() - t0, 1)
    }

    # 3 -- Items
    t0 = time.time()
    items = scrape_items()
    size = save_json("items.json", items)
    manifest["files"]["items.json"] = {
        "count": len(items), "bytes": size, "seconds": round(time.time() - t0, 1)
    }

    # 4 -- GE Prices
    t0 = time.time()
    prices = scrape_ge_prices()
    size = save_json("ge_prices.json", prices)
    manifest["files"]["ge_prices.json"] = {
        "count": len(prices), "bytes": size, "seconds": round(time.time() - t0, 1)
    }

    # -- Manifest
    total_bytes = sum(f["bytes"] for f in manifest["files"].values())
    manifest["total_bytes"] = total_bytes
    save_json("manifest.json", manifest)

    print("\n" + "=" * 60)
    print(f"  Done -- {total_bytes / 1024:.1f} KB across {len(manifest['files'])} files")
    print(f"  Output: {OUT_DIR}")
    print("=" * 60)


if __name__ == "__main__":
    main()
