// ─── Quest State Machine ──────────────────────────────────────────────────────
// Reads varbit values from the RuneLite snapshot and maps them to quest stages.
import { getQuestDefinition, QUEST_REGISTRY } from "./quest-registry.js";
/** Read a varbit value from the RuneLite snapshot */
function readVarbit(snapshot, varbitId) {
    const state = snapshot?.state;
    if (!state)
        return null;
    // Plugin exposes varbits under state.varbits or state.varbit
    const varbits = state.varbits ?? state.varbit ?? {};
    if (typeof varbits === "object" && varbits !== null) {
        const val = varbits[varbitId] ?? varbits[String(varbitId)];
        if (val != null)
            return Number(val);
    }
    // Fallback: state.questState map
    const questState = state.questState ?? state.quests ?? {};
    if (typeof questState === "object") {
        const val = questState[varbitId] ?? questState[String(varbitId)];
        if (val != null)
            return Number(val);
    }
    return null;
}
/** Find which stage the current varbit value maps to */
function resolveStage(varbit, currentValue) {
    // Find the highest stage value <= currentValue
    const sorted = [...varbit.stages].sort((a, b) => b.value - a.value);
    return sorted.find((s) => currentValue >= s.value) ?? varbit.stages[0];
}
/** Get the full quest state for a named quest from a live snapshot */
export function getQuestState(questName, snapshot) {
    const def = getQuestDefinition(questName);
    if (!def) {
        return {
            questId: questName,
            questName,
            status: "UNKNOWN",
            currentVarbitValue: null,
            currentStageIndex: 0,
            currentStageLabel: "Quest not in registry",
            nextAction: "Quest definition not found — add to quest-registry.ts",
            progressPercent: 0,
            definition: {},
        };
    }
    const varbitValue = readVarbit(snapshot, def.varbit.varbitId);
    const effectiveValue = varbitValue ?? def.varbit.notStarted;
    let status;
    if (effectiveValue >= def.varbit.completed) {
        status = "COMPLETED";
    }
    else if (effectiveValue <= def.varbit.notStarted) {
        status = "NOT_STARTED";
    }
    else {
        status = "IN_PROGRESS";
    }
    const stage = resolveStage(def.varbit, effectiveValue);
    const stageIndex = def.varbit.stages.indexOf(stage);
    const totalStages = def.varbit.stages.length - 1; // exclude completion stage
    const progressPercent = status === "COMPLETED"
        ? 100
        : Math.round((stageIndex / Math.max(totalStages, 1)) * 100);
    return {
        questId: def.id,
        questName: def.name,
        status,
        currentVarbitValue: varbitValue,
        currentStageIndex: stageIndex,
        currentStageLabel: stage.label,
        nextAction: stage.nextAction,
        nextLocation: stage.location,
        requiresItems: stage.requiresItems,
        requiresNpcs: stage.requiresNpcs,
        progressPercent,
        definition: def,
    };
}
/** Check if a quest is complete based on snapshot */
export function isQuestComplete(questName, snapshot) {
    return getQuestState(questName, snapshot).status === "COMPLETED";
}
/** Get next action for any quest in progress */
export function getNextQuestAction(questName, snapshot) {
    const state = getQuestState(questName, snapshot);
    if (state.status === "COMPLETED")
        return null;
    return {
        action: state.nextAction,
        location: state.nextLocation,
        items: state.requiresItems,
        npcs: state.requiresNpcs,
    };
}
/** Count quest points from all completed quests in registry */
export function countQuestPoints(snapshot) {
    let total = 0;
    for (const def of Object.values(QUEST_REGISTRY)) {
        const varbitVal = readVarbit(snapshot, def.varbit.varbitId) ?? def.varbit.notStarted;
        if (varbitVal >= def.varbit.completed) {
            total += def.questPoints;
        }
    }
    return total;
}
