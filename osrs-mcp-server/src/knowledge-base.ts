import {
  loadMonsters,
  loadQuests,
  findItemByName,
  getCachedPrice,
  findMonsterByName,
  findQuestByName,
  loadSkillIndex,
  type WikiItem,
} from "./knowledge-loader.js";

export type KnowledgeMethod = {
  id: string;
  domain: "skill" | "combat" | "economy" | "quest" | "travel";
  skill?: string;
  activity: string;
  name: string;
  levelMin?: number;
  levelMax?: number;
  members: boolean;
  preference: Array<"fastest" | "cheap" | "profit" | "safe" | "afk" | "starter">;
  requirements: string[];
  items: string[];
  locations: string[];
  actions: string[];
  expectedRates?: Partial<Record<string, string>>;
  risks: string[];
  nextUnlocks?: string[];
  notes: string[];
};

export type KnowledgeLocation = {
  id: string;
  name: string;
  region: string;
  members: boolean;
  worldX?: number;
  worldY?: number;
  plane?: number;
  tags: string[];
  contains: string[];
  banks?: string[];
  transport: string[];
  risks: string[];
  notes: string[];
};

export type KnowledgeQuest = {
  id: string;
  name: string;
  members: boolean;
  difficulty: "tutorial" | "novice" | "intermediate" | "experienced" | "master" | "grandmaster";
  requirements: string[];
  recommended: string[];
  rewards: string[];
  start: string;
  steps: string[];
  risks: string[];
  notes: string[];
};

export type KnowledgeMonster = {
  id: string;
  name: string;
  members: boolean;
  combatLevel?: number;
  locations: string[];
  attackStyle?: string;
  weaknesses: string[];
  usefulDrops: string[];
  requirements: string[];
  tactics: string[];
  risks: string[];
};

export type KnowledgeGear = {
  id: string;
  name: string;
  members: boolean;
  style: "melee" | "ranged" | "magic" | "skilling" | "hybrid";
  levelMin?: number;
  requirements: string[];
  items: string[];
  useCases: string[];
  upgradePath: string[];
  notes: string[];
};

export type KnowledgeRecord =
  | (KnowledgeMethod & { kind: "method" })
  | (KnowledgeLocation & { kind: "location" })
  | (KnowledgeQuest & { kind: "quest" })
  | (KnowledgeMonster & { kind: "monster" })
  | (KnowledgeGear & { kind: "gear" });

