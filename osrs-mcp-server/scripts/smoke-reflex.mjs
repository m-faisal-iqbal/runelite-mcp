#!/usr/bin/env node
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ReflexEngine, validateReflexPolicySafety } from "../build/engine/ReflexEngine.js";

const executedSteps = [];
let observation = {
  health: 99,
  healthPercent: 100,
  inventorySlotsUsed: 0,
  inventoryFull: false,
  inventory: [],
  visiblePlayers: [],
  bankOpen: false,
  location: { x: 3222, y: 3218, plane: 0 },
  isIdle: true,
};

const unsafePolicy = {
  steps: [
    {
      tool: "execute_agent_step",
      reason: "Old LLM-in-the-loop primitive must be rejected by System 1.",
    },
  ],
};
assert(validateReflexPolicySafety(unsafePolicy).length > 0);

const engine = new ReflexEngine({
  observe: async () => observation,
  runStep: async (step, policy, mode) => {
    const result = {
      status: mode === "execute" ? "EXECUTED_ONE_STEP" : "DRY_RUN_READY",
      willExecute: mode === "execute",
      executed: mode === "execute",
      step,
      validation: { valid: true },
      actionResult: { success: true, dryRun: mode !== "execute" },
    };
    executedSteps.push({ step, policyId: policy.id, mode });
    return result;
  },
}, { tickMs: 10000, maxTicks: 5 });

assert.throws(() => engine.loadPolicy(unsafePolicy, { start: false }), /forbidden raw action/i);

engine.loadPolicy({
  task: "chop_logs",
  itemName: "Logs",
  quantity: 5,
  method: "woodcutting",
  executionMode: "dry_run",
}, { start: true });
await engine.runSingleTick();
engine.stop("SMOKE_STEP_DONE");

assert.equal(executedSteps.at(-1)?.step.tool, "interact_with");
assert.equal(executedSteps.at(-1)?.step.arguments?.entityType, "object");
assert.equal(executedSteps.at(-1)?.step.arguments?.option, "Chop down");
assert.equal(executedSteps.at(-1)?.mode, "dry_run");

observation = {
  health: 99,
  healthPercent: 100,
  inventorySlotsUsed: 0,
  inventoryFull: false,
  inventory: [],
  visiblePlayers: [],
  bankOpen: false,
  location: { x: 3222, y: 3218, plane: 0 },
  isIdle: true,
};
const explicitStartIndex = executedSteps.length;
engine.loadPolicy({
  task: "explicit_two_step_smoke",
  executionMode: "dry_run",
  steps: [
    {
      preferredSystem1Capability: "interact",
      intent: "Talk to the banker.",
      inputs: { entityType: "npc", name: "Banker", option: "Bank", nearestToPlayer: true },
    },
    {
      tool: "deposit",
      reason: "Deposit logs after opening the bank.",
      arguments: { itemName: "Logs", quantity: "All" },
    },
  ],
}, { start: true });
await engine.runSingleTick();
assert.equal(engine.status().activePolicy?.status, "running");
assert.equal(engine.status().activePolicy?.stepIndex, 1);
await engine.runSingleTick();
const explicitStatus = engine.status();
engine.stop("SMOKE_EXPLICIT_STEPS_DONE");

const explicitSteps = executedSteps.slice(explicitStartIndex);
assert.equal(explicitSteps.length, 2);
assert.equal(explicitSteps[0].step.tool, "interact_with");
assert.equal(explicitSteps[1].step.tool, "deposit_inventory_item");
assert.equal(explicitStatus.activePolicy?.status, "completed");
assert.equal(explicitStatus.activePolicy?.stepIndex, 2);
assert.equal(explicitStatus.activePolicy?.stopReason, "POLICY_STEPS_COMPLETED");

