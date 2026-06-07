// ─── Dialogue Tree Handler ────────────────────────────────────────────────────
// Parses NPC dialogue state from the RuneLite snapshot and selects the correct
// option or continue action.

import type { RuneLiteSnapshot } from "../client.js";

export type DialogueType =
  | "NPC_SPEECH"       // NPC talking, click to continue
  | "PLAYER_SPEECH"    // Player talking, click to continue
  | "OPTIONS"          // Player must select an option
  | "LEVEL_UP"         // Level up dialog, click to continue
  | "ITEM_EXAMINE"     // Examine text dialog
  | "NONE";            // No dialogue open

export type DialogueState = {
  type: DialogueType;
  npcName?: string;
  text?: string;
  options?: string[];
  optionCount: number;
  raw?: unknown;
};

export type DialogueAction = {
  action: "CONTINUE" | "SELECT_OPTION" | "WAIT" | "NONE";
  optionIndex?: number;   // 1-based index for SELECT_OPTION
  optionText?: string;
  reason: string;
  tool?: string;
  toolArgs?: Record<string, unknown>;
};

/** Parse the current dialogue state from snapshot */
export function parseDialogueState(snapshot: RuneLiteSnapshot): DialogueState {
  const dialogue = snapshot?.dialogue;
  if (!dialogue || typeof dialogue !== "object") {
    return { type: "NONE", optionCount: 0 };
  }

  const type = String(dialogue.type ?? "").toUpperCase();
  const options: string[] = Array.isArray(dialogue.options)
    ? dialogue.options.map((o: unknown) => String(o ?? ""))
    : [];

  let dialogueType: DialogueType = "NONE";
  if (type.includes("NPC") || type.includes("CHAT")) {
    dialogueType = options.length > 0 ? "OPTIONS" : "NPC_SPEECH";
  } else if (type.includes("PLAYER")) {
    dialogueType = options.length > 0 ? "OPTIONS" : "PLAYER_SPEECH";
  } else if (type.includes("OPTION") || options.length > 0) {
    dialogueType = "OPTIONS";
  } else if (type.includes("LEVEL")) {
    dialogueType = "LEVEL_UP";
  } else if (dialogue.text || dialogue.npcName || dialogue.message) {
    dialogueType = "NPC_SPEECH";
  }

  return {
    type: dialogueType,
    npcName: dialogue.npcName ? String(dialogue.npcName) : undefined,
    text: dialogue.text ?? dialogue.message ? String(dialogue.text ?? dialogue.message) : undefined,
    options,
    optionCount: options.length,
    raw: dialogue,
  };
}

/**
 * Decide what dialogue action to take.
 * @param state    Current parsed dialogue state
 * @param strategy How to choose between options:
 *   - "continue"           → always click continue / first option
 *   - keyword string       → select option containing that keyword (case-insensitive)
 *   - number               → select option at that 1-based index
 *   - string[]             → priority list of keywords, first match wins
 */
export function decideDialogueAction(
  state: DialogueState,
  strategy: "continue" | string | number | string[] = "continue"
): DialogueAction {
  if (state.type === "NONE") {
    return { action: "NONE", reason: "No dialogue open" };
  }

  // Continue/level-up/speech: just click through
  if (state.type !== "OPTIONS" || state.optionCount === 0) {
    return {
      action: "CONTINUE",
      reason: `${state.type} — click to continue`,
      tool: "handle_dialogue",
      toolArgs: { action: "continue" },
    };
  }

  // Option selection
  if (typeof strategy === "number") {
    const idx = Math.min(Math.max(1, strategy), state.optionCount);
    return {
      action: "SELECT_OPTION",
      optionIndex: idx,
      optionText: state.options?.[idx - 1],
      reason: `Selecting option ${idx} by index`,
      tool: "handle_dialogue",
      toolArgs: { action: "select_option", optionIndex: idx },
    };
  }

  if (strategy === "continue") {
    return {
      action: "SELECT_OPTION",
      optionIndex: 1,
      optionText: state.options?.[0],
      reason: "Selecting first option (continue strategy)",
      tool: "handle_dialogue",
      toolArgs: { action: "select_option", optionIndex: 1 },
    };
  }

  const keywords = Array.isArray(strategy) ? strategy : [strategy];
  for (const kw of keywords) {
    const kwLow = kw.toLowerCase();
    const idx = state.options?.findIndex((o) => o.toLowerCase().includes(kwLow)) ?? -1;
    if (idx >= 0) {
      return {
        action: "SELECT_OPTION",
        optionIndex: idx + 1,
        optionText: state.options?.[idx],
        reason: `Matched keyword "${kw}" in option "${state.options?.[idx]}"`,
        tool: "handle_dialogue",
        toolArgs: { action: "select_option", optionIndex: idx + 1 },
      };
    }
  }

  // No keyword matched — default to first option
  return {
    action: "SELECT_OPTION",
    optionIndex: 1,
    optionText: state.options?.[0],
    reason: `No keyword matched from ${JSON.stringify(keywords)} — defaulting to option 1`,
    tool: "handle_dialogue",
    toolArgs: { action: "select_option", optionIndex: 1 },
  };
}

/** Is dialogue currently open? */
export function isDialogueOpen(snapshot: RuneLiteSnapshot): boolean {
  return parseDialogueState(snapshot).type !== "NONE";
}

/**
 * Build a full dialogue resolution plan for a multi-step conversation.
 * Provide a list of strategies for each expected dialogue step.
 * Returns actions to execute in order.
 */
export function planDialogueSequence(
  strategies: ("continue" | string | number | string[])[]
): { stepIndex: number; strategy: typeof strategies[number] }[] {
  return strategies.map((strategy, i) => ({ stepIndex: i, strategy }));
}
