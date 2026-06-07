// ─── Quest Varbit Registry ────────────────────────────────────────────────────
// Maps quest name → varbit ID → stage values → human-readable stage label.
// Source: OSRS wiki quest varbit pages.
// Stage 0 = not started, max value = completed.

export type QuestStage = {
  varbitId: number;       // primary varbit that tracks this quest
  varplayer?: number;     // some quests use varplayer instead
  notStarted: number;     // value when quest not yet started (usually 0)
  completed: number;      // value when quest is fully complete
  stages: {
    value: number;
    label: string;
    nextAction: string;   // what the agent should do next
    location?: string;    // node ID from world_graph where action takes place
    requiresItems?: string[];
    requiresNpcs?: string[];
  }[];
};

export type QuestDefinition = {
  id: string;
  name: string;
  members: boolean;
  difficulty: string;
  questPoints: number;
  varbit: QuestStage;
  startLocation: string;   // world_graph node ID
  startNpc: string;
  requirements: { skill: string; level: number }[];
  itemRequirements: { item: string; quantity: number; consumed?: boolean }[];
  notes: string[];
};

// ─── Quest Registry ───────────────────────────────────────────────────────────

export const QUEST_REGISTRY: Record<string, QuestDefinition> = {

  "cooks_assistant": {
    id: "cooks_assistant",
    name: "Cook's Assistant",
    members: false,
    difficulty: "novice",
    questPoints: 1,
    startLocation: "lumbridge_spawn",
    startNpc: "Cook",
    requirements: [],
    itemRequirements: [
      { item: "Egg", quantity: 1, consumed: true },
      { item: "Bucket of milk", quantity: 1, consumed: true },
      { item: "Pot of flour", quantity: 1, consumed: true },
    ],
    notes: ["Egg from chickens east of Lumbridge", "Milk from dairy cow north of Lumbridge", "Flour from windmill north of Draynor or spawn in Lumbridge kitchen"],
    varbit: {
      varbitId: 26,
      notStarted: 0,
      completed: 10,
      stages: [
        { value: 0,  label: "Not started",             nextAction: "Talk to Cook in Lumbridge Castle kitchen", location: "lumbridge_spawn", requiresNpcs: ["Cook"] },
        { value: 1,  label: "Spoken to cook",          nextAction: "Collect egg from chickens east of Lumbridge", location: "lumbridge_chickens", requiresItems: ["Egg"] },
        { value: 5,  label: "Has ingredients",         nextAction: "Return all 3 ingredients to the Cook", location: "lumbridge_spawn", requiresNpcs: ["Cook"] },
        { value: 10, label: "Completed",               nextAction: "Quest complete!" },
      ],
    },
  },

  "witchs_potion": {
    id: "witchs_potion",
    name: "Witch's Potion",
    members: false,
    difficulty: "novice",
    questPoints: 1,
    startLocation: "rimmington",
    startNpc: "Hetty",
    requirements: [],
    itemRequirements: [
      { item: "Rat's tail", quantity: 1, consumed: true },
      { item: "Eye of newt", quantity: 1, consumed: true },
      { item: "Burnt meat", quantity: 1, consumed: true },
      { item: "Onion", quantity: 1, consumed: true },
    ],
    notes: ["Rat's tail from giant rats south of Varrock", "Eye of newt from Port Sarim magic shop", "Burnt meat from cooking meat on a fire until it burns", "Onion from farm east of Rimmington"],
    varbit: {
      varbitId: 316,
      notStarted: 0,
      completed: 4,
      stages: [
        { value: 0, label: "Not started",     nextAction: "Talk to Hetty in Rimmington", location: "rimmington", requiresNpcs: ["Hetty"] },
        { value: 1, label: "Gathering items", nextAction: "Collect all 4 ingredients", requiresItems: ["Rat's tail","Eye of newt","Burnt meat","Onion"] },
        { value: 3, label: "Items gathered",  nextAction: "Return to Hetty with all items", location: "rimmington", requiresNpcs: ["Hetty"] },
        { value: 4, label: "Completed",       nextAction: "Quest complete!" },
      ],
    },
  },

  "sheep_shearer": {
    id: "sheep_shearer",
    name: "Sheep Shearer",
    members: false,
    difficulty: "novice",
    questPoints: 1,
    startLocation: "falador_east_bank",
    startNpc: "Fred the Farmer",
    requirements: [],
    itemRequirements: [{ item: "Wool", quantity: 20, consumed: true }],
    notes: ["Shear 20 sheep north of Lumbridge. Wool is noted when picked up. Spin on spinning wheel."],
    varbit: {
      varbitId: 179,
      notStarted: 0,
      completed: 2,
      stages: [
        { value: 0, label: "Not started",      nextAction: "Talk to Fred the Farmer north of Lumbridge", requiresNpcs: ["Fred the Farmer"] },
        { value: 1, label: "Shearing sheep",   nextAction: "Shear 20 sheep and spin into balls of wool", requiresItems: ["Shears"] },
        { value: 2, label: "Completed",        nextAction: "Quest complete!" },
      ],
    },
  },

  "romeo_juliet": {
    id: "romeo_juliet",
    name: "Romeo & Juliet",
    members: false,
    difficulty: "novice",
    questPoints: 5,
    startLocation: "varrock_center",
    startNpc: "Romeo",
    requirements: [],
    itemRequirements: [],
    notes: ["Talk to Romeo in Varrock square", "Find Juliet in house west of Varrock", "Speak to Father Lawrence", "Get cadava potion from the Apothecary", "Return to Romeo"],
    varbit: {
      varbitId: 144,
      notStarted: 0,
      completed: 100,
      stages: [
        { value: 0,   label: "Not started",          nextAction: "Talk to Romeo in Varrock square", location: "varrock_center", requiresNpcs: ["Romeo"] },
        { value: 10,  label: "Find Juliet",           nextAction: "Find Juliet in the house west of Varrock", requiresNpcs: ["Juliet"] },
        { value: 20,  label: "Speak Father Lawrence", nextAction: "Speak to Father Lawrence in Varrock church", requiresNpcs: ["Father Lawrence"] },
        { value: 30,  label: "Get cadava potion",     nextAction: "Take a cadava berry to the Apothecary in Varrock", requiresNpcs: ["Apothecary"] },
        { value: 40,  label: "Return potion",         nextAction: "Give the potion to Juliet", requiresNpcs: ["Juliet"] },
        { value: 100, label: "Completed",             nextAction: "Quest complete!" },
      ],
    },
  },

  "imp_catcher": {
    id: "imp_catcher",
    name: "Imp Catcher",
    members: false,
    difficulty: "novice",
    questPoints: 1,
    startLocation: "wizard_tower",
    startNpc: "Mizgog",
    requirements: [],
    itemRequirements: [
      { item: "Black bead", quantity: 1, consumed: true },
      { item: "White bead", quantity: 1, consumed: true },
      { item: "Red bead",   quantity: 1, consumed: true },
      { item: "Yellow bead",quantity: 1, consumed: true },
    ],
    notes: ["Beads dropped by imps all over Asgarnia and Misthalin", "Can buy from other players", "Mizgog is on top floor of Wizards Tower"],
    varbit: {
      varbitId: 66,
      notStarted: 0,
      completed: 2,
      stages: [
        { value: 0, label: "Not started",   nextAction: "Talk to Mizgog on top floor of Wizards Tower", location: "wizard_tower", requiresNpcs: ["Mizgog"] },
        { value: 1, label: "Hunting beads", nextAction: "Collect all 4 coloured beads from imps", requiresItems: ["Black bead","White bead","Red bead","Yellow bead"] },
        { value: 2, label: "Completed",     nextAction: "Quest complete!" },
      ],
    },
  },

  "the_restless_ghost": {
    id: "the_restless_ghost",
    name: "The Restless Ghost",
    members: false,
    difficulty: "novice",
    questPoints: 1,
    startLocation: "lumbridge_spawn",
    startNpc: "Father Aereck",
    requirements: [],
    itemRequirements: [],
    notes: ["Speak to Father Aereck in Lumbridge Church", "Get a ghostspeak amulet from Father Urhney in Lumbridge Swamp", "Talk to the ghost in the graveyard", "Retrieve the ghost's skull from the Wizards Tower basement"],
    varbit: {
      varbitId: 107,
      notStarted: 0,
      completed: 8,
      stages: [
        { value: 0, label: "Not started",          nextAction: "Talk to Father Aereck in Lumbridge church", requiresNpcs: ["Father Aereck"] },
        { value: 1, label: "Get ghostspeak amulet",nextAction: "Go to Lumbridge Swamp and talk to Father Urhney", location: "lumbridge_swamp", requiresNpcs: ["Father Urhney"] },
        { value: 3, label: "Talk to ghost",        nextAction: "Put on ghostspeak amulet and talk to the ghost in the graveyard", requiresItems: ["Ghostspeak amulet"] },
        { value: 5, label: "Find skull",           nextAction: "Go to Wizards Tower basement and retrieve the ghost's skull", location: "wizard_tower" },
        { value: 8, label: "Completed",            nextAction: "Quest complete!" },
      ],
    },
  },

  "dragon_slayer_i": {
    id: "dragon_slayer_i",
    name: "Dragon Slayer I",
    members: false,
    difficulty: "experienced",
    questPoints: 2,
    startLocation: "champions_guild",
    startNpc: "Guildmaster",
    requirements: [
      { skill: "Quest Points", level: 32 },
    ],
    itemRequirements: [
      { item: "Anti-dragon shield", quantity: 1 },
      { item: "Rune platebody", quantity: 1 },
    ],
    notes: ["Need 32 QP to enter Champions Guild", "Collect 3 map pieces", "Kill Elvarg (combat 83) with anti-dragon shield", "Reward: ability to wear rune platebody"],
    varbit: {
      varbitId: 190,
      notStarted: 0,
      completed: 85,
      stages: [
        { value: 0,  label: "Not started",         nextAction: "Talk to Guildmaster in Champions Guild", location: "champions_guild", requiresNpcs: ["Guildmaster"] },
        { value: 3,  label: "Collecting map pieces",nextAction: "Collect the 3 map pieces (Melzar's Maze, Oracle chest, Goblin Village)" },
        { value: 10, label: "Have map pieces",     nextAction: "Use map pieces on each other to make the full map" },
        { value: 20, label: "Need Crandor map",    nextAction: "Board the Lady Lumbridge boat from Port Sarim", location: "port_sarim_docks" },
        { value: 85, label: "Completed",           nextAction: "Quest complete!" },
      ],
    },
  },

};

/** Look up a quest definition by name (case-insensitive, partial match) */
export function getQuestDefinition(name: string): QuestDefinition | undefined {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_");
  return (
    QUEST_REGISTRY[norm] ??
    Object.values(QUEST_REGISTRY).find(
      (q) => q.name.toLowerCase() === name.toLowerCase() ||
             q.id === norm ||
             q.name.toLowerCase().includes(name.toLowerCase())
    )
  );
}

/** All registered quest IDs */
export function listRegisteredQuests(): string[] {
  return Object.keys(QUEST_REGISTRY);
}