const blockedExplicitEngine = new ReflexEngine({
  observe: async () => ({
    health: 99,
    healthPercent: 100,
    inventorySlotsUsed: 0,
    inventoryFull: false,
    inventory: [],
    visiblePlayers: [],
    bankOpen: false,
    location: { x: 3222, y: 3218, plane: 0 },
    isIdle: true,
  }),
  runStep: async (step) => ({
    status: "BLOCKED",
    willExecute: false,
    executed: false,
    step,
    validation: { valid: false },
    reason: "SIMULATED_STEP_BLOCKED",
    actionResult: { success: false, reason: "SIMULATED_STEP_BLOCKED" },
  }),
}, { tickMs: 10000, maxTicks: 5 });
blockedExplicitEngine.loadPolicy({
  task: "explicit_block_smoke",
  executionMode: "dry_run",
  steps: [{ tool: "interact_with", arguments: { entityType: "npc", name: "Banker", option: "Bank" } }],
}, { start: true });
await blockedExplicitEngine.runSingleTick();
const blockedExplicitStatus = blockedExplicitEngine.status();
blockedExplicitEngine.stop("SMOKE_EXPLICIT_BLOCK_DONE");

assert.equal(blockedExplicitStatus.activePolicy?.status, "blocked");
assert.equal(blockedExplicitStatus.activePolicy?.stepIndex, 0);
assert.equal(blockedExplicitStatus.activePolicy?.stopReason, "SIMULATED_STEP_BLOCKED");

observation = {
  health: 99,
  healthPercent: 100,
  inventorySlotsUsed: 0,
  inventoryFull: false,
  inventory: [],
  visiblePlayers: [],
  bankOpen: false,
  location: { x: 3182, y: 3377, plane: 0 },
  isIdle: true,
};
engine.loadPolicy({
  task: "mine_tin",
  itemName: "Tin ore",
  quantity: 1,
  method: "mining",
  executionMode: "dry_run",
}, { start: true });
await engine.runSingleTick();
engine.stop("SMOKE_MINING_STEP_DONE");

assert.equal(executedSteps.at(-1)?.step.tool, "interact_with");
assert.equal(executedSteps.at(-1)?.step.arguments?.entityType, "object");
assert.equal(executedSteps.at(-1)?.step.arguments?.name, "Tin rocks");
assert.equal(executedSteps.at(-1)?.step.arguments?.option, "Mine");
assert.equal(executedSteps.at(-1)?.mode, "dry_run");

observation = {
  health: 99,
  healthPercent: 100,
  inventorySlotsUsed: 1,
  inventoryFull: false,
  inventory: [{ id: 438, name: "Tin ore", slot: 0, quantity: 20 }],
  visiblePlayers: [],
  bankOpen: false,
  location: { x: 3182, y: 3377, plane: 0 },
  isIdle: true,
};
engine.loadPolicy({
  task: "mine_tin",
  itemName: "Tin ore",
  quantity: 2,
  quantityMode: "gain",
  method: "mining",
  executionMode: "execute",
}, { start: true });
await engine.runSingleTick();

assert.equal(engine.status().activePolicy?.status, "running");
assert.equal(engine.status().activePolicy?.startQuantity, 20);
assert.equal(engine.status().activePolicy?.targetQuantity, 22);
assert.equal(executedSteps.at(-1)?.step.arguments?.name, "Tin rocks");
assert.equal(executedSteps.at(-1)?.mode, "execute");

observation = {
  ...observation,
  inventorySlotsUsed: 2,
  inventory: [{ id: 438, name: "Tin ore", slot: 0, quantity: 22 }],
};
await engine.runSingleTick();
const gainStatus = engine.status();
engine.stop("SMOKE_MINING_GAIN_DONE");

assert.equal(gainStatus.activePolicy?.status, "completed");
assert.equal(gainStatus.activePolicy?.stopReason, "TARGET_QUANTITY_REACHED:Tin ore:22/22");

observation = {
  health: 3,
  healthPercent: 20,
  inventorySlotsUsed: 1,
  inventoryFull: false,
  inventory: [{ id: 315, name: "Shrimps", slot: 0, quantity: 1 }],
  visiblePlayers: [],
  bankOpen: false,
  location: { x: 3222, y: 3218, plane: 0 },
  isIdle: true,
};
engine.loadPolicy({
  task: "combat",
  targetName: "Chicken",
  eatAtHpPercent: 25,
  foodNames: ["Shrimps"],
  executionMode: "dry_run",
}, { start: true });
await engine.runSingleTick();
engine.stop("SMOKE_GUARD_DONE");

