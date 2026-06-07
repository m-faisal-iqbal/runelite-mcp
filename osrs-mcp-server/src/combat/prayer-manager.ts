// ─── Prayer Manager ───────────────────────────────────────────────────────────

export const PRAYERS = {
  THICK_SKIN:              { id: 0,  drainPerMin: 0.17*60, levelReq: 1,  overhead: false, style: "defence"  },
  BURST_OF_STRENGTH:       { id: 1,  drainPerMin: 0.17*60, levelReq: 4,  overhead: false, style: "melee"    },
  CLARITY_OF_THOUGHT:      { id: 2,  drainPerMin: 0.17*60, levelReq: 7,  overhead: false, style: "melee"    },
  SHARP_EYE:               { id: 3,  drainPerMin: 0.17*60, levelReq: 8,  overhead: false, style: "ranged"   },
  MYSTIC_WILL:             { id: 4,  drainPerMin: 0.17*60, levelReq: 9,  overhead: false, style: "magic"    },
  ROCK_SKIN:               { id: 5,  drainPerMin: 0.33*60, levelReq: 10, overhead: false, style: "defence"  },
  SUPERHUMAN_STRENGTH:     { id: 6,  drainPerMin: 0.33*60, levelReq: 13, overhead: false, style: "melee"    },
  IMPROVED_REFLEXES:       { id: 7,  drainPerMin: 0.33*60, levelReq: 16, overhead: false, style: "melee"    },
  HAWK_EYE:                { id: 11, drainPerMin: 0.33*60, levelReq: 26, overhead: false, style: "ranged"   },
  MYSTIC_LORE:             { id: 12, drainPerMin: 0.33*60, levelReq: 27, overhead: false, style: "magic"    },
  STEEL_SKIN:              { id: 8,  drainPerMin: 0.67*60, levelReq: 28, overhead: false, style: "defence"  },
  ULTIMATE_STRENGTH:       { id: 9,  drainPerMin: 0.67*60, levelReq: 31, overhead: false, style: "melee"    },
  INCREDIBLE_REFLEXES:     { id: 10, drainPerMin: 0.67*60, levelReq: 34, overhead: false, style: "melee"    },
  EAGLE_EYE:               { id: 13, drainPerMin: 0.67*60, levelReq: 44, overhead: false, style: "ranged"   },
  MYSTIC_MIGHT:            { id: 14, drainPerMin: 0.67*60, levelReq: 45, overhead: false, style: "magic"    },
  PROTECT_FROM_MAGIC:      { id: 16, drainPerMin: 1.00*60, levelReq: 37, overhead: true,  style: "magic"    },
  PROTECT_FROM_MISSILES:   { id: 17, drainPerMin: 1.00*60, levelReq: 40, overhead: true,  style: "ranged"   },
  PROTECT_FROM_MELEE:      { id: 18, drainPerMin: 1.00*60, levelReq: 43, overhead: true,  style: "melee"    },
  RETRIBUTION:             { id: 19, drainPerMin: 0.33*60, levelReq: 46, overhead: true,  style: "utility"  },
  REDEMPTION:              { id: 20, drainPerMin: 0.67*60, levelReq: 49, overhead: true,  style: "utility"  },
  SMITE:                   { id: 21, drainPerMin: 1.33*60, levelReq: 52, overhead: true,  style: "utility"  },
  CHIVALRY:                { id: 25, drainPerMin: 2.50*60, levelReq: 60, overhead: false, style: "melee"    },
  PIETY:                   { id: 26, drainPerMin: 3.33*60, levelReq: 70, overhead: false, style: "melee"    },
  RIGOUR:                  { id: 28, drainPerMin: 3.33*60, levelReq: 74, overhead: false, style: "ranged"   },
  AUGURY:                  { id: 29, drainPerMin: 3.33*60, levelReq: 77, overhead: false, style: "magic"    },
} as const;

export type PrayerName = keyof typeof PRAYERS;

/** Best offensive prayer the player can use for their style and prayer level */
export function selectOffensivePrayer(
  style: "melee" | "ranged" | "magic",
  prayerLevel: number
): PrayerName | null {
  const candidates: PrayerName[] = (Object.keys(PRAYERS) as PrayerName[]).filter((k) => {
    const p = PRAYERS[k];
    return p.style === style && !p.overhead && p.levelReq <= prayerLevel;
  });
  if (candidates.length === 0) return null;
  // Highest levelReq = best
  return candidates.sort((a, b) => PRAYERS[b].levelReq - PRAYERS[a].levelReq)[0];
}

