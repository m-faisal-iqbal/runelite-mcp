#!/usr/bin/env node
import { buildNextActionPlan, actionStep } from "../build/planner.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function toolNames(plan) {
  return plan.steps.map((step) => step.tool);
}

function baseContext(runtimeStatus = "ok") {
  return {
    runtime: { status: runtimeStatus },
  };
}

function loggedInSnapshot(overrides = {}) {
  return {
    state: { status: "LOGGED_IN", health: 10, location: { x: 3200, y: 3200, plane: 0 } },
    skills: { Hitpoints: { level: 10 } },
    inventory: [],
    objects: [],
    npcs: [],
    groundItems: [],
    dialogue: { type: "NONE" },
    interfaceSummary: { dialogueType: "NONE" },
    ...overrides,
  };
}

const notLoggedIn = buildNextActionPlan(baseContext(), {
  state: { status: "LOGIN_SCREEN" },
}, "chop 5 trees");
assert(notLoggedIn.mode === "wait_for_login", "not logged in should wait");
assert(toolNames(notLoggedIn).includes("get_agent_context"), "not logged in should refresh context");

const woodcutting = buildNextActionPlan(baseContext(), loggedInSnapshot({
  inventory: [{ id: 1511, name: "Logs", quantity: 2 }],
  objects: [
    { id: 1276, name: "Tree", option: "Chop down", distanceToPlayer: 2 },
    { id: 9999, name: "Rocks", option: "Mine", distanceToPlayer: 1 },
  ],
}), "chop 5 normal trees");
assert(woodcutting.mode === "woodcutting", "tree objective should create woodcutting plan");
assert(JSON.stringify(toolNames(woodcutting)) === JSON.stringify(["mark_action_baseline", "perform_until", "verify_last_action"]), "woodcutting should baseline, act, verify");
const woodcutAction = woodcutting.steps.find((step) => step.tool === "perform_until");
assert(woodcutAction.arguments.condition === "inventory_quantity_at_least", "woodcutting with count should stop on log quantity");
assert(woodcutAction.arguments.inventoryQuantityAtLeast === 7, "woodcutting stop quantity should be current logs plus requested count");

const dialogue = buildNextActionPlan(baseContext(), loggedInSnapshot({
  interfaceSummary: { dialogueType: "NPC" },
  dialogue: { type: "NPC", text: "Hello there" },
}), "continue quest dialogue");
assert(dialogue.mode === "handle_interface", "open dialogue should take priority");
assert(toolNames(dialogue).includes("handle_dialogue"), "open dialogue should use handle_dialogue");

const fullInventory = buildNextActionPlan(baseContext(), loggedInSnapshot({
  inventory: Array.from({ length: 28 }, (_, index) => ({ id: 1511, name: "Logs", slot: index, quantity: 1 })),
  objects: [{ id: 10060, name: "Bank booth", option: "Bank", distanceToPlayer: 3 }],
}), "woodcut and bank");
assert(fullInventory.mode === "inventory_full", "full inventory should switch to banking");
assert(fullInventory.steps[0].tool === "interact_with", "full inventory with visible bank should interact with bank");

const lowHp = buildNextActionPlan(baseContext(), loggedInSnapshot({
  state: { status: "LOGGED_IN", health: 2 },
  skills: { Hitpoints: { level: 10 } },
  inventory: [{ id: 333, name: "Trout", slot: 0, quantity: 1 }],
}), "walk to Varrock");
assert(lowHp.steps[0].tool === "eat_food_when", "low hp with food should add food safety first");

const staleRuntime = buildNextActionPlan(baseContext("needs_reload"), loggedInSnapshot(), "look around");
assert(staleRuntime.steps[0].tool === "diagnose_runtime", "stale runtime should diagnose first");

const step = actionStep("test_tool", "test reason", { ok: true }, { priority: "test" });
assert(step.tool === "test_tool" && step.priority === "test" && step.arguments.ok === true, "actionStep should preserve fields");

console.log(JSON.stringify({
  ok: true,
  cases: {
    notLoggedIn: notLoggedIn.mode,
    woodcutting: woodcutting.mode,
    dialogue: dialogue.mode,
    fullInventory: fullInventory.mode,
    lowHpFirstTool: lowHp.steps[0].tool,
    staleRuntimeFirstTool: staleRuntime.steps[0].tool,
  },
}, null, 2));