assert.equal(executedSteps.at(-1)?.step.tool, "eat_food_when");
assert.equal(executedSteps.at(-1)?.step.arguments?.hpBelowPercent, 25);

observation = {
  health: 99,
  healthPercent: 100,
  inventorySlotsUsed: 5,
  inventoryFull: false,
  inventory: [{ id: 1511, name: "Logs", slot: 0, quantity: 5 }],
  visiblePlayers: [],
  bankOpen: false,
  location: { x: 3222, y: 3218, plane: 0 },
  isIdle: true,
};
engine.loadPolicy({
  task: "chop_logs",
  itemName: "Logs",
  quantity: 5,
  executionMode: "dry_run",
}, { start: true });
await engine.runSingleTick();
await delay(5);
const status = engine.status();
engine.stop("SMOKE_COMPLETE_DONE");

assert.equal(status.activePolicy?.status, "completed");
assert.equal(status.activePolicy?.stopReason, "TARGET_QUANTITY_REACHED:Logs:5/5");
assert(status.historyCount >= 3);

observation = {
  health: 99,
  healthPercent: 100,
  inventorySlotsUsed: 28,
  inventoryFull: true,
  inventory: [{ id: 1511, name: "Logs", slot: 0, quantity: 28 }],
  visiblePlayers: [],
  bankOpen: false,
  location: { x: 3222, y: 3218, plane: 0 },
  isIdle: true,
};
engine.loadPolicy({
  task: "chop_logs",
  itemName: "Logs",
  quantity: 100,
  inventoryFullBehavior: "drop",
  executionMode: "dry_run",
}, { start: true });
await engine.runSingleTick();
engine.stop("SMOKE_DROP_DONE");

assert.equal(executedSteps.at(-1)?.step.tool, "drop_inventory_item");
assert.equal(executedSteps.at(-1)?.step.arguments?.name, "Logs");

observation = {
  health: 99,
  healthPercent: 100,
  inventorySlotsUsed: 28,
  inventoryFull: true,
  inventory: [{ id: 1511, name: "Logs", slot: 0, quantity: 28 }],
  visiblePlayers: [],
  bankOpen: true,
  location: { x: 3222, y: 3218, plane: 0 },
  isIdle: true,
};
engine.loadPolicy({
  task: "chop_logs",
  itemName: "Logs",
  quantity: 100,
  inventoryFullBehavior: "bank",
  executionMode: "dry_run",
}, { start: true });
await engine.runSingleTick();
engine.stop("SMOKE_BANK_DONE");

assert.equal(executedSteps.at(-1)?.step.tool, "deposit_inventory_item");
assert.equal(executedSteps.at(-1)?.step.arguments?.itemName, "Logs");
assert.equal(executedSteps.at(-1)?.step.arguments?.quantity, "All");

observation = {
  health: 99,
  healthPercent: 100,
  inventorySlotsUsed: 0,
  inventoryFull: false,
  inventory: [],
  visiblePlayers: [],
  bankOpen: false,
  location: { x: 3222, y: 3218, plane: 0 },
  isIdle: true,
};
engine.loadPolicy({
  task: "open_bank",
  bankAction: "open",
  targetName: "Bank booth",
  targetType: "object",
  actionOption: "Bank",
  executionMode: "dry_run",
}, { start: true });
await engine.runSingleTick();
engine.stop("SMOKE_OPEN_BANK_DONE");

assert.equal(executedSteps.at(-1)?.step.tool, "interact_with");
assert.equal(executedSteps.at(-1)?.step.arguments?.entityType, "object");
assert.equal(executedSteps.at(-1)?.step.arguments?.name, "Bank booth");
assert.equal(executedSteps.at(-1)?.step.arguments?.option, "Bank");