export const knowledgeBase = {
  version: 1,
  scope: "curated_local_f2p_foundation",
  updatedAt: "2026-06-02",
  warning: "Curated local seed knowledge. Verify against live game/wiki before high-value or risky execution.",
  methods: [
    {
      id: "woodcutting.normal_tree_logs",
      domain: "skill",
      skill: "woodcutting",
      activity: "logs",
      name: "Chop normal trees for Logs",
      levelMin: 1,
      levelMax: 15,
      members: false,
      preference: ["starter", "safe", "cheap"],
      requirements: ["Any axe usable by current Woodcutting level"],
      items: ["Bronze axe", "Iron axe", "Steel axe", "Mithril axe", "Logs"],
      locations: ["lumbridge_trees", "varrock_west_trees", "draynor_trees"],
      actions: ["Use skill_acquire Logs by woodcutting", "Bank or drop logs when inventory is full"],
      expectedRates: { xp: "Low starter XP; use until Oak trees at level 15" },
      risks: ["Tree despawns temporarily after chopping"],
      nextUnlocks: ["Oak trees at Woodcutting level 15"],
      notes: ["Best as a safe starter routine and bridge into oak/willow training."],
    },
    {
      id: "woodcutting.oak_logs",
      domain: "skill",
      skill: "woodcutting",
      activity: "oak logs",
      name: "Chop oak trees",
      levelMin: 15,
      levelMax: 30,
      members: false,
      preference: ["starter", "safe", "cheap"],
      requirements: ["Woodcutting level 15", "Axe"],
      items: ["Oak logs", "Axe"],
      locations: ["varrock_west_trees", "draynor_trees"],
      actions: ["Use skill_acquire Oak logs by woodcutting", "Bank at nearby Varrock or Draynor bank"],
      expectedRates: { xp: "Better than normal trees at low levels" },
      risks: ["Competition at popular trees"],
      nextUnlocks: ["Willow trees at Woodcutting level 30"],
      notes: ["Good F2P bridge to willows."],
    },
    {
      id: "woodcutting.willow_logs",
      domain: "skill",
      skill: "woodcutting",
      activity: "willow logs",
      name: "Chop willow trees",
      levelMin: 30,
      members: false,
      preference: ["fastest", "cheap", "safe"],
      requirements: ["Woodcutting level 30", "Axe"],
      items: ["Willow logs", "Axe"],
      locations: ["draynor_willows"],
      actions: ["Use skill_acquire Willow logs by woodcutting", "Bank at Draynor or drop for speed"],
      expectedRates: { xp: "Strong early F2P Woodcutting XP" },
      risks: ["Crowded in F2P worlds"],
      nextUnlocks: ["Maple trees at level 45 are members-focused; continue willows in F2P"],
      notes: ["Reliable default F2P Woodcutting method after level 30."],
    },
    {
      id: "magic.strike_spells_low_level",
      domain: "skill",
      skill: "magic",
      activity: "combat casting",
      name: "Train Magic with strike spells",
      levelMin: 1,
      levelMax: 25,
      members: false,
      preference: ["starter", "safe"],
      requirements: ["Mind runes", "Elemental runes or matching elemental staff", "Safe low-level target"],
      items: ["Mind rune", "Air rune", "Water rune", "Earth rune", "Fire rune", "Staff of air", "Staff of fire"],
      locations: ["lumbridge_chickens", "lumbridge_cows", "varrock_sewers"],
      actions: ["Equip elemental staff when available", "Cast best unlocked strike spell on safe low-level NPCs", "Restock runes before continuing"],
      expectedRates: { xp: "Low but reliable starter Magic XP", gp: "Costs runes unless supplied by drops/rewards" },
      risks: ["Rune cost", "Autocast setup may require widget handling"],
      nextUnlocks: ["Water Strike at 5 Magic", "Earth Strike at 9 Magic", "Fire Strike at 13 Magic"],
      notes: ["For a request like 'get 50 Magic', this is the dependency-root method until better spells and GP are available."],
    },
    {
      id: "magic.fire_strike_f2p",
      domain: "skill",
      skill: "magic",
      activity: "combat casting",
      name: "Train Magic with Fire Strike",
      levelMin: 13,
      levelMax: 55,
      members: false,
      preference: ["safe", "starter"],
      requirements: ["Magic level 13", "Mind runes", "Air runes", "Fire runes or staff of fire"],
      items: ["Mind rune", "Air rune", "Staff of fire"],
      locations: ["varrock_sewers", "lumbridge_cows", "edgeville_monastery_area"],
      actions: ["Equip staff of fire to reduce rune cost", "Cast Fire Strike on safe or low-risk targets", "Bank/restock when runes run low"],
      expectedRates: { xp: "Decent low-cost F2P combat Magic XP", gp: "Requires rune budget" },
      risks: ["Can lose efficiency if target dies slowly or pathing is poor"],
      nextUnlocks: ["High Level Alchemy at 55 Magic"],
      notes: ["Curated safe default for early-to-mid F2P Magic training."],
    },
    {
      id: "mining.copper_tin",
      domain: "skill",
      skill: "mining",
      activity: "copper/tin ore",
      name: "Mine copper and tin rocks",
      levelMin: 1,
      levelMax: 15,
      members: false,
      preference: ["starter", "cheap"],
      requirements: ["Pickaxe"],
      items: ["Copper ore", "Tin ore", "Pickaxe"],
      locations: ["lumbridge_swamp_mine", "varrock_south_east_mine"],
      actions: ["Mine nearest copper/tin rocks", "Bank ores or drop for XP"],
      expectedRates: { xp: "Starter Mining XP" },
      risks: ["Rocks deplete and respawn"],
      nextUnlocks: ["Iron ore at Mining level 15"],
      notes: ["Use until iron mining unlocks."],
    },
    {
      id: "mining.iron_ore",
      domain: "skill",
      skill: "mining",
      activity: "iron ore",
      name: "Mine iron ore",
      levelMin: 15,
      members: false,
      preference: ["fastest", "profit"],
      requirements: ["Mining level 15", "Pickaxe"],
      items: ["Iron ore", "Pickaxe"],
      locations: ["varrock_south_east_mine", "al_kharid_mine"],
      actions: ["Mine iron rocks", "Drop for XP or bank for GP"],
      expectedRates: { xp: "Strong F2P Mining XP when dropping", gp: "Banking iron gives starter GP" },
      risks: ["Aggressive scorpions at Al Kharid for low levels"],
      nextUnlocks: ["Coal at Mining level 30"],
      notes: ["Prefer Varrock south-east mine for safer early routing."],
    },
    {
      id: "fishing.shrimp_anchovies",
      domain: "skill",
      skill: "fishing",
      activity: "shrimp/anchovies",
      name: "Net shrimps and anchovies",
      levelMin: 1,
      levelMax: 20,
      members: false,
      preference: ["starter", "cheap", "safe"],
      requirements: ["Small fishing net"],
      items: ["Small fishing net", "Raw shrimps", "Raw anchovies"],
      locations: ["lumbridge_swamp_fishing", "draynor_fishing_spots"],
      actions: ["Use Net on fishing spot", "Bank or cook/drop fish"],
      expectedRates: { xp: "Starter Fishing XP" },
      risks: ["Fishing spots move"],
      nextUnlocks: ["Fly fishing trout at level 20"],
      notes: ["Safe first Fishing method."],
    },
    {
      id: "combat.chickens",
      domain: "combat",
      activity: "chickens",
      name: "Kill chickens for starter combat and feathers",
      levelMin: 1,
      members: false,
      preference: ["starter", "safe"],
      requirements: ["Basic weapon"],
      items: ["Bones", "Feather", "Raw chicken"],
      locations: ["lumbridge_chickens"],
      actions: ["Use skill_combat target Chicken", "Loot feathers/bones when safe"],
      expectedRates: { xp: "Starter combat XP", gp: "Feathers have starter value" },
      risks: ["Low combat risk"],
      nextUnlocks: ["Cows for hides and better combat XP"],
      notes: ["Good first combat routine."],
    },
    {
      id: "combat.cows",
      domain: "combat",
      activity: "cows",
      name: "Kill cows for hides and combat XP",
      levelMin: 3,
      members: false,
      preference: ["starter", "profit"],
      requirements: ["Basic weapon", "Food if very low combat"],
      items: ["Cowhide", "Bones", "Raw beef"],
      locations: ["lumbridge_cows"],
      actions: ["Use skill_combat target Cow", "Loot cowhides/bones", "Bank at Lumbridge or Al Kharid"],
      expectedRates: { gp: "Cowhides are a classic starter money item" },
      risks: ["Low combat risk, but monitor HP"],
      nextUnlocks: ["Hill giants when combat and gear improve"],
      notes: ["Useful GP bridge for buying runes."],
    },
    {
      id: "economy.cowhides_starter_gp",
      domain: "economy",
      activity: "starter gp",
      name: "Earn starter GP by collecting cowhides",
      members: false,
      preference: ["profit", "starter"],
      requirements: ["Access to cows", "Bank route"],
      items: ["Cowhide"],
      locations: ["lumbridge_cows", "al_kharid_bank"],
      actions: ["Kill or collect cowhides", "Bank full inventories", "Sell later through GE when available"],
      expectedRates: { gp: "Market-dependent; use GE sync later for exact rate" },
      risks: ["GE prices change", "Long walking route without global navigation"],
      notes: ["Good dependency for rune-buying goals."],
    },
  ] satisfies KnowledgeMethod[],
  locations: [
    {
      id: "lumbridge_chickens",
      name: "Lumbridge chicken pen",
      region: "Lumbridge",
      members: false,
      tags: ["combat", "starter", "safe", "f2p"],
      contains: ["Chicken", "Bones", "Feather", "Raw chicken"],
      banks: ["lumbridge_bank"],
      transport: ["Home teleport to Lumbridge"],
      risks: ["Very low combat risk"],
      notes: ["Starter combat and loot practice area."],
    },
    {
      id: "lumbridge_cows",
      name: "Lumbridge cow field",
      region: "Lumbridge",
      members: false,
      tags: ["combat", "starter", "gp", "f2p"],
      contains: ["Cow", "Cowhide", "Bones", "Raw beef"],
      banks: ["lumbridge_bank", "al_kharid_bank"],
      transport: ["Walk from Lumbridge", "Home teleport to Lumbridge"],
      risks: ["Low combat risk"],
      notes: ["Starter combat and GP source."],
    },
    {
      id: "varrock_west_trees",
      name: "Varrock west trees",
      region: "Varrock",
      members: false,
      tags: ["woodcutting", "bank", "f2p"],
      contains: ["Tree", "Oak tree", "Varrock west bank"],
      banks: ["varrock_west_bank"],
      transport: ["Walk from Varrock square", "Varrock teleport when unlocked"],
      risks: ["Crowded trees"],
      notes: ["Convenient early Woodcutting with nearby bank."],
    },
    {
      id: "draynor_willows",
      name: "Draynor Village willow trees",
      region: "Draynor Village",
      members: false,
      tags: ["woodcutting", "willow", "bank", "f2p"],
      contains: ["Willow tree", "Draynor bank"],
      banks: ["draynor_bank"],
      transport: ["Walk from Lumbridge/Draynor", "Explorer's ring teleports if unlocked"],
      risks: ["Can be crowded"],
      notes: ["Default F2P willow training spot."],
    },
    {
      id: "varrock_south_east_mine",
      name: "Varrock south-east mine",
      region: "Varrock",
      members: false,
      tags: ["mining", "iron", "f2p"],
      contains: ["Copper rocks", "Tin rocks", "Iron rocks"],
      banks: ["varrock_east_bank"],
      transport: ["Walk from Varrock east bank"],
      risks: ["Competition for iron rocks"],
      notes: ["Good early F2P mine with nearby bank."],
    },
    {
      id: "varrock_sewers",
      name: "Varrock Sewers",
      region: "Varrock",
      members: false,
      tags: ["combat", "magic", "f2p"],
      contains: ["Rats", "Zombies", "Moss giants deeper in"],
      banks: ["varrock_east_bank", "varrock_west_bank"],
      transport: ["Walk from Varrock"],
      risks: ["Deeper monsters can be dangerous for low levels"],
      notes: ["Useful combat Magic targets once the account can survive."],
    },
  ] satisfies KnowledgeLocation[],
  quests: [
    {
      id: "tutorial_island",
      name: "Tutorial Island",
      members: false,
      difficulty: "tutorial",
      requirements: ["New account on Tutorial Island"],
      recommended: ["No combat risk beyond tutorial instructions"],
      rewards: ["Access to mainland", "Starter items", "Basic game systems unlocked"],
      start: "Talk to the Gielinor Guide on Tutorial Island",
      steps: ["Follow guide NPCs", "Complete survival, cooking, mining, combat, banking, prayer, magic lessons", "Choose Ironman status only with explicit user direction"],
      risks: ["Branching interface choices", "Must not choose account restrictions accidentally"],
      notes: ["Quest engine should handle this first with semantic widgets and dialogue."],
    },
    {
      id: "cooks_assistant",
      name: "Cook's Assistant",
      members: false,
      difficulty: "novice",
      requirements: ["None"],
      recommended: ["Bucket or pot access", "Know item locations"],
      rewards: ["Cooking XP", "Access to Lumbridge Castle range"],
      start: "Talk to the Cook in Lumbridge Castle kitchen",
      steps: ["Talk to Cook", "Collect egg, bucket of milk, pot of flour", "Return items to Cook"],
      risks: ["Item collection route requires global/local navigation"],
      notes: ["Good first F2P quest after semantic widget/dialogue layer."],
    },
  ] satisfies KnowledgeQuest[],
  monsters: [
    {
      id: "chicken",
      name: "Chicken",
      members: false,
      combatLevel: 1,
      locations: ["lumbridge_chickens"],
      attackStyle: "melee",
      weaknesses: ["Any starter weapon", "Low-level spells"],
      usefulDrops: ["Bones", "Feather", "Raw chicken"],
      requirements: ["None"],
      tactics: ["Attack nearest chicken", "Loot feathers/bones if inventory space allows"],
      risks: ["Very low"],
    },
    {
      id: "cow",
      name: "Cow",
      members: false,
      combatLevel: 2,
      locations: ["lumbridge_cows"],
      attackStyle: "melee",
      weaknesses: ["Melee", "Low-level spells"],
      usefulDrops: ["Cowhide", "Bones", "Raw beef"],
      requirements: ["None"],
      tactics: ["Monitor HP on very fresh accounts", "Loot cowhides for GP"],
      risks: ["Low"],
    },
    {
      id: "grizzly_bear",
      name: "Grizzly bear",
      members: false,
      combatLevel: 21,
      locations: ["varrock_west_trees"],
      attackStyle: "melee",
      weaknesses: ["Ranged or Magic from a safe distance when possible"],
      usefulDrops: ["Bones", "Bear fur", "Raw bear meat"],
      requirements: ["Food recommended for low-level accounts"],
      tactics: ["Avoid fighting on weak starter accounts unless goal requires it"],
      risks: ["Can be dangerous to low-level accounts"],
    },
    {
      id: "hill_giant",
      name: "Hill Giant",
      members: false,
      combatLevel: 28,
      locations: ["edgeville_dungeon", "varrock_sewers"],
      attackStyle: "melee",
      weaknesses: ["Magic/Ranged safespot where available"],
      usefulDrops: ["Big bones", "Limpwurt root"],
      requirements: ["Brass key or dungeon route for common spots", "Food and combat stats"],
      tactics: ["Use safespots when possible", "Loot big bones if banking route is viable"],
      risks: ["Multi-combat or crowding depending on location"],
    },
  ] satisfies KnowledgeMonster[],
  gear: [
    {
      id: "starter_melee_f2p",
      name: "Starter F2P melee gear",
      members: false,
      style: "melee",
      levelMin: 1,
      requirements: ["Attack/Defence levels matching metal tier"],
      items: ["Iron scimitar", "Iron full helm", "Iron platebody", "Iron platelegs", "Iron kiteshield"],
      useCases: ["Chickens", "Cows", "Low-level quest combat"],
      upgradePath: ["Steel scimitar", "Black scimitar", "Mithril scimitar", "Adamant scimitar", "Rune scimitar"],
      notes: ["Scimitars are a strong default melee weapon path for F2P."],
    },
    {
      id: "starter_magic_f2p",
      name: "Starter F2P Magic kit",
      members: false,
      style: "magic",
      levelMin: 1,
      requirements: ["Mind runes", "Elemental runes or staff"],
      items: ["Staff of air", "Staff of fire", "Mind rune", "Air rune"],
      useCases: ["Strike spell training", "Safe low-level combat"],
      upgradePath: ["Elemental staves", "Wizard robes", "Stronger strike spells", "High Level Alchemy at 55 Magic"],
      notes: ["Elemental staves reduce rune cost and simplify repeated casting."],
    },
    {
      id: "starter_woodcutting_tools",
      name: "Starter Woodcutting axe path",
      members: false,
      style: "skilling",
      levelMin: 1,
      requirements: ["Woodcutting level for each axe tier"],
      items: ["Bronze axe", "Iron axe", "Steel axe", "Black axe", "Mithril axe", "Adamant axe", "Rune axe"],
      useCases: ["Normal trees", "Oak trees", "Willow trees"],
      upgradePath: ["Use the best axe the account can equip/use"],
      notes: ["A better axe improves chopping reliability and XP/hour."],
    },
  ] satisfies KnowledgeGear[],
};

