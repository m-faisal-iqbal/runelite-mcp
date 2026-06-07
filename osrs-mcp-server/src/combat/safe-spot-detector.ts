// ─── Safe Spot Detector ───────────────────────────────────────────────────────

export type Tile = { x: number; y: number; plane?: number };

export type SafeSpotResult = {
  isSafe: boolean;
  reason: string;
  safeTile?: Tile;
  distanceToNpc: number;
};

/** Chebyshev distance (tile distance in OSRS) */
export function chebyshevDist(a: Tile, b: Tile): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Check if the player's current tile is a safe spot against an NPC.
 * An NPC with size N occupies a NxN tile block. It can melee attack from
 * any tile adjacent to its occupied square. We're safe if the NPC cannot
 * reach us in melee range (distance > npcSize).
 * For rangers/mages, distance check is based on attack range.
 */
export function isSafeSpot(
  playerTile: Tile,
  npcTile: Tile,   // top-left corner of NPC's tile block
  npcSize: number,
  npcAttackRange = 1,  // 1 = melee, >1 = ranged
  collisionData?: number[][]
): SafeSpotResult {
  const dist = chebyshevDist(playerTile, npcTile);
  // Effective melee reach: npcSize tiles (NPC occupies npcSize x npcSize square)
  const meleeReach = npcSize;
  const isSafe = dist > meleeReach;

  if (isSafe) {
    return { isSafe: true, reason: `Distance ${dist} > NPC melee reach ${meleeReach}`, distanceToNpc: dist };
  }

  // Check if there is a collision wall between player and NPC
  // (simplified: if collisionData provided, check the tile the NPC would path through)
  if (collisionData && dist === meleeReach + 1) {
    const blocked = isTileBlocked(collisionData, playerTile);
    if (blocked) {
      return { isSafe: true, reason: "Collision wall blocks NPC pathing", distanceToNpc: dist };
    }
  }

  return { isSafe: false, reason: `Distance ${dist} within NPC melee reach ${meleeReach}`, distanceToNpc: dist };
}

function isTileBlocked(collisionData: number[][], tile: Tile): boolean {
  // Collision value 0 = walkable, non-zero = blocked
  return (collisionData[tile.y]?.[tile.x] ?? 0) !== 0;
}

/**
 * Find a safe spot tile near the player that is out of the NPC's melee range.
 * Searches in a spiral pattern outward from the current tile.
 * Returns the first tile found that is:
 *  - Out of NPC melee range
 *  - Not blocked by collision (if data provided)
 *  - Still close enough to aggro the NPC (within aggro range, default 10 tiles)
 */
export function findSafeSpot(
  playerTile: Tile,
  npcTile: Tile,
  npcSize: number,
  searchRadius = 8,
  aggroRange = 10,
  collisionData?: number[][]
): Tile | undefined {
  const meleeReach = npcSize;

  // Spiral search: offsets in order of increasing distance
  for (let r = 1; r <= searchRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // only perimeter
        const candidate: Tile = {
          x: playerTile.x + dx,
          y: playerTile.y + dy,
          plane: playerTile.plane,
        };
        const distToNpc = chebyshevDist(candidate, npcTile);
        // Must be just outside melee reach but within aggro range
        if (distToNpc <= meleeReach) continue;
        if (distToNpc > aggroRange)  continue;
        if (collisionData && isTileBlocked(collisionData, candidate)) continue;
        return candidate;
      }
    }
  }
  return undefined;
}

/** Check multiple potential safe spots and return all valid ones, sorted by distance to NPC */
export function rankSafeSpots(
  candidates: Tile[],
  npcTile: Tile,
  npcSize: number,
  collisionData?: number[][]
): Tile[] {
  return candidates
    .filter(t => {
      const r = isSafeSpot(t, npcTile, npcSize, 1, collisionData);
      return r.isSafe;
    })
    .sort((a, b) => chebyshevDist(a, npcTile) - chebyshevDist(b, npcTile));
}
