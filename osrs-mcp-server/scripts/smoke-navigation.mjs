#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  calculateStraightLineSteps,
  chooseLocalPathStep,
  tileDistance,
  withStraightLineFallback,
} from "../build/navigation.js";
import {
  findTransportNode,
  nearestTransportNode,
  nextRouteWaypoint,
  planTransportRoute,
  transportGraphSummary,
} from "../build/transport-graph.js";

const from = { x: 3200, y: 3200, plane: 0 };
const plan = calculateStraightLineSteps(from, { worldX: 3245, worldY: 3210 }, 18, 2);

assert.equal(plan.distance, 45);
assert.equal(plan.stepsNeeded, 3);
assert.equal(plan.returnedSteps, 2);
assert.equal(plan.truncated, true);
assert.deepEqual(plan.steps[0], { worldX: 3215, worldY: 3203, plane: 0, final: false });
assert.deepEqual(plan.steps[1], { worldX: 3230, worldY: 3207, plane: 0, final: false });

const fallback = withStraightLineFallback(
  { state: { location: from } },
  { worldX: 3245, worldY: 3210 },
  18,
  1,
  { success: false, error: "TARGET_OUTSIDE_SCENE" },
);
assert.equal(fallback.fallbackUsed, true);
assert.equal(fallback.fallbackReason, "TARGET_OUTSIDE_SCENE");
assert.equal(fallback.steps.length, 1);

const localPath = {
  success: true,
  steps: Array.from({ length: 6 }, (_, index) => ({ worldX: 3200 + index, worldY: 3200, plane: 0, final: index === 5 })),
};
assert.deepEqual(chooseLocalPathStep(localPath, 3), { worldX: 3203, worldY: 3200, plane: 0, final: false });
assert.deepEqual(chooseLocalPathStep(localPath, 99), { worldX: 3205, worldY: 3200, plane: 0, final: true });

assert.equal(tileDistance({ x: 3200, y: 3200, plane: 0 }, 3205, 3198, 0), 5);
assert.equal(tileDistance({ x: 3200, y: 3200, plane: 1 }, 3205, 3198, 0), Number.MAX_SAFE_INTEGER);
assert.equal(tileDistance(null, 3205, 3198, 0), Number.MAX_SAFE_INTEGER);

const graph = transportGraphSummary();
assert(graph.nodeCount >= 20);
assert(graph.edgeCount >= 25);
assert.equal(findTransportNode("Varrock West Bank")?.id, "varrock_west_bank");
assert.equal(findTransportNode("ge")?.id, "grand_exchange");
assert.equal(findTransportNode("Falador East Bank")?.id, "falador_east_bank");
assert.equal(findTransportNode("Port Sarim")?.id, "port_sarim");
assert.equal(findTransportNode("edgeville")?.id, "edgeville_bank");
assert.equal(findTransportNode("Al Kharid Mine")?.id, "al_kharid_mine");
assert.equal(findTransportNode("Karamja Fishing")?.id, "karamja_fishing");
assert.equal(findTransportNode("Draynor Fishing")?.id, "draynor_fishing");
assert.equal(findTransportNode("Falador Mine")?.id, "falador_mine");
assert.equal(findTransportNode("Lumbridge Bank")?.id, "lumbridge_castle_bank");
assert.equal(findTransportNode("Lumbridge Castle Bank")?.plane, 2);
assert.equal(nearestTransportNode({ x: 3222, y: 3218, plane: 0 })?.id, "lumbridge_castle");

const route = planTransportRoute({ from: "Lumbridge Castle", to: "Varrock West Bank" });
assert.equal(route.status, "ROUTE_PLANNED");
assert.equal(route.steps.at(0)?.id, "lumbridge_castle");
assert.equal(route.steps.at(-1)?.id, "varrock_west_bank");
assert(route.totalCost > 0);
assert.equal(nextRouteWaypoint(route, { x: 3222, y: 3218, plane: 0 })?.id, route.steps[1].id);
assert.equal(nextRouteWaypoint(route, { x: 3185, y: 3436, plane: 0 })?.id, "varrock_west_bank");

