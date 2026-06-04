#!/usr/bin/env node
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ReflexEngine } from "../build/engine/ReflexEngine.js";

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

console.log(JSON.stringify({
  ok: true,
  executedStepCount: executedSteps.length,
  lastStatus: status.activePolicy?.status,
  lastStopReason: status.activePolicy?.stopReason,
}, null, 2));