function normalize(text: unknown) {
  return String(text ?? "").toLowerCase();
}

function compactRecord(record: KnowledgeRecord) {
  return {
    kind: record.kind,
    id: record.id,
    name: record.name,
    members: record.members,
    tags: "tags" in record ? record.tags : undefined,
    skill: "skill" in record ? record.skill : undefined,
    domain: "domain" in record ? record.domain : undefined,
    activity: "activity" in record ? record.activity : undefined,
    levelMin: "levelMin" in record ? record.levelMin : undefined,
    levelMax: "levelMax" in record ? record.levelMax : undefined,
    locations: "locations" in record ? record.locations : undefined,
    risks: "risks" in record ? record.risks : undefined,
  };
}

export function allKnowledgeRecords(): KnowledgeRecord[] {
  const curated = [
    ...knowledgeBase.methods.map((record) => ({ ...record, kind: "method" as const })),
    ...knowledgeBase.locations.map((record) => ({ ...record, kind: "location" as const })),
    ...knowledgeBase.quests.map((record) => ({ ...record, kind: "quest" as const })),
    ...knowledgeBase.monsters.map((record) => ({ ...record, kind: "monster" as const })),
    ...knowledgeBase.gear.map((record) => ({ ...record, kind: "gear" as const })),
  ];

  // Merge wiki monsters/quests that aren't already in curated data
  const curatedIds = new Set(curated.map((r) => r.id));
  const wikiMonsters = loadMonsters()
    .filter((m) => !curatedIds.has(m.id))
    .map((record) => ({ ...record, kind: "monster" as const }));
  const wikiQuests = loadQuests()
    .filter((q) => !curatedIds.has(q.id))
    .map((record) => ({ ...record, kind: "quest" as const }));

  return [...curated, ...wikiMonsters, ...wikiQuests];
}