observation = {
  health: 99,
  healthPercent: 100,
  inventorySlotsUsed: 10,
  inventoryFull: false,
  inventory: [{ id: 1511, name: "Logs", slot: 0, quantity: 10 }],
  visiblePlayers: [],
  bankOpen: false,
  location: { x: 3222, y: 3218, plane: 0 },
  isIdle: true,
};
engine.loadPolicy({
  task: "deposit_logs",
  bankAction: "deposit",
  itemName: "Logs",
  bankQuantity: "All",
  executionMode: "dry_run",
}, { start: true });
await engine.runSingleTick();
engine.stop("SMOKE_DEPOSIT_CLOSED_BANK_DONE");

assert.equal(executedSteps.at(-1)?.step.tool, "interact_with");
assert.equal(executedSteps.at(-1)?.step.arguments?.entityType, "npc");
assert.equal(executedSteps.at(-1)?.step.arguments?.name, "Banker");
assert.equal(executedSteps.at(-1)?.step.arguments?.option, "Bank");

observation = {
  ...observation,
  bankOpen: true,
};
engine.loadPolicy({
  task: "deposit_logs",
  bankAction: "deposit",
  itemName: "Logs",
  bankQuantity: "All",
  executionMode: "dry_run",
}, { start: true });
await engine.runSingleTick();
engine.stop("SMOKE_DEPOSIT_OPEN_BANK_DONE");

assert.equal(executedSteps.at(-1)?.step.tool, "deposit_inventory_item");
assert.equal(executedSteps.at(-1)?.step.arguments?.itemName, "Logs");
assert.equal(executedSteps.at(-1)?.step.arguments?.quantity, "All");

observation = {
  health: 99,
  healthPercent: 100,
  inventorySlotsUsed: 0,
  inventoryFull: false,
  inventory: [],
  visiblePlayers: [],
  bankOpen: true,
  location: { x: 3222, y: 3218, plane: 0 },
  isIdle: true,
};
engine.loadPolicy({
  task: "withdraw_coins",
  bankAction: "withdraw",
  itemName: "Coins",
  bankQuantity: 5,
  executionMode: "dry_run",
}, { start: true });
await engine.runSingleTick();
engine.stop("SMOKE_WITHDRAW_OPEN_BANK_DONE");

assert.equal(executedSteps.at(-1)?.step.tool, "withdraw_bank_item");
assert.equal(executedSteps.at(-1)?.step.arguments?.itemName, "Coins");
assert.equal(executedSteps.at(-1)?.step.arguments?.quantity, 5);

observation = {
  health: 99,
  healthPercent: 100,
  inventorySlotsUsed: 0,
  inventoryFull: false,
  inventory: [],
  visiblePlayers: [],
  bankOpen: false,
  location: { x: 3222, y: 3218, plane: 0 },
  isIdle: true,
};
engine.loadPolicy({
  task: "loot_bones",
  objective: "Take bones from the ground after combat.",
  itemName: "Bones",
  executionMode: "dry_run",
}, { start: true });
await engine.runSingleTick();
engine.stop("SMOKE_LOOT_GROUND_ITEM_DONE");

assert.equal(executedSteps.at(-1)?.step.tool, "interact_with");
assert.equal(executedSteps.at(-1)?.step.arguments?.entityType, "ground_item");
assert.equal(executedSteps.at(-1)?.step.arguments?.name, "Bones");
assert.equal(executedSteps.at(-1)?.step.arguments?.option, "Take");

const threatSteps = [];
let threatObservation = {
  health: 99,
  healthPercent: 100,
  inventorySlotsUsed: 0,
  inventoryFull: false,
  inventory: [],
  visiblePlayers: [],
  minimapPlayerThreat: true,
  minimapThreat: { visiblePlayerThreat: true, visiblePlayerCount: 1 },
  bankOpen: false,
  location: { x: 3222, y: 3218, plane: 0 },
  isIdle: true,
};
const threatEngine = new ReflexEngine({
  observe: async () => threatObservation,
  runStep: async (step, policy, mode) => {
    threatSteps.push({ step, policyId: policy.id, mode });
    return {
      status: "DRY_RUN_READY",
      willExecute: false,
      executed: false,
      step,
      validation: { valid: true },
      actionResult: { success: true, dryRun: true },
    };
  },
}, { tickMs: 10000, maxTicks: 5 });
threatEngine.loadPolicy({
  task: "chop_logs",
  itemName: "Logs",
  quantity: 1,
  stopOnMinimapPlayerThreat: true,
  executionMode: "dry_run",
}, { start: true });
await threatEngine.runSingleTick();
const threatStatus = threatEngine.status();
threatEngine.stop("SMOKE_MINIMAP_THREAT_DONE");