const lumbridgeBankRoute = planTransportRoute({ from: "Lumbridge Castle", to: "Lumbridge Bank" });
assert.equal(lumbridgeBankRoute.status, "ROUTE_PLANNED");
assert.equal(lumbridgeBankRoute.steps.at(-1)?.id, "lumbridge_castle_bank");
assert.equal(lumbridgeBankRoute.finalTile?.plane, 2);
assert(lumbridgeBankRoute.steps.some((step) => step.edgeFromPrevious?.mode === "stairs"));
assert(lumbridgeBankRoute.steps.some((step) => step.edgeFromPrevious?.action?.includes("top-floor bank")));

const faladorRoute = planTransportRoute({ from: "Lumbridge Castle", to: "Falador East Bank" });
assert.equal(faladorRoute.status, "ROUTE_PLANNED");
assert.equal(faladorRoute.steps.at(-1)?.id, "falador_east_bank");
assert(faladorRoute.steps.length >= 2);

const rimmingtonRoute = planTransportRoute({ from: "Draynor Bank", to: "Rimmington" });
assert.equal(rimmingtonRoute.status, "ROUTE_PLANNED");
assert.equal(rimmingtonRoute.steps.at(-1)?.id, "rimmington");

const karamjaRoute = planTransportRoute({ from: "Port Sarim", to: "Karamja Fishing" });
assert.equal(karamjaRoute.status, "ROUTE_PLANNED");
assert.equal(karamjaRoute.steps.at(-1)?.id, "karamja_fishing");
assert(karamjaRoute.steps.some((step) => step.edgeFromPrevious?.mode === "ship"));
assert(karamjaRoute.steps.some((step) => step.edgeFromPrevious?.requirements?.some((requirement) => requirement.includes("30 gp"))));

const alKharidRoute = planTransportRoute({ from: "Lumbridge Castle", to: "Al Kharid Mine" });
assert.equal(alKharidRoute.status, "ROUTE_PLANNED");
assert.equal(alKharidRoute.steps.at(-1)?.id, "al_kharid_mine");

const lumbridgeSwampRoute = planTransportRoute({ from: "Lumbridge Castle", to: "Lumbridge Swamp Mine" });
assert.equal(lumbridgeSwampRoute.status, "ROUTE_PLANNED");
assert.equal(lumbridgeSwampRoute.steps.at(-1)?.id, "lumbridge_swamp_mine");
assert(lumbridgeSwampRoute.steps.some((step) => step.edgeFromPrevious?.risk === "medium"));

const unknownRoute = planTransportRoute({ from: "Lumbridge Castle", to: "Moon Base Bank" });
assert.equal(unknownRoute.status, "ROUTE_NOT_FOUND");
assert.equal(unknownRoute.stopReason, "Could not resolve destination node.");

console.log(JSON.stringify({
  ok: true,
  straightLineDistance: plan.distance,
  straightLineReturnedSteps: plan.returnedSteps,
  fallbackReason: fallback.fallbackReason,
  chosenWorldX: chooseLocalPathStep(localPath, 3).worldX,
  graphNodes: graph.nodeCount,
  routeCost: route.totalCost,
  lumbridgeBankRouteCost: lumbridgeBankRoute.totalCost,
  nextWaypoint: nextRouteWaypoint(route, { x: 3222, y: 3218, plane: 0 })?.id,
  faladorRouteCost: faladorRoute.totalCost,
  rimmingtonRouteCost: rimmingtonRoute.totalCost,
  karamjaRouteCost: karamjaRoute.totalCost,
  alKharidRouteCost: alKharidRoute.totalCost,
  lumbridgeSwampRouteCost: lumbridgeSwampRoute.totalCost,
  unknownRouteStatus: unknownRoute.status,
}, null, 2));