function searchableText(record: KnowledgeRecord) {
  return JSON.stringify(record).toLowerCase();
}

function recordScore(record: KnowledgeRecord, terms: string[]) {
  const haystack = searchableText(record);
  return terms.reduce((score, term) => {
    if (normalize(record.name).includes(term)) {
      return score + 5;
    }
    if (record.id.includes(term.replace(/\s+/g, "_"))) {
      return score + 4;
    }
    return score + (haystack.includes(term) ? 1 : 0);
  }, 0);
}

export function queryKnowledge(args: { query: string; kind?: string; limit?: number; members?: boolean }) {
  const terms = normalize(args.query).split(/[^a-z0-9]+/).filter((term) => term.length >= 2);
  const limit = Math.max(1, Math.min(50, args.limit ?? 10));
  const records = allKnowledgeRecords()
    .filter((record) => !args.kind || record.kind === args.kind)
    .filter((record) => args.members === undefined || record.members === args.members)
    .map((record) => ({ record, score: recordScore(record, terms) }))
    .filter((entry) => terms.length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name))
    .slice(0, limit);
  return records.map((entry) => ({ score: entry.score, ...compactRecord(entry.record), record: entry.record }));
}

export function getKnowledgeRecord(kind: KnowledgeRecord["kind"], idOrName: string) {
  const needle = normalize(idOrName).replace(/\s+/g, "_");
  return allKnowledgeRecords().find((record) =>
    record.kind === kind &&
    (record.id.toLowerCase() === needle || normalize(record.name) === normalize(idOrName))
  );
}