assert.equal(threatStatus.activePolicy?.status, "blocked");
assert.equal(threatStatus.activePolicy?.stopReason, "MINIMAP_PLAYER_THREAT_DETECTED");
assert.equal(threatSteps.length, 0);

const visibleThreatSteps = [];
const visibleThreatEngine = new ReflexEngine({
  observe: async () => ({
    health: 99,
    healthPercent: 100,
    inventorySlotsUsed: 0,
    inventoryFull: false,
    inventory: [],
    visiblePlayers: [{ name: "Nearby player", id: 1 }],
    bankOpen: false,
    location: { x: 3222, y: 3218, plane: 0 },
    isIdle: true,
  }),
  runStep: async (step, policy, mode) => {
    visibleThreatSteps.push({ step, policyId: policy.id, mode });
    return {
      status: "DRY_RUN_READY",
      willExecute: false,
      executed: false,
      step,
      validation: { valid: true },
      actionResult: { success: true, dryRun: true },
    };
  },
}, { tickMs: 10000, maxTicks: 5 });
visibleThreatEngine.loadPolicy({
  task: "chop_logs",
  itemName: "Logs",
  quantity: 1,
  stopOnVisiblePlayers: true,
  executionMode: "dry_run",
}, { start: true });
await visibleThreatEngine.runSingleTick();
const visibleThreatStatus = visibleThreatEngine.status();
visibleThreatEngine.stop("SMOKE_VISIBLE_THREAT_DONE");

assert.equal(visibleThreatStatus.activePolicy?.status, "blocked");
assert.equal(visibleThreatStatus.activePolicy?.stopReason, "VISIBLE_PLAYER_THREAT_DETECTED");
assert.equal(visibleThreatSteps.length, 0);

const outcomes = [];
const outcomeEngine = new ReflexEngine({
  observe: async () => ({
    health: 99,
    healthPercent: 100,
    inventorySlotsUsed: 5,
    inventoryFull: false,
    inventory: [{ id: 1511, name: "Logs", slot: 0, quantity: 5 }],
    visiblePlayers: [],
    bankOpen: false,
    location: { x: 3222, y: 3218, plane: 0 },
    isIdle: true,
  }),
  runStep: async (step) => ({
    status: "DRY_RUN_READY",
    willExecute: false,
    executed: false,
    step,
    validation: { valid: true },
    actionResult: { success: true, dryRun: true },
  }),
  onPolicyOutcome: async (policy, outcome) => {
    outcomes.push({ policyId: policy.id, task: policy.task, ...outcome });
  },
}, { tickMs: 10000, maxTicks: 5 });
outcomeEngine.loadPolicy({
  task: "chop_logs",
  itemName: "Logs",
  quantity: 5,
  executionMode: "dry_run",
}, { start: true });
await outcomeEngine.runSingleTick();
outcomeEngine.stop("SMOKE_OUTCOME_DONE");

assert.equal(outcomes.length, 1);
assert.equal(outcomes[0].status, "completed");
assert.equal(outcomes[0].success, true);
assert.equal(outcomes[0].reason, "TARGET_QUANTITY_REACHED:Logs:5/5");

observation = {
  health: 99,
  healthPercent: 100,
  inventorySlotsUsed: 0,
  inventoryFull: false,
  inventory: [],
  visiblePlayers: [],
  bankOpen: false,
  location: { x: 3222, y: 3218, plane: 0 },
  isIdle: true,
};
engine.loadPolicy({
  task: "travel",
  destination: "Draynor Bank",
  from: "Lumbridge Castle",
  executionMode: "dry_run",
}, { start: true });
await engine.runSingleTick();
engine.stop("SMOKE_TRAVEL_DONE");

