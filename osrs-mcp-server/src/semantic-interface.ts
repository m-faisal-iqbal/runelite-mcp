import type { RuneLiteSnapshot } from "./client.js";

export type SemanticControl = {
  id: string;
  type:
    | "dialogue_continue"
    | "dialogue_option"
    | "bank_action"
    | "inventory_item"
    | "equipment_item"
    | "spell"
    | "prayer"
    | "combat_style"
    | "quest_widget"
    | "generic_button";
  label: string;
  text?: string;
  role?: string;
  confidence: number;
  source: "snapshot_dialogue" | "interface_summary" | "widget" | "inventory" | "equipment" | "combat" | "prayer";
  widget?: {
    packedId?: number;
    groupId?: number;
    childId?: number;
    itemId?: number;
    itemName?: string;
    slot?: number;
    actions?: string[];
    name?: string;
    text?: string;
  };
  screen?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    coordinateSource?: string;
  };
  action?: {
    tool: string;
    arguments: Record<string, any>;
    executionNotes: string[];
  };
};

export type SemanticInterface = {
  status: "READY" | "NO_SNAPSHOT";
  dialogue: {
    type: string;
    text?: string;
    optionCount: number;
  };
  interfaceSummary?: any;
  controls: SemanticControl[];
  groups: Record<string, number>;
  recommendedNext: string[];
};

function cleanUiText(value: unknown) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function numberOrUndefined(value: any) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function widgetText(widget: any) {
  return cleanUiText([widget?.name, widget?.text, widget?.target].filter(Boolean).join(" "));
}

function widgetActions(widget: any): string[] {
  return Array.isArray(widget?.actions)
    ? widget.actions.filter((action: any) => typeof action === "string" && action.trim().length > 0)
    : [];
}

function widgetScreen(widget: any) {
  const x = numberOrUndefined(widget?.screenX ?? widget?.centerX);
  const y = numberOrUndefined(widget?.screenY ?? widget?.centerY);
  const width = numberOrUndefined(widget?.width ?? widget?.bounds?.width);
  const height = numberOrUndefined(widget?.height ?? widget?.bounds?.height);
  return {
    x,
    y,
    width,
    height,
    coordinateSource: widget?.coordinateSource ?? "widgetBounds",
  };
}

function widgetRef(widget: any) {
  return {
    packedId: numberOrUndefined(widget?.packedId ?? widget?.id),
    groupId: numberOrUndefined(widget?.groupId),
    childId: numberOrUndefined(widget?.childId),
    itemId: numberOrUndefined(widget?.itemId),
    itemName: widget?.itemName ?? widget?.name,
    slot: numberOrUndefined(widget?.slot),
    actions: widgetActions(widget),
    name: widget?.name,
    text: widget?.text,
  };
}

function widgetAction(controlType: SemanticControl["type"], widget: any, option?: string) {
  const ref = widgetRef(widget);
  const chosenOption = option ?? ref.actions?.[0] ?? "Select";
  return {
    tool: "invoke_widget_action",
    arguments: {
      packedId: ref.packedId,
      groupId: ref.groupId,
      childId: ref.childId,
      itemId: ref.itemId,
      option: chosenOption,
      dryRun: true,
    },
    executionNotes: [
      `${controlType} should be dry-run validated before real execution.`,
      "Use invoke_widget_action with the returned widget id only when the visible interface still matches.",
    ],
  };
}

function addControl(controls: SemanticControl[], control: SemanticControl) {
  if (controls.some((existing) => existing.id === control.id)) {
    return;
  }
  controls.push(control);
}

function addDialogueControls(snapshot: RuneLiteSnapshot, controls: SemanticControl[]) {
  const dialogue = snapshot.dialogue ?? {};
  const type = String(snapshot.interfaceSummary?.dialogueType ?? dialogue.type ?? "NONE");
  const text = cleanUiText(dialogue.text ?? snapshot.interfaceSummary?.dialogueText);
  if (type !== "NONE" && text) {
    addControl(controls, {
      id: "dialogue.continue",
      type: "dialogue_continue",
      label: "Continue dialogue",
      text,
      role: "continue",
      confidence: 0.95,
      source: "snapshot_dialogue",
      screen: {
        x: numberOrUndefined(dialogue.continueScreenX),
        y: numberOrUndefined(dialogue.continueScreenY),
        coordinateSource: "dialogueWidget",
      },
      action: {
        tool: "handle_dialogue",
        arguments: { maxSteps: 1, preferKeyboardContinue: true },
        executionNotes: ["Use handle_dialogue for one safe continue step, then re-read dialogue."],
      },
    });
  }

  const options = Array.isArray(dialogue.options) ? dialogue.options : [];
  for (const [index, option] of options.entries()) {
    const optionText = cleanUiText(option?.text ?? option);
    if (!optionText) {
      continue;
    }
    addControl(controls, {
      id: `dialogue.option.${index + 1}`,
      type: "dialogue_option",
      label: optionText,
      text: optionText,
      role: "select_dialogue_option",
      confidence: 0.98,
      source: "snapshot_dialogue",
      screen: {
        x: numberOrUndefined(option?.screenX),
        y: numberOrUndefined(option?.screenY),
        coordinateSource: "dialogueOption",
      },
      action: {
        tool: "handle_dialogue",
        arguments: { optionIndex: index + 1, maxSteps: 1 },
        executionNotes: ["Use handle_dialogue with this option index, then verify dialogue/chat state."],
      },
    });
  }
}

