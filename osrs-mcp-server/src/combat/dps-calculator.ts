// ─── DPS Calculator ──────────────────────────────────────────────────────────
// Implements OSRS combat formulas exactly as the wiki specifies them.

export type GearStats = {
  attackBonus: number;
  strengthBonus: number;
  attackSpeed: number; // ticks (1 tick = 0.6s)
};

export type MonsterStats = {
  defenceLevel: number;
  defenceBonus: number;
  combatLevel: number;
};

/** OSRS melee max hit formula */
export function maxHitMelee(
  strengthLevel: number,
  strengthBonus: number,
  prayerMultiplier = 1.0,
  styleBonus = 0  // 0=no style, 1=aggressive, 3=controlled
): number {
  // OSRS wiki formula (exactly):
  // effective_strength = floor(strength_level * prayer_multiplier) + style_bonus + 8
  // max_hit = floor(0.5 + effective_strength * (equipment_strength_bonus + 64) / 640)
  const effectiveStr = Math.floor(strengthLevel * prayerMultiplier) + styleBonus + 8;
  return Math.floor(0.5 + (effectiveStr * (strengthBonus + 64)) / 640);
}

/** OSRS melee attack roll */
export function attackRoll(
  attackLevel: number,
  attackBonus: number,
  prayerMultiplier = 1.0,
  styleBonus = 0
): number {
  // effective_attack = floor(attack_level * prayer_multiplier) + style_bonus + 8
  const effectiveAtk = Math.floor(attackLevel * prayerMultiplier) + styleBonus + 8;
  return effectiveAtk * (attackBonus + 64);
}

/** Monster defence roll */
export function defenceRoll(defenceLevel: number, defenceBonus: number): number {
  return (defenceLevel + 9) * (defenceBonus + 64);
}

/** OSRS hit chance formula */
export function hitChance(atkRoll: number, defRoll: number): number {
  if (atkRoll > defRoll) {
    return 1 - (defRoll + 2) / (2 * (atkRoll + 1));
  }
  return atkRoll / (2 * (defRoll + 1));
}

/** DPS = average damage per tick / tick duration */
export function dps(maxHit: number, chance: number, attackSpeedTicks: number): number {
  const avgDmg = (chance * maxHit) / 2;
  return avgDmg / (attackSpeedTicks * 0.6);
}

/** Full DPS given player stats, gear, and monster */
export function calculateDps(
  attackLevel: number,
  strengthLevel: number,
  gear: GearStats,
  monster: MonsterStats,
  prayerAtkMultiplier = 1.0,
  prayerStrMultiplier = 1.0
): { maxHit: number; hitChance: number; dps: number; atkRoll: number; defRoll: number } {
  const mh   = maxHitMelee(strengthLevel, gear.strengthBonus, prayerStrMultiplier);
  const atk  = attackRoll(attackLevel, gear.attackBonus, prayerAtkMultiplier);
  const def  = defenceRoll(monster.defenceLevel, monster.defenceBonus);
  const hc   = hitChance(atk, def);
  return { maxHit: mh, hitChance: hc, dps: dps(mh, hc, gear.attackSpeed), atkRoll: atk, defRoll: def };
}


