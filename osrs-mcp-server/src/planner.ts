import type { RuneLiteSnapshot, RuneLiteTarget } from "./client.js";

export function actionStep(tool: string, reason: string, args: Record<string, any>, extra: Record<string, any> = {}) {
  return {
    tool,
    reason,
    arguments: args,
    ...extra,
  };
}

function objectiveCount(objective?: string): number | undefined {
  const match = String(objective ?? "").match(/\b(\d{1,3})\b/);
  if (!match) {
    return undefined;
  }
  const count = Number(match[1]);
  return Number.isFinite(count) && count > 0 ? Math.min(count, 28) : undefined;
}

function objectiveIncludes(objective: string | undefined, words: string[]): boolean {
  const text = String(objective ?? "").toLowerCase();
  return words.some((word) => text.includes(word));
}

function sortByDistance<T extends RuneLiteTarget>(items: T[]): T[] {
  return items.slice().sort((a, b) => (a.distanceToPlayer ?? Number.MAX_SAFE_INTEGER) - (b.distanceToPlayer ?? Number.MAX_SAFE_INTEGER));
}

function nearestMatchingTarget(targets: RuneLiteTarget[] | undefined, predicate: (target: RuneLiteTarget) => boolean) {
  return sortByDistance((targets ?? []).filter(predicate))[0];
}

function targetMatches(target: RuneLiteTarget, name?: string, id?: number): boolean {
  if (id !== undefined && target.id !== id) {
    return false;
  }
  if (name && String(target.name ?? "").toLowerCase() !== name.toLowerCase()) {
    return false;
  }
  return true;
}

function inventorySlotsUsed(snapshot: RuneLiteSnapshot): number {
  return (snapshot.inventory ?? []).filter((item: any) => item && item.id && item.id !== -1).length;
}

function inventoryQuantity(snapshot: RuneLiteSnapshot, name?: string, id?: number): number {
  return (snapshot.inventory ?? [])
    .filter((item: any) => targetMatches(item, name, id))
    .reduce((total: number, item: any) => total + (Number.isFinite(item.quantity) ? Number(item.quantity) : 1), 0);
}

function healthPercent(snapshot: RuneLiteSnapshot): number | undefined {
  const current = Number(snapshot.state?.health);
  const max = Number(snapshot.skills?.Hitpoints?.level ?? snapshot.skills?.["Hitpoints"]?.level);
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) {
    return undefined;
  }
  return (current / max) * 100;
}

function findFoodItem(snapshot: RuneLiteSnapshot): RuneLiteTarget | undefined {
  const defaultFoodNeedles = [
    "shrimp", "sardine", "herring", "trout", "salmon", "tuna", "lobster", "swordfish",
    "monkfish", "shark", "sea turtle", "manta ray", "anglerfish", "karambwan",
    "cake", "pie", "pizza", "potato", "stew", "wine",
  ];

  return (snapshot.inventory ?? []).find((item: any) => {
    const itemName = String(item.name ?? "").toLowerCase();
    return defaultFoodNeedles.some((needle) => itemName.includes(needle));
  });
}

