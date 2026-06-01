#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  calculateStraightLineSteps,
  chooseLocalPathStep,
  tileDistance,
  withStraightLineFallback,
} from "../build/navigation.js";

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

console.log(JSON.stringify({
  ok: true,
  straightLineDistance: plan.distance,
  straightLineReturnedSteps: plan.returnedSteps,
  fallbackReason: fallback.fallbackReason,
  chosenWorldX: chooseLocalPathStep(localPath, 3).worldX,
}, null, 2));