assert.equal(executedSteps.at(-1)?.step.tool, "navigate_to");
assert.equal(executedSteps.at(-1)?.step.arguments?.destination, "Draynor Bank");
assert.equal(executedSteps.at(-1)?.step.arguments?.from, "Lumbridge Castle");

const tickSyncedSteps = [];
let tickReadIndex = 0;
const tickSequence = [100, 100, 101, 101];
const tickSyncedEngine = new ReflexEngine({
  observe: async () => ({
    health: 99,
    healthPercent: 100,
    inventorySlotsUsed: 0,
    inventoryFull: false,
    inventory: [],
    visiblePlayers: [],
    bankOpen: false,
    location: { x: 3222, y: 3218, plane: 0 },
    isIdle: true,
  }),
  readGameTick: async () => tickSequence[Math.min(tickReadIndex++, tickSequence.length - 1)],
  runStep: async (step, policy, mode) => {
    tickSyncedSteps.push({ step, policyId: policy.id, mode, lastProcessedGameTick: policy.lastProcessedGameTick });
    return {
      status: "DRY_RUN_READY",
      willExecute: false,
      executed: false,
      step,
      validation: { valid: true },
      actionResult: { success: true, dryRun: true },
    };
  },
}, { tickMs: 600, maxTicks: 5 });
tickSyncedEngine.loadPolicy({
  task: "travel",
  destination: "Draynor Bank",
  from: "Lumbridge Castle",
  executionMode: "dry_run",
  tickPollMs: 1,
  tickStallMs: 150,
}, { start: true });
const tickSyncDeadline = Date.now() + 1000;
while (tickSyncedSteps.length === 0 && Date.now() < tickSyncDeadline) {
  await delay(5);
}
const tickSyncedStatus = tickSyncedEngine.status();
tickSyncedEngine.stop("SMOKE_TICK_SYNC_DONE");

assert.equal(tickSyncedSteps.length, 1);
assert.equal(tickSyncedSteps[0].lastProcessedGameTick, 101);
assert.equal(tickSyncedStatus.activePolicy?.lastProcessedGameTick, 101);
assert(tickSyncedStatus.lastEvents.some((event) => event.type === "tick_observed"));

const stalledSteps = [];
const stalledEngine = new ReflexEngine({
  observe: async () => {
    throw new Error("A stalled tick must pause before observation.");
  },
  readGameTick: async () => 500,
  runStep: async (step) => {
    stalledSteps.push(step);
    return {
      status: "DRY_RUN_READY",
      willExecute: false,
      executed: false,
      step,
      validation: { valid: true },
      actionResult: { success: true, dryRun: true },
    };
  },
}, { tickMs: 600, maxTicks: 5 });
stalledEngine.loadPolicy({
  task: "travel",
  destination: "Draynor Bank",
  executionMode: "dry_run",
  tickPollMs: 5,
  tickStallMs: 30,
}, { start: true });
const tickStallDeadline = Date.now() + 1000;
while (stalledEngine.status().activePolicy?.status === "running" && Date.now() < tickStallDeadline) {
  await delay(5);
}
const stalledStatus = stalledEngine.status();
stalledEngine.stop("SMOKE_TICK_STALL_DONE");

assert.equal(stalledStatus.activePolicy?.status, "paused");
assert.equal(stalledStatus.activePolicy?.stopReason, "TICK_STALLED");
assert.equal(stalledSteps.length, 0);
assert(stalledStatus.lastEvents.some((event) => event.type === "tick_stalled"));

console.log(JSON.stringify({
  ok: true,
  executedStepCount: executedSteps.length,
  lastStatus: status.activePolicy?.status,
  lastStopReason: status.activePolicy?.stopReason,
  tickSyncReads: tickReadIndex,
  tickSyncStepCount: tickSyncedSteps.length,
  tickStallStatus: stalledStatus.activePolicy?.status,
}, null, 2));