export function buildNextActionPlan(context: any, snapshot: RuneLiteSnapshot, objective?: string) {
  const state = snapshot.state ?? {};
  const dialogueType = snapshot.interfaceSummary?.dialogueType ?? snapshot.dialogue?.type ?? "NONE";
  const hpPercent = healthPercent(snapshot);
  const count = objectiveCount(objective);
  const steps: any[] = [];
  const notes: string[] = [];

  if (context.runtime?.status && context.runtime.status !== "ok" && context.runtime.status !== "not_checked") {
    steps.push(actionStep("diagnose_runtime", "Runtime feature checks are not clean; confirm whether RuneLite needs a plugin reload before acting.", {}, { priority: "blocker" }));
  }

  if (state.status !== "LOGGED_IN") {
    steps.push(actionStep("get_agent_context", "The player is not logged in, so gameplay actions should wait.", { includeDiagnostics: true }, { priority: "blocker" }));
    return { steps, notes, mode: "wait_for_login" };
  }

  if (hpPercent !== undefined && hpPercent <= 35 && findFoodItem(snapshot)) {
    steps.push(actionStep("eat_food_when", "Hitpoints are low and food is available.", { healthPercentAtOrBelow: 35 }, { priority: "safety" }));
  }

  if (dialogueType && dialogueType !== "NONE") {
    steps.push(actionStep("handle_dialogue", "A dialogue or blocking interface is open; resolve it before ordinary movement or skilling.", {}, { priority: "interface" }));
    return { steps, notes, mode: "handle_interface" };
  }

  if (inventorySlotsUsed(snapshot) >= 28) {
    const bank = nearestMatchingTarget(snapshot.objects, (object: any) =>
      String(object.name ?? "").toLowerCase().includes("bank") ||
      String(object.option ?? "").toLowerCase().includes("bank")
    );
    if (bank) {
      steps.push(actionStep("interact_with", "Inventory is full; bank before continuing the objective.", {
        entityType: "object",
        name: bank.name,
        id: bank.id,
        option: bank.option ?? "Bank",
        nearestToPlayer: true,
      }, { priority: "inventory" }));
    } else {
      notes.push("Inventory is full, but no nearby bank object was visible in the loaded scene.");
    }
    return { steps, notes, mode: "inventory_full" };
  }

  if (objectiveIncludes(objective, ["chop", "woodcut", "woodcutting", "tree", "logs"])) {
    const tree = nearestMatchingTarget(snapshot.objects, (object: any) => {
      const name = String(object.name ?? "").toLowerCase();
      const option = String(object.option ?? "").toLowerCase();
      return (name === "tree" || name.includes("tree")) && (option.includes("chop") || option === "");
    });
    if (tree) {
      const currentLogs = inventoryQuantity(snapshot, "Logs");
      const stopArgs = count
        ? { condition: "inventory_quantity_at_least", inventoryItemName: "Logs", inventoryQuantityAtLeast: Math.min(28, currentLogs + count) }
        : { condition: "inventory_full" };
      steps.push(actionStep("mark_action_baseline", "Capture inventory/location/chat before the woodcutting loop.", { note: objective ?? "woodcutting loop" }, { priority: "verify_before" }));
      steps.push(actionStep("perform_until", "Use repeated in-client tree interactions, stopping at the requested log count or full inventory.", {
        actionEntityType: "object",
        actionName: tree.name ?? "Tree",
        actionId: tree.id,
        actionOption: "Chop down",
        nearestToPlayer: true,
        maxIterations: count ?? 28,
        ...stopArgs,
      }, { priority: "action", target: { name: tree.name, id: tree.id, distanceToPlayer: tree.distanceToPlayer } }));
      steps.push(actionStep("verify_last_action", "Confirm inventory/log or chat changes after the loop.", {
        inventoryItemName: "Logs",
        expectInventoryIncreased: true,
        expectNewChat: true,
        requireAnyChange: true,
      }, { priority: "verify_after" }));
      return { steps, notes, mode: "woodcutting" };
    }
    notes.push("Woodcutting objective detected, but no nearby tree was visible in the loaded scene.");
  }

  if (objectiveIncludes(objective, ["talk", "speak", "dialogue", "quest"])) {
    const npc = nearestMatchingTarget(snapshot.npcs, (target: any) =>
      String(target.option ?? "").toLowerCase().includes("talk") || Boolean(target.name)
    );
    if (npc) {
      steps.push(actionStep("mark_action_baseline", "Capture dialogue/chat before starting the conversation.", { note: objective ?? "talk to NPC" }, { priority: "verify_before" }));
      steps.push(actionStep("interact_with", "Talk to the nearest likely NPC using in-client menu params.", {
        entityType: "npc",
        name: npc.name,
        id: npc.id,
        option: "Talk-to",
        nearestToPlayer: true,
      }, { priority: "action", target: { name: npc.name, id: npc.id, distanceToPlayer: npc.distanceToPlayer } }));
      steps.push(actionStep("handle_dialogue", "Continue or choose dialogue options after the NPC interaction opens dialogue.", {}, { priority: "followup" }));
      return { steps, notes, mode: "dialogue" };
    }
  }

  if (objectiveIncludes(objective, ["take", "pickup", "pick up", "loot", "collect"])) {
    const item = sortByDistance(snapshot.groundItems ?? [])[0];
    if (item) {
      steps.push(actionStep("mark_action_baseline", "Capture inventory before taking the ground item.", { note: objective ?? "take ground item" }, { priority: "verify_before" }));
      steps.push(actionStep("interact_with", "Take the nearest visible ground item.", {
        entityType: "ground_item",
        name: item.name,
        id: item.id,
        option: "Take",
        nearestToPlayer: true,
      }, { priority: "action", target: { name: item.name, id: item.id, distanceToPlayer: item.distanceToPlayer } }));
      steps.push(actionStep("verify_last_action", "Confirm inventory changed after taking the item.", { expectInventorySlotsChanged: true, requireAnyChange: true }, { priority: "verify_after" }));
      return { steps, notes, mode: "ground_item" };
    }
  }

  steps.push(actionStep("get_agent_context", "No objective-specific action was confidently selected; refresh compact context before deciding manually.", {
    objective,
    includeDiagnostics: true,
  }, { priority: "observe" }));
  notes.push("Planner stayed conservative because the objective did not match a known safe routine or no suitable target was visible.");
  return { steps, notes, mode: "observe" };
}