function parseTargetLevel(text?: string, explicit?: number) {
  if (explicit !== undefined && Number.isFinite(explicit)) {
    return Math.max(1, Math.min(126, Math.floor(explicit)));
  }
  const match = String(text ?? "").match(/\b(?:level\s*)?(\d{1,3})\b/);
  return match ? Math.max(1, Math.min(126, Number(match[1]))) : undefined;
}

export function getMethodKnowledge(args: {
  skill?: string;
  activity?: string;
  methodId?: string;
  currentLevel?: number;
  targetLevel?: number;
  preference?: string;
}) {
  if (args.methodId) {
    const record = getKnowledgeRecord("method", args.methodId);
    return record ? methodWithPlan(record as KnowledgeMethod, args) : undefined;
  }
  const skill = normalize(args.skill);
  const activity = normalize(args.activity);
  const currentLevel = Math.max(1, Math.floor(args.currentLevel ?? 1));
  const targetLevel = parseTargetLevel(args.activity, args.targetLevel);
  const preference = normalize(args.preference);
  const candidates = knowledgeBase.methods
    .filter((method) => !skill || normalize(method.skill).includes(skill) || normalize(method.domain).includes(skill))
    .filter((method) => !activity || searchableText({ ...method, kind: "method" }).includes(activity))
    .filter((method) => method.levelMin === undefined || method.levelMin <= Math.max(currentLevel, targetLevel ?? currentLevel))
    .sort((a, b) => {
      const aPref = preference && a.preference.some((pref) => normalize(pref).includes(preference)) ? 1 : 0;
      const bPref = preference && b.preference.some((pref) => normalize(pref).includes(preference)) ? 1 : 0;
      const aLevel = a.levelMin ?? 1;
      const bLevel = b.levelMin ?? 1;
      return bPref - aPref || bLevel - aLevel || a.name.localeCompare(b.name);
    });
  const chosen = candidates.find((method) => (method.levelMin ?? 1) <= currentLevel) ?? candidates[0];
  return chosen ? methodWithPlan(chosen, args) : undefined;
}

