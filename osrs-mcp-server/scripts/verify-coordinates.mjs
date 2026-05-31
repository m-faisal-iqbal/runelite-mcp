#!/usr/bin/env node
import axios from "axios";
import { mouse, Point } from "@nut-tree-fork/nut-js";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) {
    continue;
  }

  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) {
    args.set(key, "true");
  } else {
    args.set(key, next);
    i += 1;
  }
}

const port = Number(args.get("port") ?? process.env.OSRS_VERIFY_PORT ?? 8081);
const baseUrl = args.get("api") ?? `http://localhost:${port}/api`;
const type = String(args.get("type") ?? "npc").toLowerCase();
const name = args.get("name");
const id = args.has("id") ? Number(args.get("id")) : undefined;
const source = args.get("source");
const maxAgeMs = Number(args.get("max-age-ms") ?? 1500);
const hover = args.get("hover") === "true";
const retries = Number(args.get("retries") ?? 3);

function collectionFor(snapshot) {
  switch (type) {
    case "npc":
    case "npcs":
      return snapshot.npcs ?? [];
    case "object":
    case "objects":
      return snapshot.objects ?? [];
    case "ground_item":
    case "grounditem":
    case "grounditems":
    case "item":
      return snapshot.groundItems ?? [];
    case "player":
    case "players":
      return snapshot.players ?? [];
    default:
      throw new Error(`Unsupported --type ${type}`);
  }
}

function matches(target) {
  if (id !== undefined && target.id !== id) {
    return false;
  }
  if (name && String(target.name ?? "").toLowerCase() !== name.toLowerCase()) {
    return false;
  }
  if (source && target.coordinateSource !== source) {
    return false;
  }
  return true;
}

function distance(target) {
  return target.distanceToPlayer ?? Number.MAX_SAFE_INTEGER;
}

function targetIsReady(target) {
  return target &&
    Number.isFinite(target.screenX) &&
    Number.isFinite(target.screenY) &&
    !target.coordinateWarning &&
    (target.ageMs === undefined || target.ageMs <= maxAgeMs);
}

async function readJson(path) {
  const response = await axios.get(`${baseUrl}${path}`, { timeout: 5000 });
  return response.data;
}

async function findFreshTarget() {
  let lastTarget;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const snapshot = await readJson("/snapshot");
    const candidates = collectionFor(snapshot)
      .filter(matches)
      .sort((a, b) => distance(a) - distance(b));
    const target = candidates.find((candidate) =>
      Number.isFinite(candidate.screenX) && Number.isFinite(candidate.screenY)
    );
    lastTarget = target ?? candidates[0];
    if (targetIsReady(target)) {
      return { snapshot, target, attempt };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`No fresh click-ready target found. Last candidate: ${JSON.stringify(lastTarget, null, 2)}`);
}

const identity = await readJson("/identity");
const debugBefore = await readJson("/debug/coordinates");
const { snapshot, target, attempt } = await findFreshTarget();

const result = {
  baseUrl,
  hovered: false,
  attempt,
  identity: {
    instanceId: identity.instanceId,
    playerName: identity.playerName,
    port: identity.port,
    apiVersion: identity.apiVersion,
    supportsConcurrentStreams: identity.supportsConcurrentStreams,
    canvasShowing: identity.canvasShowing,
    windowMinimized: identity.windowMinimized,
    canvasBounds: identity.canvasBounds,
  },
  coordinateContract: debugBefore.coordinateContract,
  screenCoordinateFormula: debugBefore.screenCoordinateFormula,
  dpi: {
    defaultTransformScaleX: debugBefore.defaultTransformScaleX,
    defaultTransformScaleY: debugBefore.defaultTransformScaleY,
    normalizingTransformScaleX: debugBefore.normalizingTransformScaleX,
    normalizingTransformScaleY: debugBefore.normalizingTransformScaleY,
    toolkitScreenResolutionDpi: debugBefore.toolkitScreenResolutionDpi,
  },
  snapshot: {
    tick: snapshot.tick,
    clientTick: snapshot.clientTick,
    capturedAt: snapshot.capturedAt,
    ageMs: snapshot.ageMs,
    player: snapshot.state?.location,
  },
  target: {
    id: target.id,
    name: target.name,
    coordinateSource: target.coordinateSource,
    screenX: target.screenX,
    screenY: target.screenY,
    canvasX: target.canvasX,
    canvasY: target.canvasY,
    rawCanvasX: target.rawCanvasX,
    rawCanvasY: target.rawCanvasY,
    canvasOriginX: target.canvasOriginX,
    canvasOriginY: target.canvasOriginY,
    ageMs: target.ageMs,
    distanceToPlayer: target.distanceToPlayer,
    clickboxBounds: target.clickboxBounds,
    worldX: target.worldX,
    worldY: target.worldY,
    plane: target.plane,
  },
};

if (hover) {
  await mouse.setPosition(new Point(target.screenX, target.screenY));
  const debugAfter = await readJson("/debug/coordinates");
  result.hovered = true;
  result.mouseAfterHover = {
    awtMouseX: debugAfter.awtMouseX,
    awtMouseY: debugAfter.awtMouseY,
    expectedScreenX: target.screenX,
    expectedScreenY: target.screenY,
    deltaX: Number.isFinite(debugAfter.awtMouseX) ? debugAfter.awtMouseX - target.screenX : null,
    deltaY: Number.isFinite(debugAfter.awtMouseY) ? debugAfter.awtMouseY - target.screenY : null,
  };
}

console.log(JSON.stringify(result, null, 2));
