#!/usr/bin/env node
import { buildAgentStepPackage, buildNextActionPlan, actionStep } from "../build/planner.js";

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
assert(fullInventory.steps[0].arguments.entityType === "object", "bank booth should be treated as object");

const bankDeposit = buildNextActionPlan(baseContext(), loggedInSnapshot({
  interfaceSummary: { dialogueType: "NONE", bankContainerAvailable: true },
  inventory: [{ id: 1511, name: "Logs", slot: 0, quantity: 5 }],
}), "deposit logs in bank");
assert(bankDeposit.mode === "bank_deposit", "open bank with deposit objective should deposit");
assert(JSON.stringify(toolNames(bankDeposit)) === JSON.stringify(["mark_action_baseline", "deposit_inventory_item", "verify_last_action"]), "bank deposit should baseline, deposit, verify");

const mining = buildNextActionPlan(baseContext(), loggedInSnapshot({
  inventory: [{ id: 440, name: "Iron ore", quantity: 1 }],
  objects: [{ id: 11364, name: "Rocks", option: "Mine", distanceToPlayer: 2 }],
}), "mine 3 iron ore");
assert(mining.mode === "mining", "mining objective should create mining plan");
const miningAction = mining.steps.find((step) => step.tool === "perform_until");
assert(miningAction.arguments.actionOption === "Mine", "mining should use Mine option");
assert(miningAction.arguments.inventoryQuantityAtLeast === 4, "mining stop quantity should be current ore plus requested count");

const fishing = buildNextActionPlan(baseContext(), loggedInSnapshot({
  npcs: [{ id: 1530, name: "Fishing spot", option: "Net", distanceToPlayer: 1 }],
}), "fish 2 shrimp");
assert(fishing.mode === "fishing", "fishing objective should create fishing plan");
const fishingAction = fishing.steps.find((step) => step.tool === "perform_until");
assert(fishingAction.arguments.actionEntityType === "npc", "fishing should interact with NPC fishing spot");
assert(fishingAction.arguments.inventoryItemName === "Raw shrimps", "fishing should infer raw shrimp target item");

const combat = buildNextActionPlan(baseContext(), loggedInSnapshot({
  npcs: [{ id: 3106, name: "Man", option: "Attack", distanceToPlayer: 1, isDead: false }],
}), "attack man");
assert(combat.mode === "combat", "combat objective should create combat plan");
assert(toolNames(combat).includes("wait_until_idle"), "combat plan should wait for idle after attacking");

const woodcutPackage = buildAgentStepPackage({ status: "READY", readiness: { risks: [] } }, woodcutting, "chop 5 normal trees");
assert(woodcutPackage.willExecute === false, "agent step package must never execute");
assert(woodcutPackage.firstAction.tool === "perform_until", "woodcut package should identify first real action");
assert(woodcutPackage.verificationStep.tool === "mark_action_baseline" || woodcutPackage.verificationStep.tool === "verify_last_action", "woodcut package should expose verification guidance");
assert(woodcutPackage.safety.baselineRecommended === true, "woodcut package should recommend baseline");
assert(woodcutPackage.guidance.some((line) => line.includes("mark_action_baseline")), "woodcut guidance should mention baseline");

const lowHp = buildNextActionPlan(baseContext(), loggedInSnapshot({
  state: { status: "LOGGED_IN", health: 2 },
  skills: { Hitpoints: { level: 10 } },
  inventory: [{ id: 333, name: "Trout", slot: 0, quantity: 1 }],
}), "walk to Varrock");
assert(lowHp.steps[0].tool === "eat_food_when", "low hp with food should add food safety first");

const staleRuntime = buildNextActionPlan(baseContext("needs_reload"), loggedInSnapshot(), "look around");
assert(staleRuntime.steps[0].tool === "diagnose_runtime", "stale runtime should diagnose first");
const blockedPackage = buildAgentStepPackage({ status: "ATTENTION_NEEDED", readiness: { risks: ["runtime_not_current"] } }, staleRuntime, "look around");
assert(blockedPackage.status === "BLOCKED_BY_PREFLIGHT", "blocker priority should mark package blocked by preflight");
assert(blockedPackage.nextStep.tool === "diagnose_runtime", "blocked package should point to diagnose_runtime");

const step = actionStep("test_tool", "test reason", { ok: true }, { priority: "test" });
assert(step.tool === "test_tool" && step.priority === "test" && step.arguments.ok === true, "actionStep should preserve fields");

console.log(JSON.stringify({
  ok: true,
  cases: {
    notLoggedIn: notLoggedIn.mode,
    woodcutting: woodcutting.mode,
    dialogue: dialogue.mode,
    fullInventory: fullInventory.mode,
    bankDeposit: bankDeposit.mode,
    mining: mining.mode,
    fishing: fishing.mode,
    combat: combat.mode,
    woodcutPackageFirstAction: woodcutPackage.firstAction.tool,
    blockedPackageStatus: blockedPackage.status,
    lowHpFirstTool: lowHp.steps[0].tool,
    staleRuntimeFirstTool: staleRuntime.steps[0].tool,
  },
}, null, 2));