function methodWithPlan(method: KnowledgeMethod, args: { currentLevel?: number; targetLevel?: number; preference?: string }) {
  const currentLevel = Math.max(1, Math.floor(args.currentLevel ?? method.levelMin ?? 1));
  const targetLevel = parseTargetLevel(undefined, args.targetLevel);
  const dependencyTree = [
    {
      type: "requirements",
      items: method.requirements,
    },
    {
      type: "items",
      items: method.items,
    },
    {
      type: "locations",
      items: method.locations,
    },
    {
      type: "execution",
      items: method.actions,
    },
    method.nextUnlocks?.length
      ? {
        type: "nextUnlocks",
        items: method.nextUnlocks,
      }
      : undefined,
  ].filter(Boolean);
  const milestones = targetLevel
    ? knowledgeBase.methods
      .filter((candidate) => candidate.skill === method.skill && (candidate.levelMin ?? 1) <= targetLevel)
      .sort((a, b) => (a.levelMin ?? 1) - (b.levelMin ?? 1))
      .map((candidate) => ({
        level: candidate.levelMin ?? 1,
        methodId: candidate.id,
        method: candidate.name,
        locations: candidate.locations,
        requirements: candidate.requirements,
      }))
    : [];

  return {
    status: "METHOD_FOUND",
    method,
    currentLevel,
    targetLevel,
    preference: args.preference,
    dependencyTree,
    milestones,
    recommendedTools: toolsForMethod(method),
    verification: [
      "Check current skill level and inventory from memory_get_profile or get_skills.",
      "Verify required item/tool is available before execution.",
      "Use Universal Activity tools for execution; do not raw-click unless fallback is explicitly needed.",
    ],
  };
}