function addInventoryControls(snapshot: RuneLiteSnapshot, controls: SemanticControl[]) {
  for (const item of snapshot.inventory ?? []) {
    if (!item || item.id === -1 || !item.name) {
      continue;
    }
    const slot = numberOrUndefined(item.slot);
    addControl(controls, {
      id: `inventory.${slot ?? item.id}.${String(item.name).toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      type: "inventory_item",
      label: String(item.name),
      text: String(item.name),
      role: "inventory_item",
      confidence: 0.9,
      source: "inventory",
      widget: {
        itemId: item.id,
        itemName: item.name,
        slot,
        actions: (item as any).actions,
      },
      screen: {
        x: item.slotScreenX ?? item.screenX,
        y: item.slotScreenY ?? item.screenY,
        coordinateSource: item.coordinateSource ?? "inventorySlot",
      },
    });
  }
}

function addEquipmentControls(snapshot: RuneLiteSnapshot, controls: SemanticControl[]) {
  for (const item of snapshot.equipment ?? []) {
    if (!item || item.id === -1 || !item.name) {
      continue;
    }
    addControl(controls, {
      id: `equipment.${item.slot ?? item.id}.${String(item.name).toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      type: "equipment_item",
      label: String(item.name),
      text: String(item.name),
      role: "equipment_item",
      confidence: 0.85,
      source: "equipment",
      widget: { itemId: item.id, itemName: item.name, slot: item.slot, actions: (item as any).actions },
      screen: { x: item.screenX, y: item.screenY, coordinateSource: item.coordinateSource ?? "equipmentSlot" },
    });
  }
}

function addWidgetControls(widgets: any[], controls: SemanticControl[]) {
  for (const widget of widgets ?? []) {
    const text = widgetText(widget);
    const actions = widgetActions(widget);
    const haystack = `${text} ${actions.join(" ")}`.toLowerCase();
    if (!text && actions.length === 0) {
      continue;
    }

    let type: SemanticControl["type"] | undefined;
    let role: string | undefined;
    let confidence = 0.55;
    if (haystack.includes("continue") || haystack.includes("click here to continue")) {
      type = "dialogue_continue";
      role = "continue";
      confidence = 0.8;
    } else if (haystack.includes("withdraw") || haystack.includes("deposit") || haystack.includes("bank")) {
      type = "bank_action";
      role = haystack.includes("deposit") ? "deposit" : haystack.includes("withdraw") ? "withdraw" : "bank";
      confidence = 0.8;
    } else if (haystack.includes("quest") || haystack.includes("journal")) {
      type = "quest_widget";
      role = "quest";
      confidence = 0.7;
    } else if (haystack.includes("cast") || haystack.includes("spell")) {
      type = "spell";
      role = "spell";
      confidence = 0.65;
    } else if (haystack.includes("pray") || haystack.includes("activate")) {
      type = "prayer";
      role = "prayer";
      confidence = 0.65;
    } else if (actions.length > 0 || /\bok\b|accept|close|select|start|yes|no/i.test(text)) {
      type = "generic_button";
      role = "button";
    }

    if (!type) {
      continue;
    }

    const ref = widgetRef(widget);
    addControl(controls, {
      id: `widget.${ref.packedId ?? `${ref.groupId ?? "g"}_${ref.childId ?? "c"}`}.${type}`,
      type,
      label: text || actions[0] || type,
      text,
      role,
      confidence,
      source: "widget",
      widget: ref,
      screen: widgetScreen(widget),
      action: widgetAction(type, widget),
    });
  }
}

function groupCounts(controls: SemanticControl[]) {
  return controls.reduce<Record<string, number>>((groups, control) => {
    groups[control.type] = (groups[control.type] ?? 0) + 1;
    return groups;
  }, {});
}

export function buildSemanticInterface(snapshot: RuneLiteSnapshot | undefined, widgets: any[] = []): SemanticInterface {
  if (!snapshot) {
    return {
      status: "NO_SNAPSHOT",
      dialogue: { type: "NONE", optionCount: 0 },
      controls: [],
      groups: {},
      recommendedNext: ["Acquire a RuneLite snapshot before building semantic controls."],
    };
  }

  const controls: SemanticControl[] = [];
  addDialogueControls(snapshot, controls);
  addInventoryControls(snapshot, controls);
  addEquipmentControls(snapshot, controls);
  addWidgetControls(widgets, controls);

  const dialogueType = String(snapshot.interfaceSummary?.dialogueType ?? snapshot.dialogue?.type ?? "NONE");
  const recommendedNext = [];
  if (dialogueType !== "NONE") {
    recommendedNext.push("Resolve dialogue with handle_dialogue or a dialogue semantic control before ordinary actions.");
  }
  if ((snapshot.interfaceSummary as any)?.bankContainerAvailable) {
    recommendedNext.push("Use bank semantic controls or bank action tools for inventory management.");
  }
  if (controls.length === 0) {
    recommendedNext.push("No semantic controls were identified; use get_widgets with a focused filter or capture a screenshot.");
  }

  return {
    status: "READY",
    dialogue: {
      type: dialogueType,
      text: cleanUiText(snapshot.dialogue?.text ?? snapshot.interfaceSummary?.dialogueText),
      optionCount: Array.isArray(snapshot.dialogue?.options) ? snapshot.dialogue.options.length : 0,
    },
    interfaceSummary: snapshot.interfaceSummary,
    controls,
    groups: groupCounts(controls),
    recommendedNext,
  };
}

export function findSemanticControls(interfaceState: SemanticInterface, args: {
  type?: string;
  text?: string;
  role?: string;
  limit?: number;
}) {
  const type = cleanUiText(args.type).toLowerCase();
  const text = cleanUiText(args.text).toLowerCase();
  const role = cleanUiText(args.role).toLowerCase();
  const limit = Math.max(1, Math.min(100, args.limit ?? 20));
  return interfaceState.controls
    .filter((control) => !type || control.type === type)
    .filter((control) => !role || cleanUiText(control.role).toLowerCase().includes(role))
    .filter((control) => !text || `${control.label} ${control.text ?? ""}`.toLowerCase().includes(text))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

export function planQuestStep(args: {
  questName: string;
  snapshot?: RuneLiteSnapshot;
  semanticInterface: SemanticInterface;
  questKnowledge?: any;
}) {
  const questKey = cleanUiText(args.questName).toLowerCase();
  const snapshot = args.snapshot;
  const semantic = args.semanticInterface;
  const dialogueOpen = semantic.dialogue.type !== "NONE";
  const inventoryNames = new Set((snapshot?.inventory ?? [])
    .filter((item: any) => item && item.id && item.id !== -1)
    .map((item: any) => cleanUiText(item.name).toLowerCase()));

  if (!snapshot || snapshot.state?.status !== "LOGGED_IN") {
    return {
      status: "QUEST_BLOCKED",
      questName: args.questName,
      phase: "need_login",
      selectedStep: null,
      stopReason: "Player is not logged in or no snapshot is available.",
      checklist: [],
    };
  }

  if (dialogueOpen) {
    return {
      status: "QUEST_STEP_READY",
      questName: args.questName,
      phase: "dialogue",
      selectedStep: { tool: "handle_dialogue", arguments: { maxSteps: 1 } },
      semanticControls: semantic.controls.filter((control) => control.type.startsWith("dialogue")),
      stopReason: undefined,
      checklist: ["Resolve current dialogue before any walking, item collection, or NPC interaction."],
    };
  }

  if (questKey.includes("cook")) {
    const required = [
      { item: "egg", label: "Egg" },
      { item: "bucket of milk", label: "Bucket of milk" },
      { item: "pot of flour", label: "Pot of flour" },
    ];
    const missing = required.filter((entry) => !inventoryNames.has(entry.item));
    if (missing.length === 0) {
      return {
        status: "QUEST_STEP_READY",
        questName: args.questName,
        phase: "return_to_cook",
        selectedStep: { tool: "skill_interact", arguments: { entityType: "npc", name: "Cook", option: "Talk-to", executionMode: "dry_run" } },
        stopReason: undefined,
        checklist: ["Talk to the Cook in Lumbridge Castle kitchen.", "Use dialogue controls to hand in the ingredients."],
        knowledge: args.questKnowledge,
      };
    }
    return {
      status: "QUEST_NEEDS_ITEMS",
      questName: args.questName,
      phase: "collect_items",
      selectedStep: null,
      missingItems: missing.map((entry) => entry.label),
      stopReason: "Cook's Assistant requires ingredient collection. Phase 5 V1 plans this, but global collection routing arrives later.",
      checklist: [
        "Collect an egg from a chicken farm.",
        "Use a bucket on a dairy cow for milk.",
        "Acquire a pot of flour from a mill or spawn.",
        "Return to the Cook after all three items are in inventory.",
      ],
      knowledge: args.questKnowledge,
    };
  }

  if (questKey.includes("tutorial")) {
    return {
      status: "QUEST_STEP_READY",
      questName: args.questName,
      phase: "tutorial_guidance",
      selectedStep: { tool: "observe_game", arguments: { objective: "complete Tutorial Island", includePlan: true } },
      stopReason: undefined,
      checklist: [
        "Follow the currently visible instructor or interface.",
        "Use semantic dialogue controls for Continue/options.",
        "Do not choose account restrictions without explicit user confirmation.",
      ],
      knowledge: args.questKnowledge,
    };
  }

  return {
    status: "QUEST_PLANNED_ONLY",
    questName: args.questName,
    phase: "knowledge_outline",
    selectedStep: null,
    stopReason: "Phase 5 V1 has semantic interface support plus curated outlines for Tutorial Island and Cook's Assistant first.",
    checklist: args.questKnowledge?.steps ?? [],
    knowledge: args.questKnowledge,
  };
}
