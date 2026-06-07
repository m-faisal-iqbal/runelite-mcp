// ─── Dialogue Tree Handler ────────────────────────────────────────────────────
// Parses NPC dialogue state from the RuneLite snapshot and selects the correct
// option or continue action.
/** Parse the current dialogue state from snapshot */
export function parseDialogueState(snapshot) {
    const dialogue = snapshot?.dialogue;
    if (!dialogue || typeof dialogue !== "object") {
        return { type: "NONE", optionCount: 0 };
    }
    const type = String(dialogue.type ?? "").toUpperCase();
    const options = Array.isArray(dialogue.options)
        ? dialogue.options.map((o) => String(o ?? ""))
        : [];
    let dialogueType = "NONE";
    if (type.includes("NPC") || type.includes("CHAT")) {
        dialogueType = options.length > 0 ? "OPTIONS" : "NPC_SPEECH";
    }
    else if (type.includes("PLAYER")) {
        dialogueType = options.length > 0 ? "OPTIONS" : "PLAYER_SPEECH";
    }
    else if (type.includes("OPTION") || options.length > 0) {
        dialogueType = "OPTIONS";
    }
    else if (type.includes("LEVEL")) {
        dialogueType = "LEVEL_UP";
    }
    else if (dialogue.text || dialogue.npcName || dialogue.message) {
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
export function decideDialogueAction(state, strategy = "continue") {
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
export function isDialogueOpen(snapshot) {
    return parseDialogueState(snapshot).type !== "NONE";
}
/**
 * Build a full dialogue resolution plan for a multi-step conversation.
 * Provide a list of strategies for each expected dialogue step.
 * Returns actions to execute in order.
 */
export function planDialogueSequence(strategies) {
    return strategies.map((strategy, i) => ({ stepIndex: i, strategy }));
}