function toolsForMethod(method: KnowledgeMethod) {
  if (method.skill === "woodcutting") {
    return ["skill_acquire", "skill_train", "skill_manage_inventory", "load_policy"];
  }
  if (method.skill === "magic") {
    return ["memory_get_profile", "skill_gear_equip", "skill_cast_spell", "skill_combat"];
  }
  if (method.skill === "mining" || method.skill === "fishing") {
    return ["skill_train", "skill_acquire", "skill_manage_inventory"];
  }
  if (method.domain === "combat") {
    return ["skill_combat", "skill_manage_inventory", "memory_record_action"];
  }
  if (method.domain === "economy") {
    return ["skill_earn_gp", "skill_acquire", "skill_manage_inventory"];
  }
  return ["observe_game", "plan_next_action", "load_policy"];
}

export function knowledgeSummary() {
  return {
    version: knowledgeBase.version,
    scope: knowledgeBase.scope,
    updatedAt: knowledgeBase.updatedAt,
    warning: knowledgeBase.warning,
    counts: {
      methods: knowledgeBase.methods.length,
      locations: knowledgeBase.locations.length,
      quests: knowledgeBase.quests.length,
      monsters: knowledgeBase.monsters.length,
      gear: knowledgeBase.gear.length,
      total: allKnowledgeRecords().length,
    },
    starterQueries: [
      "50 Magic",
      "woodcutting level 30",
      "Lumbridge cows",
      "Cook's Assistant",
      "starter magic gear",
    ],
  };
}

// ---------------------------------------------------------------------------
// Live-data helpers – use wiki-scraped JSON alongside curated knowledge
// ---------------------------------------------------------------------------

export function getItemPrice(itemName: string) {
  const item = findItemByName(itemName);
  if (!item) return undefined;

  const price = getCachedPrice(item.id);
  if (!price) {
    return {
      name: item.name,
      id: item.id,
      high: undefined as number | undefined,
      low: undefined as number | undefined,
      margin: undefined as number | undefined,
      geLimit: item.geLimit,
    };
  }

  return {
    name: item.name,
    id: item.id,
    high: price.high,
    low: price.low,
    margin: price.high - price.low,
    geLimit: item.geLimit,
  };
}

export function getMonsterInfo(name: string): KnowledgeMonster | undefined {
  // Check curated monsters first
  const curated = knowledgeBase.monsters.find(
    (m) => m.name.toLowerCase() === name.toLowerCase() || m.id === name.toLowerCase().replace(/\s+/g, "_"),
  );
  if (curated) return curated;

  // Fall back to wiki data
  return findMonsterByName(name);
}

export function getQuestInfo(name: string): KnowledgeQuest | undefined {
  // Check curated quests first
  const curated = knowledgeBase.quests.find(
    (q) => q.name.toLowerCase() === name.toLowerCase() || q.id === name.toLowerCase().replace(/\s+/g, "_"),
  );
  if (curated) return curated;

  // Fall back to wiki data
  return findQuestByName(name);
}

export function getSkillMethods(skill: string): { f2pPages: string[]; p2pPages: string[] } {
  const index = loadSkillIndex();
  // Case-insensitive lookup
  const key = Object.keys(index).find((k) => k.toLowerCase() === skill.toLowerCase());
  if (!key) return { f2pPages: [], p2pPages: [] };

  const entry = index[key];
  return {
    f2pPages: entry.f2p_training ?? [],
    p2pPages: entry.p2p_training ?? [],
  };
}
