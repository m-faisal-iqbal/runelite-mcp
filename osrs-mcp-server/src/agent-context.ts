import type { RuneLiteSnapshot, RuneLiteTarget } from "./client.js";

export type AgentContextArgs = {
  objective?: string;
  includeNearbyLimit?: number;
  includeInventoryLimit?: number;
  streamStatus?: any;
  pathfindingStatus?: any;
};

function sortByDistance<T extends RuneLiteTarget>(items: T[]): T[] {
  return items.slice().sort((a, b) => (a.distanceToPlayer ?? Number.MAX_SAFE_INTEGER) - (b.distanceToPlayer ?? Number.MAX_SAFE_INTEGER));
}

function hasScreenPoint(target: RuneLiteTarget): boolean {
  return Number.isFinite(target.screenX) && Number.isFinite(target.screenY);
}

function inventorySlotsUsed(snapshot: RuneLiteSnapshot): number {
  return (snapshot.inventory ?? []).filter((item: any) => item && item.id && item.id !== -1).length;
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

function isPlayerIdle(state: any): boolean {
  const animation = Number(state?.animation ?? -1);
  return (state?.isIdle === true || animation === -1) && !state?.interactingWith;
}

function recentMessages(snapshot: RuneLiteSnapshot): any[] {
  return Array.isArray(snapshot.chat?.messages) ? snapshot.chat.messages : [];
}

function cleanUiText(value: unknown): string {
  return String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function summarizeTargets(targets: RuneLiteTarget[] | undefined, limit: number) {
  return sortByDistance(targets ?? [])
    .slice(0, Math.max(0, limit))
    .map((target: any) => ({
      id: target.id,
      name: target.name,
      option: target.option,
      worldX: target.worldX,
      worldY: target.worldY,
      plane: target.plane,
      distanceToPlayer: target.distanceToPlayer,
      coordinateSource: target.coordinateSource,
      clickable: hasScreenPoint(target) && !target.coordinateWarning,
      directMenuReady: Boolean(target.menuAction && Number.isFinite(target.param0) && Number.isFinite(target.param1)),
      menuAction: target.menuAction,
      ageMs: target.ageMs,
    }));
}

function inventorySummary(snapshot: RuneLiteSnapshot, limit: number) {
  const items = (snapshot.inventory ?? [])
    .filter((item: any) => item && item.id && item.id !== -1)
    .slice(0, Math.max(0, limit))
    .map((item: any) => ({
      slot: item.slot,
      id: item.id,
      name: item.name,
      quantity: item.quantity,
    }));
  return {
    slotsUsed: inventorySlotsUsed(snapshot),
    freeSlots: Math.max(0, 28 - inventorySlotsUsed(snapshot)),
    items,
  };
}

export function buildAgentContext(baseURL: string, client: any, snapshot: RuneLiteSnapshot, runtime: any, args: AgentContextArgs) {
  const nearbyLimit = Math.max(0, Math.min(args.includeNearbyLimit ?? 8, 30));
  const inventoryLimit = Math.max(0, Math.min(args.includeInventoryLimit ?? 28, 28));
  const state = snapshot.state ?? {};
  const hpPercent = healthPercent(snapshot);
  const dialogueType = snapshot.interfaceSummary?.dialogueType ?? snapshot.dialogue?.type ?? "NONE";
  const hasFood = Boolean(findFoodItem(snapshot));
  const risks = [];
  if (runtime?.status && runtime.status !== "ok" && runtime.status !== "not_checked") {
    risks.push("runtime_not_current");
  }
  if (state.status !== "LOGGED_IN") {
    risks.push("not_logged_in");
  }
  if (hpPercent !== undefined && hpPercent <= 35) {
    risks.push("low_hitpoints");
  }
  if (dialogueType && dialogueType !== "NONE") {
    risks.push("interface_or_dialogue_open");
  }
  if (inventorySlotsUsed(snapshot) >= 28) {
    risks.push("inventory_full");
  }
  if (args.pathfindingStatus?.supportsLocalPathfinding === false) {
    risks.push("pathfinding_unavailable");
  }

  const recommendedNext = [];
  if (runtime?.status && runtime.status !== "ok" && runtime.status !== "not_checked") {
    recommendedNext.push("Run diagnose_runtime and reload RuneLite plugin if endpoints/features are stale.");
  }
  if (state.status !== "LOGGED_IN") {
    recommendedNext.push("Wait for login before gameplay actions.");
  }
  if (hpPercent !== undefined && hpPercent <= 35 && hasFood) {
    recommendedNext.push("Use eat_food_when before risky combat or travel.");
  }
  if (dialogueType && dialogueType !== "NONE") {
    recommendedNext.push("Use handle_dialogue or get_widgets with a focused filter before other actions.");
  }
  if (args.pathfindingStatus?.supportsGlobalPathfinding === false) {
    recommendedNext.push("Navigation currently has loaded-scene pathfinding only; use calculate_path_to/walk_path_to for local movement and expect fallback for off-scene routes.");
  }
  recommendedNext.push("Before the next risky action, call mark_action_baseline; afterward call verify_last_action.");
  recommendedNext.push("Prefer interact_with/click_* with option for in-client menu actions.");

  return {
    objective: args.objective,
    status: risks.length === 0 ? "READY" : "ATTENTION_NEEDED",
    baseURL,
    runtime,
    client: {
      instanceId: client?.instanceId,
      playerName: client?.playerName ?? state.name,
      port: client?.port,
      apiVersion: client?.apiVersion,
      world: client?.world ?? state.world,
      focused: client?.windowActive,
      canvasShowing: client?.canvasShowing,
      supportsDirectMenuActions: client?.supportsDirectMenuActions === true,
    },
    readiness: {
      loggedIn: state.status === "LOGGED_IN",
      stateStatus: state.status,
      canUseInClientActions: state.status === "LOGGED_IN" && runtime?.status === "ok",
      canUseDirectMenuActions: state.status === "LOGGED_IN" && runtime?.status === "ok" && client?.supportsDirectMenuActions === true,
      osClickFallbackReady: state.status === "LOGGED_IN" && client?.canvasShowing !== false && client?.windowActive !== false && client?.windowMinimized !== true,
      risks,
      recommendedNext,
    },
    player: {
      name: state.name,
      location: state.location,
      health: state.health,
      healthPercent: hpPercent,
      runEnergy: state.runEnergy,
      animation: state.animation,
      idle: isPlayerIdle(state),
      interactingWith: state.interactingWith,
    },
    inventory: inventorySummary(snapshot, inventoryLimit),
    interface: {
      dialogueType,
      dialogueText: cleanUiText(snapshot.dialogue?.text),
      options: (snapshot.dialogue?.options ?? []).map((option: any, index: number) => ({ index: index + 1, text: cleanUiText(option.text) })),
      contextMenuOpen: snapshot.interfaceSummary?.contextMenuOpen,
      bankContainerAvailable: snapshot.interfaceSummary?.bankContainerAvailable,
    },
    nearby: {
      npcs: summarizeTargets(snapshot.npcs, nearbyLimit),
      objects: summarizeTargets(snapshot.objects, nearbyLimit),
      groundItems: summarizeTargets(snapshot.groundItems, nearbyLimit),
      players: summarizeTargets(snapshot.players, Math.min(nearbyLimit, 5)),
    },
    recentChat: recentMessages(snapshot).slice(-8),
    navigation: {
      pathfinding: args.pathfindingStatus,
    },
    stream: args.streamStatus,
  };
}