/** Returns the correct protection prayer for a monster's attack style */
export function selectProtectionPrayer(
  monsterAttackStyle: "melee" | "ranged" | "magic"
): PrayerName {
  const map: Record<string, PrayerName> = {
    melee:  "PROTECT_FROM_MELEE",
    ranged: "PROTECT_FROM_MISSILES",
    magic:  "PROTECT_FROM_MAGIC",
  };
  return map[monsterAttackStyle] ?? "PROTECT_FROM_MELEE";
}

/**
 * Prayer drain rate in points per second.
 * Formula: each prayer drains at its own rate; total = sum of all active rates.
 * prayerBonus reduces drain: effective_drain = base_drain / (1 + prayerBonus/30)
 */
export function prayerDrainRate(activePrayers: PrayerName[], prayerBonus: number): number {
  const baseDrainPerSec = activePrayers.reduce((sum, name) => {
    return sum + (PRAYERS[name]?.drainPerMin ?? 0) / 60;
  }, 0);
  return baseDrainPerSec / (1 + prayerBonus / 30);
}

/** How many ticks before prayer runs out at current drain rate (1 tick = 0.6s) */
export function ticksUntilPrayerDepleted(
  currentPoints: number,
  activePrayers: PrayerName[],
  prayerBonus: number
): number {
  const drainPerSec = prayerDrainRate(activePrayers, prayerBonus);
  if (drainPerSec <= 0) return Infinity;
  const seconds = currentPoints / drainPerSec;
  return Math.floor(seconds / 0.6);
}

/** Prayer multipliers for DPS calculations */
export function getPrayerMultipliers(activePrayers: PrayerName[]): {
  attackMultiplier: number;
  strengthMultiplier: number;
  defenceMultiplier: number;
  rangedAttackMultiplier: number;
  rangedStrengthMultiplier: number;
  magicMultiplier: number;
} {
  let atk = 1, str = 1, def = 1, rAtk = 1, rStr = 1, mag = 1;
  for (const name of activePrayers) {
    switch (name) {
      case "BURST_OF_STRENGTH":    str = Math.max(str, 1.05); break;
      case "SUPERHUMAN_STRENGTH":  str = Math.max(str, 1.10); break;
      case "ULTIMATE_STRENGTH":    str = Math.max(str, 1.15); break;
      case "CLARITY_OF_THOUGHT":   atk = Math.max(atk, 1.05); break;
      case "IMPROVED_REFLEXES":    atk = Math.max(atk, 1.10); break;
      case "INCREDIBLE_REFLEXES":  atk = Math.max(atk, 1.15); break;
      case "THICK_SKIN":           def = Math.max(def, 1.05); break;
      case "ROCK_SKIN":            def = Math.max(def, 1.10); break;
      case "STEEL_SKIN":           def = Math.max(def, 1.15); break;
      case "CHIVALRY":  atk = Math.max(atk, 1.15); str = Math.max(str, 1.18); def = Math.max(def, 1.20); break;
      case "PIETY":     atk = Math.max(atk, 1.20); str = Math.max(str, 1.23); def = Math.max(def, 1.25); break;
      case "SHARP_EYE":   rAtk = Math.max(rAtk, 1.05); rStr = Math.max(rStr, 1.05); break;
      case "HAWK_EYE":    rAtk = Math.max(rAtk, 1.10); rStr = Math.max(rStr, 1.10); break;
      case "EAGLE_EYE":   rAtk = Math.max(rAtk, 1.15); rStr = Math.max(rStr, 1.15); break;
      case "RIGOUR":      rAtk = Math.max(rAtk, 1.20); rStr = Math.max(rStr, 1.23); def = Math.max(def, 1.25); break;
      case "MYSTIC_WILL":  mag = Math.max(mag, 1.05); break;
      case "MYSTIC_LORE":  mag = Math.max(mag, 1.10); break;
      case "MYSTIC_MIGHT": mag = Math.max(mag, 1.15); break;
      case "AUGURY":       mag = Math.max(mag, 1.25); def = Math.max(def, 1.25); break;
    }
  }
  return {
    attackMultiplier: atk, strengthMultiplier: str, defenceMultiplier: def,
    rangedAttackMultiplier: rAtk, rangedStrengthMultiplier: rStr, magicMultiplier: mag,
  };
}
