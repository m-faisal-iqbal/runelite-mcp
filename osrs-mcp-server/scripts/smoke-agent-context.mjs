#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildAgentContext } from "../build/agent-context.js";

const baseSnapshot = {
  state: {
    status: "LOGGED_IN",
    name: "agent-test",
    health: 30,
    runEnergy: 75,
    animation: -1,
    isIdle: true,
    location: { worldX: 3200, worldY: 3200, plane: 0 },
    world: 430,
  },
  skills: {
    Hitpoints: { level: 40 },
  },
  inventory: [
    { slot: 0, id: 1511, name: "Logs", quantity: 1 },
    { slot: 1, id: 315, name: "Shrimps", quantity: 1 },
  ],
  objects: [
    { id: 1276, name: "Tree", option: "Chop down", worldX: 3201, worldY: 3200, distanceToPlayer: 1, screenX: 500, screenY: 400, coordinateSource: "clickbox" },
  ],
  npcs: [],
  groundItems: [],
  players: [],
  dialogue: { type: "NONE", options: [] },
  interfaceSummary: { dialogueType: "NONE", contextMenuOpen: false, bankContainerAvailable: false },
  chat: { messages: [{ text: "You swing your axe.", type: "GAMEMESSAGE", capturedAt: Date.now() }] },
};

const ready = buildAgentContext(
  "http://localhost:8080/api",
  { instanceId: "test", port: 8080, apiVersion: 3, windowActive: true, canvasShowing: true, world: 430 },
  baseSnapshot,
  { status: "ok" },
  {
    objective: "chop 5 normal trees",
    streamStatus: { cached: true },
    pathfindingStatus: {
      provider: "runelite_collision_map",
      supportsLocalPathfinding: true,
      supportsGlobalPathfinding: false,
      scope: "loaded_scene",
    },
  },
);

assert.equal(ready.status, "READY");
assert.equal(ready.readiness.loggedIn, true);
assert.equal(ready.readiness.canUseInClientActions, true);
assert.equal(ready.player.idle, true);
assert.equal(ready.inventory.slotsUsed, 2);
assert.equal(ready.nearby.objects[0].clickable, true);
assert.equal(ready.stream.cached, true);
assert.equal(ready.navigation.pathfinding.provider, "runelite_collision_map");
assert.equal(ready.navigation.pathfinding.supportsGlobalPathfinding, false);
assert(ready.readiness.recommendedNext.some((note) => note.includes("loaded-scene pathfinding only")));

const blocked = buildAgentContext(
  "http://localhost:8080/api",
  { instanceId: "test", port: 8080, apiVersion: 2, windowActive: false, canvasShowing: true },
  {
    ...baseSnapshot,
    state: { ...baseSnapshot.state, status: "LOGIN_SCREEN", health: 3 },
    interfaceSummary: { dialogueType: "NPC", contextMenuOpen: false, bankContainerAvailable: false },
    dialogue: { type: "NPC", text: "<col=0000ff>Hello</col>", options: [] },
  },
  { status: "needs_reload" },
  {
    objective: "talk to npc",
    pathfindingStatus: {
      supportsLocalPathfinding: false,
      supportsGlobalPathfinding: false,
    },
  },
);

assert.equal(blocked.status, "ATTENTION_NEEDED");
assert(blocked.readiness.risks.includes("runtime_not_current"));
assert(blocked.readiness.risks.includes("not_logged_in"));
assert(blocked.readiness.risks.includes("low_hitpoints"));
assert(blocked.readiness.risks.includes("interface_or_dialogue_open"));
assert(blocked.readiness.risks.includes("pathfinding_unavailable"));
assert.equal(blocked.interface.dialogueText, "Hello");

console.log(JSON.stringify({
  ok: true,
  readyStatus: ready.status,
  blockedStatus: blocked.status,
  readyRiskCount: ready.readiness.risks.length,
  blockedRiskCount: blocked.readiness.risks.length,
}, null, 2));
