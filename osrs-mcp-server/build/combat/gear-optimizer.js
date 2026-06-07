// ─── Gear Optimizer ───────────────────────────────────────────────────────────
// Tier lists: index 0 = worst, last = best (for given style)
const MELEE_WEAPONS = [
    { name: "bronze sword", tier: 1, req: 1 }, { name: "iron sword", tier: 2, req: 1 },
    { name: "steel sword", tier: 3, req: 5 }, { name: "black sword", tier: 4, req: 10 },
    { name: "mithril sword", tier: 5, req: 20 }, { name: "adamant sword", tier: 6, req: 30 },
    { name: "rune sword", tier: 7, req: 40 }, { name: "dragon sword", tier: 8, req: 60 },
    { name: "bronze scimitar", tier: 10, req: 1 }, { name: "iron scimitar", tier: 11, req: 5 },
    { name: "steel scimitar", tier: 12, req: 5 }, { name: "black scimitar", tier: 13, req: 10 },
    { name: "mithril scimitar", tier: 14, req: 20 }, { name: "adamant scimitar", tier: 15, req: 30 },
    { name: "rune scimitar", tier: 16, req: 40 }, { name: "dragon scimitar", tier: 20, req: 60 },
    { name: "abyssal whip", tier: 25, req: 70 }, { name: "tentacle of the whip", tier: 27, req: 70 },
    { name: "dragon longsword", tier: 18, req: 60 }, { name: "rune longsword", tier: 7, req: 40 },
    { name: "rune 2h sword", tier: 9, req: 40 }, { name: "dragon 2h sword", tier: 19, req: 60 },
    { name: "granite maul", tier: 17, req: 50 }, { name: "bludgeon", tier: 23, req: 70 },
];
const MELEE_HELMS = [
    { name: "bronze full helm", tier: 1, req: 1 }, { name: "iron full helm", tier: 2, req: 1 },
    { name: "steel full helm", tier: 3, req: 5 }, { name: "black full helm", tier: 4, req: 10 },
    { name: "mithril full helm", tier: 5, req: 20 }, { name: "adamant full helm", tier: 6, req: 30 },
    { name: "rune full helm", tier: 7, req: 40 }, { name: "dragon med helm", tier: 8, req: 60 },
    { name: "berserker helm", tier: 9, req: 45 }, { name: "neitiznot helm", tier: 10, req: 55 },
    { name: "helm of neitiznot", tier: 10, req: 55 },
];
const MELEE_BODY = [
    { name: "bronze chainbody", tier: 1, req: 1 }, { name: "iron chainbody", tier: 2, req: 1 },
    { name: "steel chainbody", tier: 3, req: 5 }, { name: "black chainbody", tier: 4, req: 10 },
    { name: "mithril chainbody", tier: 5, req: 20 }, { name: "adamant chainbody", tier: 6, req: 30 },
    { name: "rune chainbody", tier: 7, req: 40 },
    { name: "bronze platebody", tier: 2, req: 1 }, { name: "iron platebody", tier: 3, req: 1 },
    { name: "steel platebody", tier: 4, req: 5 }, { name: "black platebody", tier: 5, req: 10 },
    { name: "mithril platebody", tier: 6, req: 20 }, { name: "adamant platebody", tier: 7, req: 30 },
    { name: "rune platebody", tier: 8, req: 40 }, { name: "dragon platebody", tier: 12, req: 60 },
    { name: "fighter torso", tier: 10, req: 40 }, { name: "bandos chestplate", tier: 15, req: 65 },
];
const MAGIC_WEAPONS = [
    { name: "staff of air", tier: 1, req: 1 }, { name: "staff of fire", tier: 2, req: 1 },
    { name: "staff of water", tier: 2, req: 1 }, { name: "staff of earth", tier: 2, req: 1 },
    { name: "battlestaff", tier: 3, req: 30 }, { name: "mystic staff", tier: 4, req: 40 },
    { name: "trident of the seas", tier: 10, req: 75 },
    { name: "trident of the swamp", tier: 12, req: 75 },
    { name: "sanguinesti staff", tier: 14, req: 82 },
];
const RANGED_WEAPONS = [
    { name: "shortbow", tier: 1, req: 1 }, { name: "longbow", tier: 2, req: 1 },
    { name: "oak shortbow", tier: 3, req: 5 }, { name: "oak longbow", tier: 4, req: 5 },
    { name: "willow shortbow", tier: 5, req: 20 }, { name: "maple shortbow", tier: 7, req: 30 },
    { name: "yew shortbow", tier: 9, req: 40 }, { name: "magic shortbow", tier: 11, req: 50 },
    { name: "magic longbow", tier: 10, req: 50 }, { name: "rune crossbow", tier: 12, req: 61 },
    { name: "dragon hunter crossbow", tier: 16, req: 65 },
    { name: "twisted bow", tier: 20, req: 75 },
];
function bestOwned(ownedNames, tierList, levelReq) {
    return tierList
        .filter(i => ownedNames.has(i.name.toLowerCase()) && i.req <= levelReq)
        .sort((a, b) => b.tier - a.tier)[0];
}
export function recommendGear(style, ownedItems, attackLevel, strengthLevel, defenceLevel, magicLevel = 1, rangedLevel = 1) {
    const owned = new Set(ownedItems.map(i => i.name.toLowerCase()));
    const recs = [];
    const add = (slot, item, reason) => {
        if (item)
            recs.push({ slot, item: item.name, reason, tier: item.tier });
    };
    if (style === "melee") {
        add("weapon", bestOwned(owned, MELEE_WEAPONS, Math.max(attackLevel, strengthLevel)), "Best melee weapon owned");
        add("head", bestOwned(owned, MELEE_HELMS, defenceLevel), "Best melee helm owned");
        add("body", bestOwned(owned, MELEE_BODY, defenceLevel), "Best melee body owned");
    }
    else if (style === "magic") {
        add("weapon", bestOwned(owned, MAGIC_WEAPONS, magicLevel), "Best magic weapon owned");
    }
    else if (style === "ranged") {
        add("weapon", bestOwned(owned, RANGED_WEAPONS, rangedLevel), "Best ranged weapon owned");
    }
    return recs;
}
