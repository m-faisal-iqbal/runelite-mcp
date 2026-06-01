import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import { readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mouse, Point, keyboard, Key, screen, Region, FileType } from "@nut-tree-fork/nut-js";
import { apiBaseFromPort, StateCache, type ClientTarget, type LocalPathResult, type PathStep, type RuneLiteSnapshot, type RuneLiteTarget } from "./client.js";
import { actionStep, buildAgentStepPackage, buildNextActionPlan } from "./planner.js";
import { buildAgentContext } from "./agent-context.js";

type ActionBaseline = {
  baseURL: string;
  capturedAt: number;
  note?: string;
  snapshot: RuneLiteSnapshot;
};

const configuredMouseSpeed = Number(process.env.OSRS_MOUSE_SPEED ?? "300");
mouse.config.mouseSpeed = Number.isFinite(configuredMouseSpeed) && configuredMouseSpeed > 0
  ? configuredMouseSpeed
  : 300;
const HUMANIZE_MOUSE = !["0", "false", "no"].includes(String(process.env.OSRS_HUMANIZE_MOUSE ?? "true").toLowerCase());
const MOUSE_MIN_DELAY_MS = Math.max(0, Number(process.env.OSRS_MOUSE_MIN_DELAY_MS ?? "80") || 80);
const MOUSE_MAX_DELAY_MS = Math.max(MOUSE_MIN_DELAY_MS, Number(process.env.OSRS_MOUSE_MAX_DELAY_MS ?? "240") || 240);

const server = new McpServer({
  name: "osrs-mcp-server",
  version: "1.0.0",
});

const RUNELITE_API = process.env.OSRS_RUNELITE_API ?? "http://localhost:8080/api";
let selectedRuneliteApi = RUNELITE_API;
let selectedClientInstanceId: string | undefined;
const configuredApiTimeoutMs = Number(process.env.OSRS_API_TIMEOUT_MS ?? "3000");
const API_TIMEOUT_MS = Number.isFinite(configuredApiTimeoutMs) && configuredApiTimeoutMs > 0
  ? configuredApiTimeoutMs
  : 3000;
const configuredSnapshotCacheTtlMs = Number(process.env.OSRS_SNAPSHOT_CACHE_TTL_MS ?? "250");
const SNAPSHOT_CACHE_TTL_MS = Number.isFinite(configuredSnapshotCacheTtlMs) && configuredSnapshotCacheTtlMs >= 0
  ? configuredSnapshotCacheTtlMs
  : 250;
const stateCache = new StateCache(SNAPSHOT_CACHE_TTL_MS, API_TIMEOUT_MS, async (baseURL) => {
  return (await runeliteApi(baseURL).get("/snapshot")).data as RuneLiteSnapshot;
});
const actionBaselines = new Map<string, ActionBaseline>();
const EXPECTED_PLUGIN_API_VERSION = 3;
const EXPECTED_PLUGIN_ENDPOINTS = [
  "/api/action/menu",
  "/api/action/walk",
  "/api/action/widget",
  "/api/state",
  "/api/snapshot",
  "/api/stream",
  "/api/events",
  "/api/path",
  "/api/widgets",
  "/api/identity",
];
const EXPECTED_IDENTITY_FLAGS = [
  "supportsConcurrentStreams",
  "supportsEventBuffer",
  "supportsInClientActions",
  "supportsLocalPathfinding",
  "supportsWidgetInspector",
];

function runeliteApi(baseURL = selectedRuneliteApi) {
  return axios.create({
    baseURL,
    timeout: API_TIMEOUT_MS,
  });
}

function errorText(action: string, e: any): string {
  const status = e?.response?.status ? ` HTTP ${e.response.status}` : "";
  const responseData = e?.response?.data ? ` ${JSON.stringify(e.response.data)}` : "";
  return `Error ${action}:${status} ${e?.message ?? String(e)}${responseData}`;
}

function runeliteApiForPort(port?: number) {
  return runeliteApi(port === undefined ? selectedRuneliteApi : apiBaseFromPort(port));
}

function startSnapshotStream(baseURL: string) {
  stateCache.startStream(baseURL);
}

function snapshotStreamStatus(baseURL: string) {
  return stateCache.status(baseURL);
}

async function ensureSnapshotStreamSupported(baseURL: string): Promise<boolean> {
  return stateCache.ensureStreamSupported(baseURL);
}

async function getSnapshotForBase(baseURL: string, force = false): Promise<RuneLiteSnapshot> {
  return stateCache.get(baseURL, force);
}

async function discoverClients() {
  const ports = Array.from({ length: 11 }, (_, index) => 8080 + index);
  const results = await Promise.all(ports.map(async (port) => {
    try {
      const baseURL = apiBaseFromPort(port);
      const res = await axios.get(`${baseURL}/identity`, { timeout: Math.min(API_TIMEOUT_MS, 2000) });
      return { ...res.data, baseUrl: baseURL };
    } catch {
      // Ignore closed ports during discovery.
      return null;
    }
  }));
  return results.filter(Boolean);
}

function selectDiscoveredClient(clients: any[], target: ClientTarget = {}) {
  const matches = clients.filter((client: any) =>
    (target.port !== undefined && client.port === target.port) ||
    (target.instanceId && client.instanceId === target.instanceId) ||
    (target.playerName && String(client.playerName ?? "").toLowerCase() === target.playerName.toLowerCase())
  );

  if (target.port !== undefined || target.instanceId || target.playerName) {
    return matches[0];
  }

  return clients.find((candidate: any) =>
    candidate.baseUrl === selectedRuneliteApi ||
    candidate.instanceId === selectedClientInstanceId
  ) ?? (clients.length === 1 ? clients[0] : undefined);
}

async function diagnoseClientRuntime(client: any) {
  const baseURL = client.baseUrl ?? apiBaseFromPort(client.port);
  const report: any = {
    baseURL,
    port: client.port,
    instanceId: client.instanceId,
    playerName: client.playerName,
    apiVersion: client.apiVersion,
    expectedApiVersion: EXPECTED_PLUGIN_API_VERSION,
    loggedInPlayer: client.playerName ?? null,
    status: "ok",
    warnings: [] as string[],
    missingIdentityFlags: [] as string[],
    missingEndpoints: [] as string[],
    staleRuntime: false,
  };

  if ((client.apiVersion ?? 0) < EXPECTED_PLUGIN_API_VERSION) {
    report.staleRuntime = true;
    report.warnings.push(`Plugin API version ${client.apiVersion ?? "unknown"} is older than expected ${EXPECTED_PLUGIN_API_VERSION}. Rebuild/install is done, but RuneLite must reload the plugin to expose the newest endpoints.`);
  }

  for (const flag of EXPECTED_IDENTITY_FLAGS) {
    if (client[flag] !== true) {
      report.missingIdentityFlags.push(flag);
    }
  }

  try {
    const apiIndex = (await runeliteApi(baseURL).get("")).data;
    const endpointPaths = new Set((apiIndex?.endpoints ?? []).map((endpoint: any) => String(endpoint.path ?? "").split("?")[0]));
    report.endpointCount = endpointPaths.size;
    report.missingEndpoints = EXPECTED_PLUGIN_ENDPOINTS.filter((endpoint) => !endpointPaths.has(endpoint));
  } catch (error: any) {
    report.warnings.push(errorText("fetching API endpoint index", error));
  }

  if (report.missingIdentityFlags.length > 0 || report.missingEndpoints.length > 0) {
    report.staleRuntime = true;
    report.status = "needs_reload";
    if (report.missingEndpoints.length > 0) {
      report.warnings.push(`Missing endpoints: ${report.missingEndpoints.join(", ")}`);
    }
    if (report.missingIdentityFlags.length > 0) {
      report.warnings.push(`Missing identity flags: ${report.missingIdentityFlags.join(", ")}`);
    }
  }

  return report;
}

async function resolveRuneliteApi(target: ClientTarget = {}) {
  if (target.port !== undefined) {
    return apiBaseFromPort(target.port);
  }

  const needsDiscovery = Boolean(target.instanceId || target.playerName || selectedClientInstanceId);
  if (!needsDiscovery) {
    const clients = await discoverClients();
    if (clients.length === 1) {
      selectedRuneliteApi = clients[0].baseUrl;
      selectedClientInstanceId = clients[0].instanceId;
      return selectedRuneliteApi;
    }
    if (clients.length > 1) {
      throw new Error(`Multiple RuneLite clients are active. Use list_clients/select_client or pass port/instanceId/playerName. Clients: ${JSON.stringify(clients)}`);
    }
    return selectedRuneliteApi;
  }

  const clients = await discoverClients();
  const matches = clients.filter((client: any) =>
    (target.instanceId && client.instanceId === target.instanceId) ||
    (target.playerName && String(client.playerName ?? "").toLowerCase() === target.playerName.toLowerCase()) ||
    (!target.instanceId && !target.playerName && selectedClientInstanceId && client.instanceId === selectedClientInstanceId)
  );

  if (matches.length !== 1) {
    throw new Error(`Expected exactly one matching RuneLite client, found ${matches.length}. Clients: ${JSON.stringify(clients)}`);
  }

  selectedRuneliteApi = matches[0].baseUrl;
  selectedClientInstanceId = matches[0].instanceId;
  return selectedRuneliteApi;
}

async function apiForTarget(target: ClientTarget = {}) {
  return runeliteApi(await resolveRuneliteApi(target));
}

async function getSnapshotForTarget(target: ClientTarget = {}, force = false) {
  const baseURL = await resolveRuneliteApi(target);
  return {
    baseURL,
    snapshot: await getSnapshotForBase(baseURL, force),
  };
}

async function assertClientReady(baseURL: string) {
  const identity = (await runeliteApi(baseURL).get("/identity")).data;
  if (identity?.windowMinimized) {
    throw new Error(`RuneLite client ${identity.instanceId ?? baseURL} is minimized`);
  }
  if (identity?.canvasShowing === false) {
    throw new Error(`RuneLite client ${identity.instanceId ?? baseURL} canvas is not visible`);
  }
  if (identity?.windowActive === false) {
    throw new Error(`RuneLite client ${identity.instanceId ?? baseURL} window is not active; focus RuneLite before OS click tools`);
  }
  await assertClientLoggedIn(baseURL, identity);
  return identity;
}

async function assertClientLoggedIn(baseURL: string, identity?: any) {
  const clientIdentity = identity ?? (await runeliteApi(baseURL).get("/identity")).data;
  const state = await readClientState(baseURL);
  if (state?.status !== "LOGGED_IN") {
    throw new Error(`RuneLite client ${clientIdentity?.instanceId ?? baseURL} is not logged in; refusing gameplay action while status is ${state?.status ?? "UNKNOWN"}`);
  }
  return { identity: clientIdentity, state };
}

function targetMatches(entity: any, name?: string, id?: number) {
  if (id !== undefined && entity.id !== id) {
    return false;
  }
  if (name && String(entity.name ?? "").toLowerCase() !== name.toLowerCase()) {
    return false;
  }
  return true;
}

function requireFreshClickable(target: RuneLiteTarget | undefined, maxAgeMs: number, coordinateSource?: string): asserts target is RuneLiteTarget & { screenX: number; screenY: number } {
  if (!target) {
    throw new Error("No matching target found");
  }
  if (coordinateSource && target.coordinateSource !== coordinateSource) {
    throw new Error(`Target coordinateSource is ${target.coordinateSource}, expected ${coordinateSource}`);
  }
  if (!Number.isFinite(target.screenX) || !Number.isFinite(target.screenY)) {
    throw new Error(`Target has no click-ready screenX/screenY: ${target.coordinateWarning ?? "unknown reason"}`);
  }
  if (target.coordinateWarning) {
    throw new Error(`Target coordinates are not safe to click: ${target.coordinateWarning}`);
  }
  if (target.ageMs !== undefined && target.ageMs > maxAgeMs) {
    throw new Error(`Target is stale: ageMs=${target.ageMs}, maxAgeMs=${maxAgeMs}`);
  }
}

async function clickPoint(x: number, y: number, rightClick?: boolean) {
  await moveMouseHumanized(x, y);
  await settleBeforeClick();
  if (rightClick) {
    await mouse.rightClick();
  } else {
    await mouse.leftClick();
  }
}

async function movePoint(x: number, y: number) {
  await moveMouseHumanized(x, y);
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampInt(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function bezierPoint(start: Point, control: Point, end: Point, t: number) {
  const oneMinus = 1 - t;
  return new Point(
    Math.round(oneMinus * oneMinus * start.x + 2 * oneMinus * t * control.x + t * t * end.x),
    Math.round(oneMinus * oneMinus * start.y + 2 * oneMinus * t * control.y + t * t * end.y),
  );
}

async function moveMouseHumanized(x: number, y: number) {
  const end = new Point(Math.round(x), Math.round(y));
  if (!HUMANIZE_MOUSE) {
    await mouse.setPosition(end);
    return;
  }

  const start = await mouse.getPosition();
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  if (distance < 3) {
    await mouse.setPosition(end);
    return;
  }

  const normalX = -(end.y - start.y) / distance;
  const normalY = (end.x - start.x) / distance;
  const curve = randomBetween(-0.22, 0.22) * Math.min(distance, 420);
  const control = new Point(
    Math.round((start.x + end.x) / 2 + normalX * curve + randomBetween(-12, 12)),
    Math.round((start.y + end.y) / 2 + normalY * curve + randomBetween(-12, 12)),
  );
  const points = [];
  const steps = clampInt(distance / 32, 8, 28);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    points.push(bezierPoint(start, control, end, t));
  }
  await mouse.move(points);
}

async function settleBeforeClick() {
  if (HUMANIZE_MOUSE && MOUSE_MAX_DELAY_MS > 0) {
    await sleep(Math.round(randomBetween(MOUSE_MIN_DELAY_MS, MOUSE_MAX_DELAY_MS)));
  }
}

function canvasCaptureRect(debug: any, args: {
  canvasX?: number;
  canvasY?: number;
  width?: number;
  height?: number;
  radius?: number;
}) {
  if (debug?.canvasShowing === false) {
    throw new Error("RuneLite canvas is not visible");
  }

  const canvasWidth = finiteNumber(debug?.canvasWidth, 0);
  const canvasHeight = finiteNumber(debug?.canvasHeight, 0);
  const originX = finiteNumber(debug?.canvasOriginNutX, NaN);
  const originY = finiteNumber(debug?.canvasOriginNutY, NaN);
  const scaleX = finiteNumber(debug?.screenScaleX, 1);
  const scaleY = finiteNumber(debug?.screenScaleY, 1);
  if (!canvasWidth || !canvasHeight || !Number.isFinite(originX) || !Number.isFinite(originY)) {
    throw new Error("RuneLite canvas origin/size is unavailable; client may be minimized or not loaded");
  }

  let left = 0;
  let top = 0;
  let width = canvasWidth;
  let height = canvasHeight;

  if (Number.isFinite(args.canvasX) && Number.isFinite(args.canvasY)) {
    const radius = clampInt(args.radius ?? 140, 20, 500);
    left = clampInt((args.canvasX as number) - radius, 0, Math.max(0, canvasWidth - 1));
    top = clampInt((args.canvasY as number) - radius, 0, Math.max(0, canvasHeight - 1));
    width = clampInt(radius * 2, 1, canvasWidth - left);
    height = clampInt(radius * 2, 1, canvasHeight - top);
  } else if (Number.isFinite(args.width) || Number.isFinite(args.height)) {
    left = clampInt(args.canvasX ?? 0, 0, Math.max(0, canvasWidth - 1));
    top = clampInt(args.canvasY ?? 0, 0, Math.max(0, canvasHeight - 1));
    width = clampInt(args.width ?? canvasWidth, 1, canvasWidth - left);
    height = clampInt(args.height ?? canvasHeight, 1, canvasHeight - top);
  }

  return {
    canvas: { x: left, y: top, width, height },
    screen: {
      x: Math.round(originX + left * scaleX),
      y: Math.round(originY + top * scaleY),
      width: Math.max(1, Math.round(width * scaleX)),
      height: Math.max(1, Math.round(height * scaleY)),
    },
    canvasOriginNutX: originX,
    canvasOriginNutY: originY,
    screenScaleX: scaleX,
    screenScaleY: scaleY,
    canvasWidth,
    canvasHeight,
  };
}

async function captureCanvasImage(baseURL: string, args: {
  canvasX?: number;
  canvasY?: number;
  width?: number;
  height?: number;
  radius?: number;
  includeImage?: boolean;
}) {
  const debug = (await runeliteApi(baseURL).get("/debug/coordinates")).data;
  const capture = canvasCaptureRect(debug, args);
  const outputDir = path.join(os.tmpdir(), "runelite-mcp-captures");
  await mkdir(outputDir, { recursive: true });

  const fileBase = `canvas_${Date.now()}`;
  const filePath = await screen.captureRegion(
    fileBase,
    new Region(capture.screen.x, capture.screen.y, capture.screen.width, capture.screen.height),
    FileType.PNG,
    outputDir,
  );

  const response: any = {
    filePath,
    mimeType: "image/png",
    capturedAt: Date.now(),
    ...capture,
  };
  if (args.includeImage !== false) {
    response.base64 = (await readFile(filePath)).toString("base64");
  }
  return response;
}

async function invokeMenuAction(baseURL: string, action: {
  param0: number;
  param1: number;
  menuAction?: string;
  type?: string;
  identifier?: number;
  id?: number;
  itemId?: number;
  option?: string;
  target?: string;
  dryRun?: boolean;
  tickAligned?: boolean;
  tickTimeoutMs?: number;
}) {
  if (!action.dryRun) {
    await assertClientLoggedIn(baseURL);
  }
  const tickWait = action.tickAligned
    ? await waitForGameTick(baseURL, 1, action.tickTimeoutMs ?? 1800)
    : undefined;
  const body = {
    param0: action.param0,
    param1: action.param1,
    menuAction: action.menuAction ?? action.type,
    identifier: action.identifier ?? action.id,
    itemId: action.itemId ?? -1,
    option: action.option ?? "",
    target: action.target ?? "",
    dryRun: action.dryRun ?? false,
  };
  const res = await runeliteApi(baseURL).post("/action/menu", body);
  return tickWait ? { ...res.data, tickWait } : res.data;
}

async function invokeWalkAction(baseURL: string, action: {
  worldX: number;
  worldY: number;
  plane?: number;
  dryRun?: boolean;
  tickAligned?: boolean;
  tickTimeoutMs?: number;
}) {
  if (!action.dryRun) {
    await assertClientLoggedIn(baseURL);
  }
  const tickWait = action.tickAligned
    ? await waitForGameTick(baseURL, 1, action.tickTimeoutMs ?? 1800)
    : undefined;
  const res = await runeliteApi(baseURL).post("/action/walk", {
    worldX: action.worldX,
    worldY: action.worldY,
    plane: action.plane,
    dryRun: action.dryRun ?? false,
  });
  return tickWait ? { ...res.data, tickWait } : res.data;
}

async function invokeWidgetAction(baseURL: string, action: {
  packedId?: number;
  groupId?: number;
  childId?: number;
  param0?: number;
  param1?: number;
  actionIndex?: number;
  menuAction?: string;
  type?: string;
  identifier?: number;
  id?: number;
  itemId?: number;
  option?: string;
  target?: string;
  dryRun?: boolean;
  tickAligned?: boolean;
  tickTimeoutMs?: number;
}) {
  if (!action.dryRun) {
    await assertClientLoggedIn(baseURL);
  }
  const tickWait = action.tickAligned
    ? await waitForGameTick(baseURL, 1, action.tickTimeoutMs ?? 1800)
    : undefined;
  const res = await runeliteApi(baseURL).post("/action/widget", {
    packedId: action.packedId,
    groupId: action.groupId,
    childId: action.childId,
    param0: action.param0,
    param1: action.param1,
    actionIndex: action.actionIndex,
    menuAction: action.menuAction ?? action.type,
    identifier: action.identifier ?? action.id,
    itemId: action.itemId,
    option: action.option ?? "",
    target: action.target ?? "",
    dryRun: action.dryRun ?? false,
  });
  return tickWait ? { ...res.data, tickWait } : res.data;
}

async function getPlayerLocation(target: ClientTarget = {}) {
  const { snapshot } = await getSnapshotForTarget(target);
  return snapshot.state?.location;
}

function sortNearestToPlayer<T extends RuneLiteTarget>(items: T[], playerLocation: any): T[] {
  if (!playerLocation) {
    return items;
  }
  return items.slice().sort((a, b) => {
    const da = Math.abs((a.worldX ?? 0) - playerLocation.x) + Math.abs((a.worldY ?? 0) - playerLocation.y);
    const db = Math.abs((b.worldX ?? 0) - playerLocation.x) + Math.abs((b.worldY ?? 0) - playerLocation.y);
    return da - db;
  });
}

function sortByDistance<T extends RuneLiteTarget>(items: T[]): T[] {
  return items.slice().sort((a, b) => (a.distanceToPlayer ?? Number.MAX_SAFE_INTEGER) - (b.distanceToPlayer ?? Number.MAX_SAFE_INTEGER));
}

function formatTarget(target: RuneLiteTarget | undefined): string {
  if (!target) {
    return "No matching target found";
  }
  return JSON.stringify(target, null, 2);
}

function freshEnough(target: RuneLiteTarget, maxAgeMs: number): boolean {
  return target.ageMs === undefined || target.ageMs <= maxAgeMs;
}

function hasScreenPoint(target: RuneLiteTarget): boolean {
  return Number.isFinite(target.screenX) && Number.isFinite(target.screenY);
}

function chebyshevDistance(a: any, b: any): number {
  return Math.max(Math.abs((a?.x ?? 0) - (b?.x ?? 0)), Math.abs((a?.y ?? 0) - (b?.y ?? 0)));
}

function calculateStraightLineSteps(from: any, to: any, maxStepTiles = 18, maxSteps = 12) {
  if (!from || !Number.isFinite(from.x) || !Number.isFinite(from.y)) {
    throw new Error("Current player location is unavailable");
  }
  if (!Number.isFinite(to.worldX) || !Number.isFinite(to.worldY)) {
    throw new Error("Target worldX/worldY are required");
  }

  const safeMaxStep = Math.max(1, Math.floor(maxStepTiles));
  const totalDx = to.worldX - from.x;
  const totalDy = to.worldY - from.y;
  const distance = Math.max(Math.abs(totalDx), Math.abs(totalDy));
  const stepsNeeded = Math.max(1, Math.ceil(distance / safeMaxStep));
  const stepsToReturn = Math.min(stepsNeeded, Math.max(1, Math.floor(maxSteps)));
  const steps = [];

  for (let i = 1; i <= stepsToReturn; i += 1) {
    const factor = Math.min(1, i / stepsNeeded);
    steps.push({
      worldX: Math.round(from.x + totalDx * factor),
      worldY: Math.round(from.y + totalDy * factor),
      plane: to.plane ?? from.plane ?? 0,
      final: i === stepsNeeded,
    });
  }

  return {
    from,
    target: { worldX: to.worldX, worldY: to.worldY, plane: to.plane ?? from.plane ?? 0 },
    distance,
    maxStepTiles: safeMaxStep,
    stepsNeeded,
    returnedSteps: steps.length,
    truncated: stepsNeeded > steps.length,
    collisionAware: false,
    note: "Straight-line minimap steps only; obstacles and doors are not pathfound.",
    steps,
  };
}

async function calculateCollisionAwarePath(
  baseURL: string,
  worldX: number,
  worldY: number,
  plane?: number,
  maxNodes = 4096,
): Promise<LocalPathResult> {
  const params: Record<string, number> = {
    worldX,
    worldY,
    maxNodes,
  };
  if (plane !== undefined) {
    params.plane = plane;
  }

  const response = await runeliteApi(baseURL).get("/path", { params });
  return response.data as LocalPathResult;
}

function withStraightLineFallback(
  snapshot: RuneLiteSnapshot,
  target: { worldX: number; worldY: number; plane?: number },
  maxStepTiles: number,
  maxSteps: number,
  collisionPath?: LocalPathResult,
) {
  const fallback = calculateStraightLineSteps(snapshot.state?.location, target, maxStepTiles, maxSteps);
  return {
    ...fallback,
    fallbackUsed: true,
    fallbackReason: collisionPath?.error ?? "COLLISION_PATH_UNAVAILABLE",
    collisionPath,
  };
}

function chooseLocalPathStep(path: LocalPathResult, maxStepTiles = 18): PathStep | undefined {
  const steps = Array.isArray(path.steps) ? path.steps : [];
  if (steps.length <= 1) {
    return steps[0];
  }

  const safeMaxStep = Math.max(1, Math.floor(maxStepTiles));
  return steps[Math.min(safeMaxStep, steps.length - 1)];
}

async function waitUntilBaseLocation(
  baseURL: string,
  worldX: number,
  worldY: number,
  plane: number | undefined,
  radius = 1,
  timeoutMs = 8000,
  pollMs = 500,
) {
  const startedAt = Date.now();
  const timeout = Math.max(1, timeoutMs);
  const interval = Math.max(100, pollMs);
  const acceptedRadius = Math.max(0, radius);
  let lastLocation: any = null;
  let lastDistance = Number.MAX_SAFE_INTEGER;

  while (Date.now() - startedAt <= timeout) {
    const snapshot = await getSnapshotForBase(baseURL, true);
    lastLocation = snapshot.state?.location;
    lastDistance = tileDistance(lastLocation, worldX, worldY, plane);
    if (lastDistance <= acceptedRadius) {
      return {
        reached: true,
        waitedMs: Date.now() - startedAt,
        distance: lastDistance,
        location: lastLocation,
      };
    }
    await sleep(interval);
  }

  return {
    reached: false,
    waitedMs: Date.now() - startedAt,
    distance: lastDistance,
    location: lastLocation,
  };
}

function targetsForType(snapshot: RuneLiteSnapshot, entityType: string): RuneLiteTarget[] {
  switch (entityType.toLowerCase()) {
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
      throw new Error(`Unsupported entityType: ${entityType}`);
  }
}

function defaultCoordinateSourceForType(entityType: string): string | undefined {
  switch (entityType.toLowerCase()) {
    case "npc":
    case "npcs":
    case "player":
    case "players":
      return "convexHull";
    case "object":
    case "objects":
      return "clickbox";
    default:
      return undefined;
  }
}

function selectLiveTarget(
  snapshot: RuneLiteSnapshot,
  entityType: string,
  name?: string,
  id?: number,
  nearestToPlayer?: boolean,
  coordinateSource?: string
): RuneLiteTarget | undefined {
  const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
  const matches = sortNearestToPlayer(
    sortByDistance(targetsForType(snapshot, entityType).filter((target: any) => targetMatches(target, name, id))),
    playerLocation
  );

  const expectedSource = coordinateSource ?? defaultCoordinateSourceForType(entityType);
  if (expectedSource) {
    return matches.find((target: any) => target.coordinateSource === expectedSource && hasScreenPoint(target));
  }

  return matches.find((target: any) => hasScreenPoint(target));
}

function clientTargetSchema() {
  return {
    instanceId: z.string().optional().describe("Optional RuneLite plugin instanceId to target"),
    playerName: z.string().optional().describe("Optional player name to target"),
    port: z.number().optional().describe("Optional RuneLite API port to target, for example 8081"),
  };
}

function resourceText(uri: string, data: unknown) {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(data, null, 2),
    }]
  };
}

server.registerResource(
  "latest-snapshot",
  "osrs://snapshot/latest",
  {
    title: "Latest OSRS Snapshot",
    description: "Latest cached RuneLite snapshot for the selected OSRS client, including live state and high-value UI context.",
    mimeType: "application/json",
  },
  async () => {
    const uri = "osrs://snapshot/latest";
    try {
      const { baseURL, snapshot } = await getSnapshotForTarget();
      return resourceText(uri, {
        baseURL,
        stream: snapshotStreamStatus(baseURL),
        snapshot,
      });
    } catch (e: any) {
      return resourceText(uri, { error: errorText("reading latest snapshot resource", e) });
    }
  }
);

server.registerResource(
  "recent-events",
  "osrs://events/recent",
  {
    title: "Recent OSRS Events",
    description: "Recent event-style state for the selected OSRS client, including plugin event hooks and chat/game messages.",
    mimeType: "application/json",
  },
  async () => {
    const uri = "osrs://events/recent";
    try {
      const baseURL = await resolveRuneliteApi();
      const api = runeliteApi(baseURL);
      const events = (await api.get("/events", { params: { limit: 80 } })).data;
      const chat = (await api.get("/chat", { params: { limit: 50 } })).data;
      return resourceText(uri, {
        baseURL,
        stream: snapshotStreamStatus(baseURL),
        events,
        chat,
      });
    } catch (e: any) {
      return resourceText(uri, { error: errorText("reading recent events resource", e) });
    }
  }
);

server.registerResource(
  "client-identity",
  "osrs://client/identity",
  {
    title: "Selected OSRS Client Identity",
    description: "Identity, selected base URL, and discovered RuneLite plugin clients.",
    mimeType: "application/json",
  },
  async () => {
    const uri = "osrs://client/identity";
    try {
      const clients = await discoverClients();
      let identity: any = null;
      try {
        const baseURL = await resolveRuneliteApi();
        identity = (await runeliteApi(baseURL).get("/identity")).data;
      } catch (e: any) {
        identity = { error: errorText("fetching selected identity", e) };
      }
      return resourceText(uri, {
        selectedBaseUrl: selectedRuneliteApi,
        selectedClientInstanceId,
        identity,
        clients,
      });
    } catch (e: any) {
      return resourceText(uri, { error: errorText("reading client identity resource", e) });
    }
  }
);

server.registerPrompt(
  "experienced-player-loop",
  {
    title: "Experienced OSRS Player Loop",
    description: "General observe-plan-act-verify loop for controlling OSRS through this MCP bridge.",
    argsSchema: {
      task: z.string().describe("The user's gameplay objective"),
    },
  },
  async ({ task }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          `Objective: ${task}`,
          "",
          "Act like an experienced OSRS player using this MCP bridge.",
          "1. Start with get_agent_context; it bundles identity, runtime freshness, state, risks, nearby targets, UI, chat, and recommended checks.",
          "2. Use plan_next_action when you want a conservative ordered tool-call plan for the current objective before acting.",
          "3. Run diagnose_runtime if get_agent_context reports stale runtime, 404/missing endpoint, or after rebuilding the plugin.",
          "4. Prefer high-level tools: interact_with, walk_to, wait_until_idle, wait_until_location, wait_for_chat_message.",
          "5. Prefer in-client actions: interact_with and click_* with option over raw screen clicks.",
          "6. Verify each action through snapshot changes, chat messages, location, animation, inventory, or interfaceSummary.",
          "7. Before risky actions, call mark_action_baseline; afterward use verify_last_action for snapshot diffs.",
          "8. When coordinates are needed, reject stale or warning-marked targets; use hover/verify tools before risky clicks.",
          "9. For navigation, use walk_route_to for multi-step movement and calculate_path_to/walk_path_to for inspection or one cautious step.",
          "10. Use wait_for_game_tick or tickAligned direct invoke_* actions for timing-sensitive sequences.",
        ].join("\n"),
      },
    }],
  })
);

server.registerPrompt(
  "woodcut-and-bank",
  {
    title: "Woodcut And Bank",
    description: "Task template for cutting nearby trees and banking logs with verification between actions.",
    argsSchema: {
      treeName: z.string().default("Tree").describe("Tree object name, for example Tree, Oak tree, Willow tree"),
      logName: z.string().default("Logs").describe("Inventory/bank item name for the logs"),
      bankTarget: z.string().default("Banker").describe("NPC or object to open the bank"),
    },
  },
  async ({ treeName, logName, bankTarget }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          `Woodcut target: ${treeName}`,
          `Log item: ${logName}`,
          `Bank opener: ${bankTarget}`,
          "",
          "Use this loop:",
          "1. Read osrs://snapshot/latest. Confirm inventory, player location, nearby objects, chat, and interfaceSummary.",
          `2. If inventory is not full, use interact_with({ entityType: \"object\", name: \"${treeName}\", option: \"Chop down\", nearestToPlayer: true }).`,
          "3. Mark a baseline before each chop, then verify logs/inventory, animation, chat, or tree/entity changes afterward.",
          "4. Wait until player is idle or tree disappears. Check chat for errors.",
          "5. Repeat until inventory is full.",
          "6. Navigate to bank using walk_route_to when you know the bank tile, or walk_path_to for one cautious step.",
          `7. Open bank with interact_with on ${bankTarget} using option Bank/Open.`,
          `8. Deposit ${logName} using bank tools, then verify inventory/bank state.`,
        ].join("\n"),
      },
    }],
  })
);

server.registerPrompt(
  "complete-dialogue",
  {
    title: "Complete Dialogue",
    description: "Task template for continuing NPC/player dialogue and selecting dialogue options safely.",
    argsSchema: {
      desiredOption: z.string().optional().describe("Option text or number to choose when dialogue options appear"),
    },
  },
  async ({ desiredOption }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          "Dialogue handling loop:",
          "1. Read get_dialogue or osrs://snapshot/latest.",
          "2. If type is NPC_DIALOGUE or PLAYER_DIALOGUE, click the continue widget or press Space after checking interfaceSummary.",
          `3. If type is DIALOGUE_OPTIONS, choose ${desiredOption ? `"${desiredOption}"` : "the option matching the task goal"} with select_option or keyboard number if appropriate.`,
          "4. After each action, wait briefly and re-read dialogue/chat.",
          "5. Stop when dialogue type is NONE or the task state/chat confirms completion.",
        ].join("\n"),
      },
    }],
  })
);

server.registerPrompt(
  "withdraw-and-equip",
  {
    title: "Withdraw And Equip",
    description: "Task template for opening bank, withdrawing an item, and equipping or using it.",
    argsSchema: {
      itemName: z.string().describe("Item to withdraw"),
      quantity: z.string().default("1").describe("Quantity, for example 1, 5, 10, all"),
    },
  },
  async ({ itemName, quantity }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          `Item: ${itemName}`,
          `Quantity: ${quantity}`,
          "",
          "Bank/equip loop:",
          "1. Read osrs://snapshot/latest and get_interface_summary.",
          "2. If bank is not open, interact with nearest banker/bank booth using option Bank/Open.",
          "3. Use get_bank_actions and withdraw_bank_item for the requested item/quantity.",
          "4. Verify inventory changed and chat has no error.",
          "5. Close bank if needed, then use inventory/equipment tools to equip/use the item.",
          "6. Verify equipment or inventory state after the action.",
        ].join("\n"),
      },
    }],
  })
);

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readClientState(baseURL: string) {
  return (await runeliteApi(baseURL).get("/state")).data;
}

async function waitForGameTick(baseURL: string, minTicks = 1, timeoutMs = 1800, pollMs = 75) {
  const startedAt = Date.now();
  const firstState = await readClientState(baseURL);
  const startTick = Number(firstState?.tick ?? 0);
  const targetTick = startTick + Math.max(1, Math.floor(minTicks));
  let lastTick = startTick;

  while (Date.now() - startedAt <= timeoutMs) {
    const state = await readClientState(baseURL);
    const currentTick = Number(state?.tick ?? 0);
    lastTick = currentTick;
    if (currentTick >= targetTick) {
      return {
        startTick,
        targetTick,
        currentTick,
        waitedMs: Date.now() - startedAt,
      };
    }
    await sleep(Math.max(25, pollMs));
  }

  throw new Error(`Timed out waiting for game tick ${targetTick}; last known tick was ${lastTick}`);
}

type OpenContextMenuArgs = ClientTarget & {
  entityType: "npc" | "object" | "ground_item" | "player";
  name?: string;
  id?: number;
  nearestToPlayer?: boolean;
  coordinateSource?: string;
  maxAgeMs?: number;
  menuDelayMs?: number;
};

async function openContextMenuForTarget(args: OpenContextMenuArgs) {
  const targetClient = { instanceId: args.instanceId, playerName: args.playerName, port: args.port };
  const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
  await assertClientReady(baseURL);
  const expectedSource = args.coordinateSource ?? defaultCoordinateSourceForType(args.entityType);
  const target = selectLiveTarget(
    snapshot,
    args.entityType,
    args.name,
    args.id,
    args.nearestToPlayer ?? true,
    args.coordinateSource
  );
  requireFreshClickable(target, args.maxAgeMs ?? 600, expectedSource);
  await clickPoint(target.screenX, target.screenY, true);
  await sleep(Math.max(0, args.menuDelayMs ?? 150));
  const menu = (await runeliteApi(baseURL).get("/context_menu")).data;
  return {
    rightClicked: {
      entityType: args.entityType,
      name: target.name,
      id: target.id,
      screenX: target.screenX,
      screenY: target.screenY,
      worldX: target.worldX,
      worldY: target.worldY,
      coordinateSource: target.coordinateSource,
      distanceToPlayer: target.distanceToPlayer,
      ageMs: target.ageMs,
    },
    menu,
  };
}

async function interactWithTarget(args: OpenContextMenuArgs & { option: string; exact?: boolean }) {
  const targetAndMenu = await openContextMenuForTarget(args);
  const selected = await selectContextMenuOption(args.option, args, args.exact);
  return {
    ...targetAndMenu,
    selected,
  };
}

async function clickMinimapProjection(worldX: number, worldY: number, plane: number | undefined, target: ClientTarget = {}, maxAgeMs = 1000) {
  const api = await apiForTarget(target);
  await assertClientReady(api.defaults.baseURL ?? selectedRuneliteApi);
  const res = await api.get("/minimap", { params: { worldX, worldY, plane } });
  const minimapTarget = res.data?.target as RuneLiteTarget | undefined;
  requireFreshClickable(minimapTarget, maxAgeMs, "minimapProjection");
  await clickPoint(minimapTarget.screenX, minimapTarget.screenY);
  return minimapTarget;
}

async function clickShopAction(
  actionText: string,
  itemName?: string,
  itemId?: number,
  rightClick?: boolean,
  target: ClientTarget = {}
) {
  const baseURL = await resolveRuneliteApi(target);
  await assertClientReady(baseURL);
  const res = await runeliteApi(baseURL).get("/shop");
  const actionNeedle = actionText.toLowerCase();
  const itemNeedle = itemName?.toLowerCase();
  const shopTarget = (res.data?.actionWidgets ?? []).find((widget: any) => {
    const actions = Array.isArray(widget.actions) ? widget.actions.join(" ").toLowerCase() : "";
    const label = `${widget.name ?? ""} ${widget.text ?? ""}`.toLowerCase();
    return actions.includes(actionNeedle) &&
      (itemId === undefined || widget.itemId === itemId) &&
      (!itemNeedle || label.includes(itemNeedle));
  });
  requireFreshClickable(shopTarget, 1000, "widgetBounds");
  await clickPoint(shopTarget.screenX, shopTarget.screenY, rightClick);
  return shopTarget;
}

async function clickBankAction(
  actionText: string,
  itemName?: string,
  itemId?: number,
  rightClick?: boolean,
  target: ClientTarget = {}
) {
  const baseURL = await resolveRuneliteApi(target);
  await assertClientReady(baseURL);
  const res = await runeliteApi(baseURL).get("/bank_actions");
  const actionNeedle = actionText.toLowerCase();
  const itemNeedle = itemName?.toLowerCase();
  const widgets = actionNeedle.includes("deposit")
    ? res.data?.depositWidgets ?? []
    : res.data?.withdrawWidgets ?? [];
  const bankTarget = widgets.find((widget: any) => {
    const actions = Array.isArray(widget.actions) ? widget.actions.join(" ").toLowerCase() : "";
    const label = `${widget.name ?? ""} ${widget.text ?? ""}`.toLowerCase();
    return actions.includes(actionNeedle) &&
      (itemId === undefined || widget.itemId === itemId) &&
      (!itemNeedle || label.includes(itemNeedle));
  });
  requireFreshClickable(bankTarget, 1000, "widgetBounds");
  await clickPoint(bankTarget.screenX, bankTarget.screenY, rightClick);
  return bankTarget;
}

function findInventoryItem(snapshot: RuneLiteSnapshot, name?: string, id?: number, slot?: number): RuneLiteTarget | undefined {
  return (snapshot.inventory ?? []).find((item: any) =>
    (slot === undefined || item.slot === slot) &&
    targetMatches(item, name, id) &&
    Number.isFinite(item.slotScreenX) &&
    Number.isFinite(item.slotScreenY)
  );
}

function requireFreshInventoryItem(item: RuneLiteTarget | undefined, maxAgeMs: number): asserts item is RuneLiteTarget & { slotScreenX: number; slotScreenY: number } {
  if (!item) {
    throw new Error("No matching inventory item with slot coordinates found");
  }
  if (!Number.isFinite(item.slotScreenX) || !Number.isFinite(item.slotScreenY)) {
    throw new Error("Inventory item has no click-ready slotScreenX/slotScreenY");
  }
  if (item.ageMs !== undefined && item.ageMs > maxAgeMs) {
    throw new Error(`Inventory item data is stale: ageMs=${item.ageMs}, maxAgeMs=${maxAgeMs}`);
  }
}

async function selectInventoryItemForUse(item: RuneLiteTarget & { slotScreenX: number; slotScreenY: number }, target: ClientTarget, useRightClickMenu = true) {
  if (useRightClickMenu) {
    await clickPoint(item.slotScreenX, item.slotScreenY, true);
    await sleep(150);
    await selectContextMenuOption("Use", target, false);
  } else {
    await clickPoint(item.slotScreenX, item.slotScreenY);
  }
}

async function selectInventoryItemOption(item: RuneLiteTarget & { slotScreenX: number; slotScreenY: number }, option: string, target: ClientTarget) {
  await clickPoint(item.slotScreenX, item.slotScreenY, true);
  await sleep(150);
  return selectContextMenuOption(option, target, false);
}

async function selectContextMenuOption(text: string, target: ClientTarget = {}, exact?: boolean) {
  const baseURL = await resolveRuneliteApi(target);
  await assertClientReady(baseURL);
  const menu = (await runeliteApi(baseURL).get("/context_menu")).data;
  if (!menu?.isOpen) {
    throw new Error("Context menu is not open");
  }

  const needle = text.toLowerCase();
  const entries = (menu.entries ?? []) as RuneLiteTarget[];
  const match = entries.find((entry: RuneLiteTarget) => {
    const optionText = `${entry.option ?? ""} ${entry.target ?? ""}`.trim().toLowerCase();
    return exact ? optionText === needle || String(entry.option ?? "").toLowerCase() === needle : optionText.includes(needle);
  });

  if (!match) {
    throw new Error("No matching context menu option found");
  }

  if (Number.isFinite(match.param0) && Number.isFinite(match.param1) && Number.isFinite(match.identifier) && match.type) {
    const action = await invokeMenuAction(baseURL, {
      param0: match.param0 as number,
      param1: match.param1 as number,
      type: match.type,
      identifier: match.identifier,
      itemId: match.itemId,
      option: match.option,
      target: match.target,
    });
    return { ...match, actionMode: "client_menu_action", action };
  }

  requireFreshClickable(match, 1000);
  await clickPoint(match.screenX, match.screenY);
  return { ...match, actionMode: "os_click_fallback" };
}

function isPlayerIdle(state: any): boolean {
  return state?.isIdle === true || (state?.animation === -1 && !state?.interactingWith);
}

function tileDistance(location: any, worldX: number, worldY: number, plane?: number): number {
  if (!location || !Number.isFinite(location.x) || !Number.isFinite(location.y)) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (plane !== undefined && location.plane !== plane) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(Math.abs(location.x - worldX), Math.abs(location.y - worldY));
}

function matchesChatMessage(message: any, text: string, caseSensitive?: boolean, type?: string) {
  if (type && String(message.type ?? "").toLowerCase() !== type.toLowerCase()) {
    return false;
  }
  const haystack = String(message.message ?? "");
  return caseSensitive ? haystack.includes(text) : haystack.toLowerCase().includes(text.toLowerCase());
}

function inventoryQuantity(snapshot: RuneLiteSnapshot, name?: string, id?: number): number {
  return (snapshot.inventory ?? [])
    .filter((item: any) => targetMatches(item, name, id))
    .reduce((total: number, item: any) => total + (Number.isFinite(item.quantity) ? Number(item.quantity) : 1), 0);
}

function recentMessages(snapshot: RuneLiteSnapshot): any[] {
  return Array.isArray(snapshot.chat?.messages) ? snapshot.chat.messages : [];
}

function visibleEntityCount(snapshot: RuneLiteSnapshot, entityType?: string, name?: string, id?: number): number {
  if (!entityType) {
    return 0;
  }
  return targetsForType(snapshot, entityType).filter((target: any) => targetMatches(target, name, id)).length;
}

function buildActionVerification(snapshot: RuneLiteSnapshot, args: {
  startedAt: number;
  expectIdle?: boolean;
  expectedWorldX?: number;
  expectedWorldY?: number;
  expectedPlane?: number;
  locationRadius?: number;
  chatContains?: string;
  chatType?: string;
  caseSensitive?: boolean;
  inventoryItemName?: string;
  inventoryItemId?: number;
  inventoryQuantityAtLeast?: number;
  inventoryQuantityChangedFrom?: number;
  entityType?: string;
  entityName?: string;
  entityId?: number;
  requireEntityVisible?: boolean;
  dialogueType?: string;
}) {
  const checks = [];
  const state = snapshot.state ?? {};
  const location = state.location;

  if (args.expectIdle) {
    checks.push({ name: "idle", ok: isPlayerIdle(state), state });
  }

  if (Number.isFinite(args.expectedWorldX) && Number.isFinite(args.expectedWorldY)) {
    const distance = tileDistance(location, args.expectedWorldX as number, args.expectedWorldY as number, args.expectedPlane);
    checks.push({
      name: "location",
      ok: distance <= Math.max(0, args.locationRadius ?? 1),
      distance,
      location,
      expected: { x: args.expectedWorldX, y: args.expectedWorldY, plane: args.expectedPlane, radius: args.locationRadius ?? 1 },
    });
  }

  if (args.chatContains) {
    const match = recentMessages(snapshot).find((message: any) =>
      Number(message.capturedAt ?? 0) >= args.startedAt &&
      matchesChatMessage(message, args.chatContains as string, args.caseSensitive, args.chatType)
    );
    checks.push({ name: "chat", ok: Boolean(match), match });
  }

  if (args.inventoryItemName || Number.isFinite(args.inventoryItemId) || Number.isFinite(args.inventoryQuantityAtLeast) || Number.isFinite(args.inventoryQuantityChangedFrom)) {
    const quantity = inventoryQuantity(snapshot, args.inventoryItemName, args.inventoryItemId);
    const okAtLeast = !Number.isFinite(args.inventoryQuantityAtLeast) || quantity >= (args.inventoryQuantityAtLeast as number);
    const okChanged = !Number.isFinite(args.inventoryQuantityChangedFrom) || quantity !== args.inventoryQuantityChangedFrom;
    checks.push({
      name: "inventory",
      ok: okAtLeast && okChanged,
      quantity,
      itemName: args.inventoryItemName,
      itemId: args.inventoryItemId,
      quantityAtLeast: args.inventoryQuantityAtLeast,
      quantityChangedFrom: args.inventoryQuantityChangedFrom,
    });
  }

  if (args.requireEntityVisible || args.entityType) {
    const count = visibleEntityCount(snapshot, args.entityType, args.entityName, args.entityId);
    checks.push({ name: "entityVisible", ok: count > 0, count, entityType: args.entityType, entityName: args.entityName, id: args.entityId });
  }

  if (args.dialogueType) {
    const actual = snapshot.interfaceSummary?.dialogueType ?? snapshot.dialogue?.type;
    checks.push({ name: "dialogueType", ok: String(actual ?? "").toLowerCase() === args.dialogueType.toLowerCase(), actual, expected: args.dialogueType });
  }

  const summary = {
    state,
    inventorySlotsUsed: (snapshot.inventory ?? []).filter((item: any) => item && item.id && item.id !== -1).length,
    dialogueType: snapshot.interfaceSummary?.dialogueType ?? snapshot.dialogue?.type,
    recentChat: recentMessages(snapshot).slice(0, 5),
  };

  return {
    ok: checks.length === 0 ? true : checks.every((check) => check.ok),
    checks,
    summary,
  };
}

function snapshotDiffSummary(snapshot: RuneLiteSnapshot, itemName?: string, itemId?: number) {
  const dialogueText = cleanUiText(snapshot.dialogue?.text ?? snapshot.interfaceSummary?.dialogueText ?? "");
  return {
    capturedAt: snapshot.state?.capturedAt ?? snapshot.interfaceSummary?.capturedAt ?? Date.now(),
    state: snapshot.state ?? {},
    location: snapshot.state?.location,
    health: snapshot.state?.health,
    animation: snapshot.state?.animation,
    isIdle: isPlayerIdle(snapshot.state ?? {}),
    inventorySlotsUsed: inventorySlotsUsed(snapshot),
    inventoryItemQuantity: (itemName || Number.isFinite(itemId)) ? inventoryQuantity(snapshot, itemName, itemId) : undefined,
    dialogueType: snapshot.interfaceSummary?.dialogueType ?? snapshot.dialogue?.type,
    dialogueText,
    entityCounts: {
      npcs: snapshot.npcs?.length ?? 0,
      objects: snapshot.objects?.length ?? 0,
      groundItems: snapshot.groundItems?.length ?? 0,
      players: snapshot.players?.length ?? 0,
    },
  };
}

function buildSnapshotDiffVerification(before: RuneLiteSnapshot, after: RuneLiteSnapshot, baselineCapturedAt: number, args: {
  inventoryItemName?: string;
  inventoryItemId?: number;
  expectInventoryQuantityChanged?: boolean;
  expectInventoryIncreased?: boolean;
  expectInventoryDecreased?: boolean;
  expectInventorySlotsChanged?: boolean;
  expectLocationChanged?: boolean;
  expectedWorldX?: number;
  expectedWorldY?: number;
  expectedPlane?: number;
  locationRadius?: number;
  expectDialogueChanged?: boolean;
  dialogueType?: string;
  expectNewChat?: boolean;
  chatContains?: string;
  chatType?: string;
  caseSensitive?: boolean;
  entityType?: string;
  entityName?: string;
  entityId?: number;
  expectEntityCountChanged?: boolean;
  requireAnyChange?: boolean;
}) {
  const beforeSummary = snapshotDiffSummary(before, args.inventoryItemName, args.inventoryItemId);
  const afterSummary = snapshotDiffSummary(after, args.inventoryItemName, args.inventoryItemId);
  const checks: any[] = [];
  const changeKeys: string[] = [];

  const beforeLocation = beforeSummary.location;
  const afterLocation = afterSummary.location;
  const movedDistance = beforeLocation && afterLocation
    ? tileDistance(afterLocation, beforeLocation.x, beforeLocation.y, beforeLocation.plane)
    : Number.MAX_SAFE_INTEGER;
  if (Number.isFinite(movedDistance) && movedDistance > 0 && movedDistance < Number.MAX_SAFE_INTEGER) {
    changeKeys.push("location");
  }

  const beforeItemQuantity = beforeSummary.inventoryItemQuantity;
  const afterItemQuantity = afterSummary.inventoryItemQuantity;
  const inventoryItemDelta = Number.isFinite(beforeItemQuantity) && Number.isFinite(afterItemQuantity)
    ? (afterItemQuantity as number) - (beforeItemQuantity as number)
    : undefined;
  const inventorySlotsDelta = afterSummary.inventorySlotsUsed - beforeSummary.inventorySlotsUsed;
  if (inventorySlotsDelta !== 0) {
    changeKeys.push("inventory_slots");
  }
  if (inventoryItemDelta !== undefined && inventoryItemDelta !== 0) {
    changeKeys.push("inventory_item_quantity");
  }

  if (afterSummary.health !== beforeSummary.health) {
    changeKeys.push("health");
  }
  if (afterSummary.animation !== beforeSummary.animation) {
    changeKeys.push("animation");
  }
  if (afterSummary.dialogueType !== beforeSummary.dialogueType || afterSummary.dialogueText !== beforeSummary.dialogueText) {
    changeKeys.push("dialogue");
  }

  const freshMessages = recentMessages(after).filter((message: any) => Number(message.capturedAt ?? 0) >= baselineCapturedAt);
  if (freshMessages.length > 0) {
    changeKeys.push("chat");
  }

  if (args.expectInventoryQuantityChanged) {
    checks.push({ name: "inventoryQuantityChanged", ok: inventoryItemDelta !== undefined && inventoryItemDelta !== 0, before: beforeItemQuantity, after: afterItemQuantity, delta: inventoryItemDelta });
  }
  if (args.expectInventoryIncreased) {
    checks.push({ name: "inventoryIncreased", ok: inventoryItemDelta !== undefined && inventoryItemDelta > 0, before: beforeItemQuantity, after: afterItemQuantity, delta: inventoryItemDelta });
  }
  if (args.expectInventoryDecreased) {
    checks.push({ name: "inventoryDecreased", ok: inventoryItemDelta !== undefined && inventoryItemDelta < 0, before: beforeItemQuantity, after: afterItemQuantity, delta: inventoryItemDelta });
  }
  if (args.expectInventorySlotsChanged) {
    checks.push({ name: "inventorySlotsChanged", ok: inventorySlotsDelta !== 0, before: beforeSummary.inventorySlotsUsed, after: afterSummary.inventorySlotsUsed, delta: inventorySlotsDelta });
  }
  if (args.expectLocationChanged) {
    checks.push({ name: "locationChanged", ok: Number.isFinite(movedDistance) && movedDistance > 0 && movedDistance < Number.MAX_SAFE_INTEGER, before: beforeLocation, after: afterLocation, distance: movedDistance });
  }
  if (Number.isFinite(args.expectedWorldX) && Number.isFinite(args.expectedWorldY)) {
    const distance = tileDistance(afterLocation, args.expectedWorldX as number, args.expectedWorldY as number, args.expectedPlane);
    checks.push({ name: "locationReached", ok: distance <= Math.max(0, args.locationRadius ?? 1), distance, location: afterLocation, expected: { x: args.expectedWorldX, y: args.expectedWorldY, plane: args.expectedPlane, radius: args.locationRadius ?? 1 } });
  }
  if (args.expectDialogueChanged) {
    checks.push({ name: "dialogueChanged", ok: changeKeys.includes("dialogue"), before: { type: beforeSummary.dialogueType, text: beforeSummary.dialogueText }, after: { type: afterSummary.dialogueType, text: afterSummary.dialogueText } });
  }
  if (args.dialogueType) {
    checks.push({ name: "dialogueType", ok: String(afterSummary.dialogueType ?? "").toLowerCase() === args.dialogueType.toLowerCase(), actual: afterSummary.dialogueType, expected: args.dialogueType });
  }
  if (args.expectNewChat || args.chatContains) {
    const match = args.chatContains
      ? freshMessages.find((message: any) => matchesChatMessage(message, args.chatContains as string, args.caseSensitive, args.chatType))
      : freshMessages[0];
    checks.push({ name: "newChat", ok: Boolean(match), match, freshMessageCount: freshMessages.length });
  }
  if (args.entityType && args.expectEntityCountChanged) {
    const beforeCount = visibleEntityCount(before, args.entityType, args.entityName, args.entityId);
    const afterCount = visibleEntityCount(after, args.entityType, args.entityName, args.entityId);
    checks.push({ name: "entityCountChanged", ok: beforeCount !== afterCount, before: beforeCount, after: afterCount, entityType: args.entityType, entityName: args.entityName, entityId: args.entityId });
  }

  const requireAnyChange = args.requireAnyChange ?? checks.length === 0;
  if (requireAnyChange) {
    checks.push({ name: "anySnapshotChange", ok: changeKeys.length > 0, changeKeys });
  }

  return {
    ok: checks.length === 0 ? true : checks.every((check) => check.ok),
    checks,
    changeKeys: Array.from(new Set(changeKeys)),
    deltas: {
      movedDistance,
      inventorySlotsDelta,
      inventoryItemDelta,
      freshChatCount: freshMessages.length,
    },
    before: beforeSummary,
    after: afterSummary,
    freshMessages: freshMessages.slice(-10),
  };
}

function inventorySlotsUsed(snapshot: RuneLiteSnapshot): number {
  return (snapshot.inventory ?? []).filter((item: any) => item && item.id && item.id !== -1).length;
}

function healthPercent(snapshot: RuneLiteSnapshot): number | undefined {
  const current = Number(snapshot.state?.health);
  const max = Number(snapshot.skills?.Hitpoints?.level ?? snapshot.skills?.["Hitpoints"]?.level);
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) {
    return undefined;
  }
  return (current / max) * 100;
}

function findFoodItem(snapshot: RuneLiteSnapshot, foodNames?: string[], foodName?: string, foodId?: number, slot?: number): RuneLiteTarget | undefined {
  const names = [
    ...(foodName ? [foodName] : []),
    ...(foodNames ?? []),
  ].map((name) => name.toLowerCase());

  const defaultFoodNeedles = [
    "shrimp", "sardine", "herring", "trout", "salmon", "tuna", "lobster", "swordfish",
    "monkfish", "shark", "sea turtle", "manta ray", "anglerfish", "karambwan",
    "cake", "pie", "pizza", "potato", "stew", "wine",
  ];

  return (snapshot.inventory ?? []).find((item: any) => {
    if (slot !== undefined && item.slot !== slot) {
      return false;
    }
    if (foodId !== undefined && item.id !== foodId) {
      return false;
    }
    const itemName = String(item.name ?? "").toLowerCase();
    if (names.length > 0) {
      return names.some((name) => itemName.includes(name));
    }
    return defaultFoodNeedles.some((needle) => itemName.includes(needle));
  });
}

function conditionMet(snapshot: RuneLiteSnapshot, args: {
  condition: string;
  startedAt: number;
  inventoryItemName?: string;
  inventoryItemId?: number;
  inventoryQuantityAtLeast?: number;
  chatContains?: string;
  chatType?: string;
  caseSensitive?: boolean;
  entityType?: string;
  entityName?: string;
  entityId?: number;
  worldX?: number;
  worldY?: number;
  plane?: number;
  radius?: number;
}) {
  switch (args.condition) {
    case "inventory_full":
      return { met: inventorySlotsUsed(snapshot) >= 28, value: inventorySlotsUsed(snapshot) };
    case "inventory_quantity_at_least": {
      const quantity = inventoryQuantity(snapshot, args.inventoryItemName, args.inventoryItemId);
      return { met: quantity >= (args.inventoryQuantityAtLeast ?? 1), value: quantity };
    }
    case "chat_contains": {
      const match = recentMessages(snapshot).find((message: any) =>
        Number(message.capturedAt ?? 0) >= args.startedAt &&
        matchesChatMessage(message, args.chatContains ?? "", args.caseSensitive, args.chatType)
      );
      return { met: Boolean(match), value: match };
    }
    case "entity_gone": {
      const count = visibleEntityCount(snapshot, args.entityType, args.entityName, args.entityId);
      return { met: count === 0, value: count };
    }
    case "location_reached": {
      if (!Number.isFinite(args.worldX) || !Number.isFinite(args.worldY)) {
        return { met: false, value: "worldX/worldY required" };
      }
      const distance = tileDistance(snapshot.state?.location, args.worldX as number, args.worldY as number, args.plane);
      return { met: distance <= (args.radius ?? 1), value: distance };
    }
    case "idle":
      return { met: isPlayerIdle(snapshot.state ?? {}), value: snapshot.state };
    default:
      throw new Error(`Unsupported condition: ${args.condition}`);
  }
}

function cleanUiText(value: unknown): string {
  return String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function compactTarget(target: any) {
  if (!target) {
    return null;
  }
  return {
    id: target.id,
    name: target.name,
    option: target.option,
    worldX: target.worldX,
    worldY: target.worldY,
    plane: target.plane,
    distanceToPlayer: target.distanceToPlayer,
    coordinateSource: target.coordinateSource,
    screenX: target.screenX,
    screenY: target.screenY,
    ageMs: target.ageMs,
  };
}

async function validatePreparedStep(baseURL: string, snapshot: RuneLiteSnapshot, step: any, args: {
  dryRunRawActions?: boolean;
  maxAgeMs?: number;
}) {
  const maxAgeMs = Math.max(100, args.maxAgeMs ?? 1200);
  if (!step || typeof step.tool !== "string") {
    return {
      valid: false,
      willExecute: false,
      reason: "Step is missing a tool name.",
    };
  }

  const tool = step.tool;
  const stepArgs = step.arguments ?? {};
  const base = {
    tool,
    willExecute: false,
    step,
  };

  if (["get_agent_context", "diagnose_runtime", "mark_action_baseline", "verify_last_action", "verify_after_action", "wait_until_idle", "wait_for_game_tick"].includes(tool)) {
    return {
      ...base,
      valid: true,
      validationMode: "non_gameplay_or_verification_step",
      reason: "This step is safe to run as a read, wait, baseline, or verification helper.",
    };
  }

  if (tool === "invoke_menu_action") {
    if (args.dryRunRawActions === false) {
      return { ...base, valid: false, validationMode: "raw_action_requires_dry_run", reason: "Raw menu action validation requires dryRunRawActions=true." };
    }
    const dryRun = await invokeMenuAction(baseURL, { ...stepArgs, dryRun: true, tickAligned: false });
    return { ...base, valid: dryRun?.success === true && dryRun?.dryRun === true, validationMode: "client_thread_dry_run", dryRun };
  }

  if (tool === "invoke_walk_action") {
    if (args.dryRunRawActions === false) {
      return { ...base, valid: false, validationMode: "raw_action_requires_dry_run", reason: "Raw walk action validation requires dryRunRawActions=true." };
    }
    const dryRun = await invokeWalkAction(baseURL, { ...stepArgs, dryRun: true, tickAligned: false });
    return { ...base, valid: dryRun?.success === true && dryRun?.dryRun === true, validationMode: "client_thread_dry_run", dryRun };
  }

  if (tool === "invoke_widget_action") {
    if (args.dryRunRawActions === false) {
      return { ...base, valid: false, validationMode: "raw_action_requires_dry_run", reason: "Raw widget action validation requires dryRunRawActions=true." };
    }
    const dryRun = await invokeWidgetAction(baseURL, { ...stepArgs, dryRun: true, tickAligned: false });
    return { ...base, valid: dryRun?.success === true && dryRun?.dryRun === true, validationMode: "client_thread_dry_run", dryRun };
  }

  if (tool === "interact_with" || tool === "click_object" || tool === "click_npc" || tool === "click_ground_item") {
    const entityType = stepArgs.entityType ??
      (tool === "click_object" ? "object" : tool === "click_npc" ? "npc" : tool === "click_ground_item" ? "ground_item" : undefined);
    const target = entityType
      ? selectLiveTarget(snapshot, entityType, stepArgs.name, stepArgs.id, stepArgs.nearestToPlayer ?? true)
      : undefined;
    const fresh = Boolean(target && (!target.ageMs || target.ageMs <= maxAgeMs));
    return {
      ...base,
      valid: Boolean(target) && fresh,
      validationMode: "fresh_target_snapshot",
      reason: target ? (fresh ? "Matching live target is present and fresh." : "Matching target exists but is stale.") : "No matching target is currently visible in the snapshot.",
      target: compactTarget(target),
    };
  }

  if (tool === "perform_until") {
    const target = selectLiveTarget(snapshot, stepArgs.actionEntityType, stepArgs.actionName, stepArgs.actionId, stepArgs.nearestToPlayer ?? true);
    const fresh = Boolean(target && (!target.ageMs || target.ageMs <= maxAgeMs));
    const currentCondition = conditionMet(snapshot, {
      condition: stepArgs.condition,
      startedAt: Date.now(),
      inventoryItemName: stepArgs.inventoryItemName,
      inventoryItemId: stepArgs.inventoryItemId,
      inventoryQuantityAtLeast: stepArgs.inventoryQuantityAtLeast,
      chatContains: stepArgs.chatContains,
      chatType: stepArgs.chatType,
      caseSensitive: stepArgs.caseSensitive,
      entityType: stepArgs.entityType,
      entityName: stepArgs.entityName,
      entityId: stepArgs.entityId,
      worldX: stepArgs.worldX,
      worldY: stepArgs.worldY,
      plane: stepArgs.plane,
      radius: stepArgs.radius,
    });
    return {
      ...base,
      valid: Boolean(target) && fresh,
      validationMode: "loop_target_and_condition_snapshot",
      reason: target ? (fresh ? "Loop target is present and fresh." : "Loop target exists but is stale.") : "No matching loop action target is currently visible.",
      target: compactTarget(target),
      currentCondition,
    };
  }

  if (tool === "handle_dialogue") {
    const dialogueType = snapshot.interfaceSummary?.dialogueType ?? snapshot.dialogue?.type ?? "NONE";
    return {
      ...base,
      valid: Boolean(dialogueType && dialogueType !== "NONE"),
      validationMode: "dialogue_snapshot",
      dialogueType,
      reason: dialogueType && dialogueType !== "NONE" ? "Dialogue/interface is currently open." : "No dialogue is currently open.",
    };
  }

  if (tool === "eat_food_when") {
    const item = findFoodItem(snapshot, stepArgs.foodNames, stepArgs.foodName, stepArgs.foodId, stepArgs.slot);
    const foodItem: any = item;
    return {
      ...base,
      valid: Boolean(item),
      validationMode: "inventory_food_snapshot",
      item: foodItem ? { id: foodItem.id, name: foodItem.name, slot: foodItem.slot, quantity: foodItem.quantity } : null,
      reason: item ? "Food is available in inventory." : "No matching food item is available in inventory.",
    };
  }

  if (tool === "deposit_inventory_item" || tool === "withdraw_bank_item") {
    const bankOpen = snapshot.interfaceSummary?.bankContainerAvailable === true;
    const collection = tool === "deposit_inventory_item" ? snapshot.inventory ?? [] : snapshot.bank ?? [];
    const itemNeedle = String(stepArgs.itemName ?? "").toLowerCase();
    const match = collection.find((item: any) =>
      (stepArgs.itemId === undefined || item.id === stepArgs.itemId) &&
      (!itemNeedle || String(item.name ?? "").toLowerCase().includes(itemNeedle))
    ) as any;
    return {
      ...base,
      valid: bankOpen && Boolean(match),
      validationMode: "bank_interface_snapshot",
      bankOpen,
      item: match ? { id: match.id, name: match.name, slot: match.slot, quantity: match.quantity } : null,
      reason: !bankOpen ? "Bank interface is not open." : match ? "Matching bank/inventory item is present." : "No matching item is present for the bank action.",
    };
  }

  return {
    ...base,
    valid: false,
    validationMode: "unsupported_step_validation",
    reason: `No safe validator is registered for tool ${tool}.`,
  };
}

// --- State Reading Tools ---

server.tool(
  "get_agent_context",
  "Get one compact observe-plan-act context bundle: runtime freshness, player status, risks, inventory, nearby entities, dialogue, chat, and recommended next checks.",
  {
    objective: z.string().optional().describe("Optional current user objective, included in the response for continuity"),
    includeNearbyLimit: z.number().optional().describe("Maximum nearby NPC/object/ground-item entries per category, default 8"),
    includeInventoryLimit: z.number().optional().describe("Maximum inventory entries to include, default 28"),
    includeDiagnostics: z.boolean().optional().describe("Run runtime endpoint/feature diagnostics, default true"),
    ...clientTargetSchema(),
  },
  async ({ objective, includeNearbyLimit, includeInventoryLimit, includeDiagnostics, instanceId, playerName, port }) => {
    try {
      const clients = await discoverClients();
      if (clients.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "NO_CLIENT",
              selectedBaseUrl: selectedRuneliteApi,
              message: "No active RuneLite MCP plugin clients were discovered on ports 8080-8090.",
              recommendedNext: ["Start RuneLite with the OSRS MCP plugin loaded, then run diagnose_runtime."],
            }, null, 2)
          }]
        };
      }

      const matches = clients.filter((client: any) =>
        (port !== undefined && client.port === port) ||
        (instanceId && client.instanceId === instanceId) ||
        (playerName && String(client.playerName ?? "").toLowerCase() === playerName.toLowerCase())
      );
      const client = (port !== undefined || instanceId || playerName)
        ? matches[0]
        : clients.find((candidate: any) => candidate.baseUrl === selectedRuneliteApi || candidate.instanceId === selectedClientInstanceId) ?? (clients.length === 1 ? clients[0] : undefined);

      if (!client) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "NEEDS_CLIENT_SELECTION",
              selectedBaseUrl: selectedRuneliteApi,
              clients,
              recommendedNext: ["Use select_client or pass port/instanceId/playerName before acting."],
            }, null, 2)
          }]
        };
      }

      const baseURL = client.baseUrl ?? apiBaseFromPort(client.port);
      const runtime = includeDiagnostics === false
        ? { status: "not_checked" }
        : await diagnoseClientRuntime(client);
      const snapshot = await getSnapshotForBase(baseURL, true);
      const context = buildAgentContext(baseURL, client, snapshot, runtime, {
        objective,
        includeNearbyLimit,
        includeInventoryLimit,
        streamStatus: snapshotStreamStatus(baseURL),
      });
      return { content: [{ type: "text", text: JSON.stringify(context, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("building agent context", e) }] };
    }
  }
);

server.tool(
  "observe_game",
  "Gather a read-only agent observation bundle: compact state, runtime health, optional plan/package, and optional screenshot metadata/image. Never executes gameplay actions.",
  {
    objective: z.string().optional().describe("Optional current gameplay objective to include in the observation and plan"),
    includeDiagnostics: z.boolean().optional().describe("Run runtime endpoint/feature diagnostics, default true"),
    includeNearbyLimit: z.number().optional().describe("Maximum nearby entries per category, default 8"),
    includeInventoryLimit: z.number().optional().describe("Maximum inventory entries to include, default 28"),
    includePlan: z.boolean().optional().describe("Include plan_next_action and prepare_agent_step style output, default true when objective is provided"),
    maxPreviewSteps: z.number().optional().describe("Maximum prepared package plan steps to preview, default 5"),
    includeScreenshot: z.boolean().optional().describe("Capture RuneLite canvas metadata/image for visual perception, default false"),
    includeImage: z.boolean().optional().describe("Include image content when includeScreenshot is true. Defaults to false for lightweight observation."),
    canvasX: z.number().optional().describe("Optional RuneLite canvas-relative X coordinate for a focused screenshot crop"),
    canvasY: z.number().optional().describe("Optional RuneLite canvas-relative Y coordinate for a focused screenshot crop"),
    width: z.number().optional().describe("Optional screenshot crop width, or full canvas when omitted"),
    height: z.number().optional().describe("Optional screenshot crop height, or full canvas when omitted"),
    radius: z.number().optional().describe("Optional screenshot crop radius around canvasX/canvasY, default 140 canvas pixels"),
    forceRefresh: z.boolean().optional().describe("Force a fresh plugin snapshot, default true"),
    ...clientTargetSchema(),
  },
  async ({
    objective,
    includeDiagnostics,
    includeNearbyLimit,
    includeInventoryLimit,
    includePlan,
    maxPreviewSteps,
    includeScreenshot,
    includeImage,
    canvasX,
    canvasY,
    width,
    height,
    radius,
    forceRefresh,
    instanceId,
    playerName,
    port,
  }) => {
    try {
      const clients = await discoverClients();
      if (clients.length === 0) {
        const plan = {
          mode: "start_runtime",
          steps: [actionStep("diagnose_runtime", "No RuneLite MCP plugin client was discovered; start/load RuneLite before gameplay observation.", {}, { priority: "blocker" })],
          notes: ["observe_game is read-only and does not start, close, restart, click, or invoke RuneLite actions."],
        };
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "NO_CLIENT",
              willExecute: false,
              selectedBaseUrl: selectedRuneliteApi,
              clients: [],
              plan: includePlan === false ? undefined : plan,
              package: includePlan === false
                ? undefined
                : buildAgentStepPackage({ status: "NO_CLIENT", readiness: { risks: ["no_client"] } }, plan, objective, maxPreviewSteps ?? 5),
              recommendedNext: ["Start RuneLite with the OSRS MCP plugin loaded, then run diagnose_runtime."],
            }, null, 2)
          }]
        };
      }

      const client = selectDiscoveredClient(clients, { instanceId, playerName, port });
      if (!client) {
        const plan = {
          mode: "select_client",
          steps: [actionStep("select_client", "Multiple RuneLite clients are active; select the intended account/window before acting.", {}, { priority: "blocker" })],
          notes: ["Pass port, instanceId, or playerName to observe_game when multiple clients are open."],
        };
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "NEEDS_CLIENT_SELECTION",
              willExecute: false,
              clients,
              plan: includePlan === false ? undefined : plan,
              package: includePlan === false
                ? undefined
                : buildAgentStepPackage({ status: "NEEDS_CLIENT_SELECTION", readiness: { risks: ["needs_client_selection"] } }, plan, objective, maxPreviewSteps ?? 5),
              recommendedNext: ["Use select_client or pass port/instanceId/playerName before observing for action."],
            }, null, 2)
          }]
        };
      }

      const baseURL = client.baseUrl ?? apiBaseFromPort(client.port);
      const runtime = includeDiagnostics === false
        ? { status: "not_checked" }
        : await diagnoseClientRuntime(client);
      const snapshot = await getSnapshotForBase(baseURL, forceRefresh !== false);
      const context = buildAgentContext(baseURL, client, snapshot, runtime, {
        objective,
        includeNearbyLimit,
        includeInventoryLimit,
        streamStatus: snapshotStreamStatus(baseURL),
      });

      const shouldPlan = includePlan ?? Boolean(objective);
      const plan = shouldPlan ? buildNextActionPlan(context, snapshot, objective) : undefined;
      const stepPackage = shouldPlan
        ? buildAgentStepPackage(context, plan, objective, maxPreviewSteps ?? 5)
        : undefined;

      let screenshot: any;
      if (includeScreenshot) {
        try {
          const capture = await captureCanvasImage(baseURL, {
            canvasX,
            canvasY,
            width,
            height,
            radius,
            includeImage: includeImage ?? false,
          });
          const { base64, ...metadata } = capture;
          screenshot = {
            ...metadata,
            imageIncluded: Boolean(base64),
          };
          const response = {
            objective,
            status: "OBSERVED",
            willExecute: false,
            context,
            plan,
            package: stepPackage,
            screenshot,
            observationRule: "This tool only reads state and optionally captures the visible canvas. Execute any proposed action with a separate tool, then verify afterward.",
          };
          const content: any[] = [{ type: "text", text: JSON.stringify(response, null, 2) }];
          if (base64) {
            content.push({ type: "image", data: base64, mimeType: "image/png" });
          }
          return { content };
        } catch (error: any) {
          screenshot = {
            status: "SCREENSHOT_FAILED",
            error: error?.message ?? String(error),
          };
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            objective,
            status: "OBSERVED",
            willExecute: false,
            context,
            plan,
            package: stepPackage,
            screenshot,
            observationRule: "This tool only reads state. Execute any proposed action with a separate tool, then verify afterward.",
          }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("observing game", e) }] };
    }
  }
);

server.tool(
  "plan_next_action",
  "Plan safe next MCP tool calls for the current objective without executing them. Use this after get_agent_context when you want a conservative action sequence.",
  {
    objective: z.string().describe("Current gameplay objective, for example 'chop 5 normal trees' or 'talk to the nearest banker'"),
    includeDiagnostics: z.boolean().optional().describe("Run runtime endpoint/feature diagnostics before planning, default true"),
    includeNearbyLimit: z.number().optional().describe("Maximum nearby entries to include in the returned context summary, default 6"),
    ...clientTargetSchema(),
  },
  async ({ objective, includeDiagnostics, includeNearbyLimit, instanceId, playerName, port }) => {
    try {
      const clients = await discoverClients();
      if (clients.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "NO_CLIENT",
              plan: {
                mode: "start_runtime",
                steps: [actionStep("diagnose_runtime", "No RuneLite MCP plugin client was discovered; start/load RuneLite before gameplay planning.", {})],
                notes: ["This tool does not start, close, or restart RuneLite."],
              },
            }, null, 2)
          }]
        };
      }

      const matches = clients.filter((client: any) =>
        (port !== undefined && client.port === port) ||
        (instanceId && client.instanceId === instanceId) ||
        (playerName && String(client.playerName ?? "").toLowerCase() === playerName.toLowerCase())
      );
      const client = (port !== undefined || instanceId || playerName)
        ? matches[0]
        : clients.find((candidate: any) => candidate.baseUrl === selectedRuneliteApi || candidate.instanceId === selectedClientInstanceId) ?? (clients.length === 1 ? clients[0] : undefined);

      if (!client) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "NEEDS_CLIENT_SELECTION",
              clients,
              plan: {
                mode: "select_client",
                steps: [actionStep("select_client", "Multiple RuneLite clients are active; select the intended account/window before acting.", {})],
                notes: ["Pass port, instanceId, or playerName to plan_next_action when multiple clients are open."],
              },
            }, null, 2)
          }]
        };
      }

      const baseURL = client.baseUrl ?? apiBaseFromPort(client.port);
      const runtime = includeDiagnostics === false
        ? { status: "not_checked" }
        : await diagnoseClientRuntime(client);
      const snapshot = await getSnapshotForBase(baseURL, true);
      const context = buildAgentContext(baseURL, client, snapshot, runtime, {
        objective,
        includeNearbyLimit: includeNearbyLimit ?? 6,
        includeInventoryLimit: 12,
        streamStatus: snapshotStreamStatus(baseURL),
      });
      const plan = buildNextActionPlan(context, snapshot, objective);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            objective,
            status: "PLANNED",
            context,
            plan,
            executionRule: "Do not execute blindly: run mark_action_baseline before risky actions, prefer the listed in-client action tools, then verify_last_action or verify_after_action.",
          }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("planning next action", e) }] };
    }
  }
);

server.tool(
  "prepare_agent_step",
  "Prepare the next observe-plan-act-verify step package for an objective without executing anything. Returns context, plan preview, first action, safety flags, and verification guidance.",
  {
    objective: z.string().describe("Current gameplay objective, for example 'mine 3 iron ore' or 'deposit logs in bank'"),
    includeDiagnostics: z.boolean().optional().describe("Run runtime endpoint/feature diagnostics before preparing the step package, default true"),
    includeNearbyLimit: z.number().optional().describe("Maximum nearby entries to include in context, default 6"),
    maxPreviewSteps: z.number().optional().describe("Maximum plan steps to preview, default 5"),
    ...clientTargetSchema(),
  },
  async ({ objective, includeDiagnostics, includeNearbyLimit, maxPreviewSteps, instanceId, playerName, port }) => {
    try {
      const clients = await discoverClients();
      if (clients.length === 0) {
        const plan = {
          mode: "start_runtime",
          steps: [actionStep("diagnose_runtime", "No RuneLite MCP plugin client was discovered; start/load RuneLite before gameplay preparation.", {}, { priority: "blocker" })],
          notes: ["This tool does not start, close, restart, click, or invoke RuneLite actions."],
        };
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "NO_CLIENT",
              package: buildAgentStepPackage({ status: "NO_CLIENT", readiness: { risks: ["no_client"] } }, plan, objective, maxPreviewSteps ?? 5),
            }, null, 2)
          }]
        };
      }

      const matches = clients.filter((client: any) =>
        (port !== undefined && client.port === port) ||
        (instanceId && client.instanceId === instanceId) ||
        (playerName && String(client.playerName ?? "").toLowerCase() === playerName.toLowerCase())
      );
      const client = (port !== undefined || instanceId || playerName)
        ? matches[0]
        : clients.find((candidate: any) => candidate.baseUrl === selectedRuneliteApi || candidate.instanceId === selectedClientInstanceId) ?? (clients.length === 1 ? clients[0] : undefined);

      if (!client) {
        const plan = {
          mode: "select_client",
          steps: [actionStep("select_client", "Multiple RuneLite clients are active; select the intended account/window before acting.", {}, { priority: "blocker" })],
          notes: ["Pass port, instanceId, or playerName to prepare_agent_step when multiple clients are open."],
        };
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "NEEDS_CLIENT_SELECTION",
              clients,
              package: buildAgentStepPackage({ status: "NEEDS_CLIENT_SELECTION", readiness: { risks: ["needs_client_selection"] } }, plan, objective, maxPreviewSteps ?? 5),
            }, null, 2)
          }]
        };
      }

      const baseURL = client.baseUrl ?? apiBaseFromPort(client.port);
      const runtime = includeDiagnostics === false
        ? { status: "not_checked" }
        : await diagnoseClientRuntime(client);
      const snapshot = await getSnapshotForBase(baseURL, true);
      const context = buildAgentContext(baseURL, client, snapshot, runtime, {
        objective,
        includeNearbyLimit: includeNearbyLimit ?? 6,
        includeInventoryLimit: 12,
        streamStatus: snapshotStreamStatus(baseURL),
      });
      const plan = buildNextActionPlan(context, snapshot, objective);
      const stepPackage = buildAgentStepPackage(context, plan, objective, maxPreviewSteps ?? 5);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            objective,
            status: "PREPARED",
            context,
            plan,
            package: stepPackage,
            executionRule: "This tool never executes. Before any real action, confirm the context is still current, baseline when recommended, prefer dry-run for raw invoke_* params, then verify afterward.",
          }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("preparing agent step", e) }] };
    }
  }
);

server.tool(
  "validate_prepared_step",
  "Validate a prepared next step against the current RuneLite state without executing it. Raw invoke_* actions are validated with dryRun by default.",
  {
    objective: z.string().optional().describe("Optional objective used to prepare a step when step is omitted"),
    step: z.any().optional().describe("A step object from prepare_agent_step.package.nextStep/firstAction or plan_next_action.plan.steps[]"),
    useFirstActionWhenPreparing: z.boolean().optional().describe("When step is omitted, validate the first real action from the prepared package instead of the next step, default true"),
    dryRunRawActions: z.boolean().optional().describe("Validate raw invoke_* actions by posting dryRun:true to the plugin, default true"),
    includeDiagnostics: z.boolean().optional().describe("Run runtime diagnostics when preparing from objective, default true"),
    includeNearbyLimit: z.number().optional().describe("Nearby entries to include when preparing from objective, default 6"),
    maxAgeMs: z.number().optional().describe("Maximum target age accepted for snapshot target validators, default 1200"),
    ...clientTargetSchema(),
  },
  async ({ objective, step, useFirstActionWhenPreparing, dryRunRawActions, includeDiagnostics, includeNearbyLimit, maxAgeMs, instanceId, playerName, port }) => {
    try {
      const clients = await discoverClients();
      if (clients.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "NO_CLIENT",
              valid: false,
              willExecute: false,
              reason: "No active RuneLite MCP plugin clients were discovered on ports 8080-8090.",
            }, null, 2)
          }]
        };
      }

      const matches = clients.filter((client: any) =>
        (port !== undefined && client.port === port) ||
        (instanceId && client.instanceId === instanceId) ||
        (playerName && String(client.playerName ?? "").toLowerCase() === playerName.toLowerCase())
      );
      const client = (port !== undefined || instanceId || playerName)
        ? matches[0]
        : clients.find((candidate: any) => candidate.baseUrl === selectedRuneliteApi || candidate.instanceId === selectedClientInstanceId) ?? (clients.length === 1 ? clients[0] : undefined);

      if (!client) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "NEEDS_CLIENT_SELECTION",
              valid: false,
              willExecute: false,
              clients,
              reason: "Use select_client or pass port/instanceId/playerName before validating a step.",
            }, null, 2)
          }]
        };
      }

      const baseURL = client.baseUrl ?? apiBaseFromPort(client.port);
      const runtime = includeDiagnostics === false
        ? { status: "not_checked" }
        : await diagnoseClientRuntime(client);
      const snapshot = await getSnapshotForBase(baseURL, true);
      const context = buildAgentContext(baseURL, client, snapshot, runtime, {
        objective,
        includeNearbyLimit: includeNearbyLimit ?? 6,
        includeInventoryLimit: 12,
        streamStatus: snapshotStreamStatus(baseURL),
      });

      let stepToValidate = step;
      let preparedPackage: any = null;
      let plan: any = null;
      if (!stepToValidate) {
        plan = buildNextActionPlan(context, snapshot, objective);
        preparedPackage = buildAgentStepPackage(context, plan, objective, 5);
        stepToValidate = (useFirstActionWhenPreparing ?? true)
          ? preparedPackage.firstAction ?? preparedPackage.nextStep
          : preparedPackage.nextStep;
      }

      const validation = await validatePreparedStep(baseURL, snapshot, stepToValidate, {
        dryRunRawActions: dryRunRawActions ?? true,
        maxAgeMs,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            objective,
            status: "VALIDATED",
            context,
            preparedPackage,
            plan,
            validation,
            executionRule: "This tool never executes real gameplay actions. A valid result only means the step is current enough to consider; execute separately and verify afterward.",
          }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("validating prepared step", e) }] };
    }
  }
);

server.tool(
  "run_agent_cycle",
  "Run one safe observe-plan-validate cycle for an objective without executing the chosen action. This is the control-loop primitive to call before any real play step.",
  {
    objective: z.string().describe("Current gameplay objective, for example 'chop 5 normal trees' or 'deposit logs in bank'"),
    stepChoice: z.enum(["firstAction", "nextStep"]).optional().describe("Which prepared step to validate. Defaults to firstAction when available."),
    includeDiagnostics: z.boolean().optional().describe("Run runtime endpoint/feature diagnostics, default true"),
    includeNearbyLimit: z.number().optional().describe("Maximum nearby entries to include in context, default 8"),
    includeInventoryLimit: z.number().optional().describe("Maximum inventory entries to include, default 28"),
    maxPreviewSteps: z.number().optional().describe("Maximum prepared package plan steps to preview, default 5"),
    dryRunRawActions: z.boolean().optional().describe("Validate raw invoke_* actions with plugin dryRun, default true"),
    maxAgeMs: z.number().optional().describe("Maximum target age accepted by snapshot target validators, default 1200"),
    includeScreenshot: z.boolean().optional().describe("Capture RuneLite canvas metadata/image with the cycle, default false"),
    includeImage: z.boolean().optional().describe("Include image content when includeScreenshot is true. Defaults to false."),
    canvasX: z.number().optional().describe("Optional RuneLite canvas-relative X coordinate for a focused screenshot crop"),
    canvasY: z.number().optional().describe("Optional RuneLite canvas-relative Y coordinate for a focused screenshot crop"),
    width: z.number().optional().describe("Optional screenshot crop width, or full canvas when omitted"),
    height: z.number().optional().describe("Optional screenshot crop height, or full canvas when omitted"),
    radius: z.number().optional().describe("Optional screenshot crop radius around canvasX/canvasY, default 140 canvas pixels"),
    ...clientTargetSchema(),
  },
  async ({
    objective,
    stepChoice,
    includeDiagnostics,
    includeNearbyLimit,
    includeInventoryLimit,
    maxPreviewSteps,
    dryRunRawActions,
    maxAgeMs,
    includeScreenshot,
    includeImage,
    canvasX,
    canvasY,
    width,
    height,
    radius,
    instanceId,
    playerName,
    port,
  }) => {
    try {
      const clients = await discoverClients();
      if (clients.length === 0) {
        const plan = {
          mode: "start_runtime",
          steps: [actionStep("diagnose_runtime", "No RuneLite MCP plugin client was discovered; start/load RuneLite before running an agent cycle.", {}, { priority: "blocker" })],
          notes: ["run_agent_cycle is read-only and does not start, close, restart, click, or invoke RuneLite actions."],
        };
        const stepPackage = buildAgentStepPackage({ status: "NO_CLIENT", readiness: { risks: ["no_client"] } }, plan, objective, maxPreviewSteps ?? 5);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "NO_CLIENT",
              willExecute: false,
              plan,
              package: stepPackage,
              selectedStep: null,
              validation: { valid: false, willExecute: false, reason: "No active RuneLite MCP plugin client was discovered." },
              nextInstruction: "Start/load RuneLite with the OSRS MCP plugin, then run diagnose_runtime.",
            }, null, 2)
          }]
        };
      }

      const client = selectDiscoveredClient(clients, { instanceId, playerName, port });
      if (!client) {
        const plan = {
          mode: "select_client",
          steps: [actionStep("select_client", "Multiple RuneLite clients are active; select the intended account/window before acting.", {}, { priority: "blocker" })],
          notes: ["Pass port, instanceId, or playerName to run_agent_cycle when multiple clients are open."],
        };
        const stepPackage = buildAgentStepPackage({ status: "NEEDS_CLIENT_SELECTION", readiness: { risks: ["needs_client_selection"] } }, plan, objective, maxPreviewSteps ?? 5);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "NEEDS_CLIENT_SELECTION",
              willExecute: false,
              clients,
              plan,
              package: stepPackage,
              selectedStep: null,
              validation: { valid: false, willExecute: false, reason: "Select the intended RuneLite client before validating a gameplay step." },
              nextInstruction: "Use select_client or pass port/instanceId/playerName.",
            }, null, 2)
          }]
        };
      }

      const baseURL = client.baseUrl ?? apiBaseFromPort(client.port);
      const runtime = includeDiagnostics === false
        ? { status: "not_checked" }
        : await diagnoseClientRuntime(client);
      const snapshot = await getSnapshotForBase(baseURL, true);
      const context = buildAgentContext(baseURL, client, snapshot, runtime, {
        objective,
        includeNearbyLimit,
        includeInventoryLimit,
        streamStatus: snapshotStreamStatus(baseURL),
      });
      const plan = buildNextActionPlan(context, snapshot, objective);
      const stepPackage = buildAgentStepPackage(context, plan, objective, maxPreviewSteps ?? 5);
      const selectedStep = stepChoice === "nextStep"
        ? stepPackage.nextStep
        : stepPackage.firstAction ?? stepPackage.nextStep;
      const validation = selectedStep
        ? await validatePreparedStep(baseURL, snapshot, selectedStep, {
          dryRunRawActions: dryRunRawActions ?? true,
          maxAgeMs,
        })
        : {
          valid: false,
          willExecute: false,
          reason: "No step was selected by the planner.",
        };

      let screenshot: any;
      let screenshotBase64: string | undefined;
      if (includeScreenshot) {
        try {
          const capture = await captureCanvasImage(baseURL, {
            canvasX,
            canvasY,
            width,
            height,
            radius,
            includeImage: includeImage ?? false,
          });
          const { base64, ...metadata } = capture;
          screenshotBase64 = base64;
          screenshot = { ...metadata, imageIncluded: Boolean(base64) };
        } catch (error: any) {
          screenshot = {
            status: "SCREENSHOT_FAILED",
            error: error?.message ?? String(error),
          };
        }
      }

      const response = {
        objective,
        status: validation.valid ? "CYCLE_READY" : "CYCLE_BLOCKED",
        willExecute: false,
        context,
        plan,
        package: stepPackage,
        selectedStep,
        validation,
        screenshot,
        nextInstruction: validation.valid
          ? "If the user explicitly approves execution, run the selectedStep with its normal MCP tool and verify afterward."
          : "Do not execute. Refresh observation or resolve the validation reason first.",
        executionRule: "run_agent_cycle never executes gameplay actions. It only observes, plans, and validates the selected step.",
      };
      const content: any[] = [{ type: "text", text: JSON.stringify(response, null, 2) }];
      if (screenshotBase64) {
        content.push({ type: "image", data: screenshotBase64, mimeType: "image/png" });
      }
      return { content };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("running agent cycle", e) }] };
    }
  }
);

server.tool("get_game_state", "Get current player state, location, and health", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.state ?? {}, null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching state", e) }] };
  }
});

server.tool("get_inventory", "Get the items currently in the player's inventory", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.inventory ?? [], null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching inventory", e) }] };
  }
});

server.tool("get_npcs", "Get a list of nearby NPCs with canvas coordinates and absolute desktop screen coordinates", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.npcs ?? [], null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching NPCs", e) }] };
  }
});

server.tool("get_dialogue", "Check for open NPC dialogues, player dialogues, or dialogue options with absolute desktop screen coordinates when clickable", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.dialogue ?? {}, null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching dialogue", e) }] };
  }
});

server.tool("get_game_objects", "Get a list of interactable game objects (trees, doors, rocks) with names and absolute desktop screen coordinates", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.objects ?? [], null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching game objects", e) }] };
  }
});

server.tool("get_ground_items", "Get a list of items dropped on the ground with names and absolute desktop screen coordinates", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.groundItems ?? [], null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching ground items", e) }] };
  }
});

server.tool("get_players", "Get visible players with combat level, location, animation/interacting state, and screen coordinates when available", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.players ?? [], null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching players", e) }] };
  }
});

server.tool("get_bank", "Get all items currently in the player's bank (if the bank interface is open)", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.bank ?? [], null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching bank", e) }] };
  }
});

server.tool(
  "get_bank_actions",
  "Read visible bank Withdraw and Deposit widgets with click-ready widget coordinates when the bank interface is open.",
  {
    ...clientTargetSchema(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const res = await (await apiForTarget({ instanceId, playerName, port })).get("/bank_actions");
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching bank actions", e) }] };
    }
  }
);

server.tool("get_equipment", "Get all items currently equipped by the player", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.equipment ?? [], null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching equipment", e) }] };
  }
});

server.tool("get_skills", "Get the player's level, boosted level, and XP for all 23 skills", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.skills ?? {}, null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching skills", e) }] };
  }
});

server.tool("get_interface_summary", "Get compact open-interface and high-value visible widget state from the latest cached snapshot", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.interfaceSummary ?? {}, null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching interface summary", e) }] };
  }
});

server.tool(
  "get_widgets",
  "Inspect a bounded set of RuneLite widgets with ids, text, actions, bounds, and screen coordinates. Use filter for complex interfaces like bank, GE, quest, shop, or dialogue.",
  {
    filter: z.string().optional().describe("Optional case-insensitive text/name/action/id filter, for example withdraw, deposit, exchange, quest, continue, or an id substring"),
    includeHidden: z.boolean().optional().describe("Include hidden widgets. Defaults to false."),
    maxWidgets: z.number().optional().describe("Maximum widgets to return, default 250, capped by the plugin at 1000."),
    maxDepth: z.number().optional().describe("Maximum widget tree depth to inspect, default 6, capped by the plugin at 12."),
    ...clientTargetSchema(),
  },
  async ({ filter, includeHidden, maxWidgets, maxDepth, instanceId, playerName, port }) => {
    try {
      const res = await (await apiForTarget({ instanceId, playerName, port })).get("/widgets", {
        params: { filter, includeHidden, maxWidgets, maxDepth },
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching widgets", e) }] };
    }
  }
);

server.tool("get_coordinate_debug", "Get RuneLite canvas origin, canvas size, DPI transform, mouse position, and player coordinate debug data", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const res = await (await apiForTarget({ instanceId, playerName, port })).get("/debug/coordinates");
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching coordinate debug", e) }] };
  }
});

server.tool(
  "capture_canvas_screenshot",
  "Capture the current RuneLite canvas, or a crop around canvasX/canvasY, as a PNG for visual verification before/after actions.",
  {
    ...clientTargetSchema(),
    canvasX: z.number().optional().describe("Optional RuneLite canvas-relative X coordinate. With canvasY, captures a crop around this point."),
    canvasY: z.number().optional().describe("Optional RuneLite canvas-relative Y coordinate. With canvasX, captures a crop around this point."),
    width: z.number().optional().describe("Optional canvas-relative crop width. Used with canvasX/canvasY as the top-left if radius is omitted."),
    height: z.number().optional().describe("Optional canvas-relative crop height. Used with canvasX/canvasY as the top-left if radius is omitted."),
    radius: z.number().optional().describe("Optional crop radius around canvasX/canvasY, default 140 canvas pixels."),
    includeImage: z.boolean().optional().describe("Include base64 image content in the MCP response. Defaults to true."),
  },
  async ({ canvasX, canvasY, width, height, radius, includeImage, instanceId, playerName, port }) => {
    try {
      const baseURL = await resolveRuneliteApi({ instanceId, playerName, port });
      const result = await captureCanvasImage(baseURL, { canvasX, canvasY, width, height, radius, includeImage });
      const { base64, ...metadata } = result;
      const content: any[] = [
        { type: "text", text: JSON.stringify(metadata, null, 2) },
      ];
      if (base64) {
        content.push({ type: "image", data: base64, mimeType: "image/png" });
      }
      return { content };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("capturing RuneLite canvas", e) }] };
    }
  }
);

server.tool(
  "get_screenshot",
  "Capture the current RuneLite canvas as a PNG image or metadata-only screenshot result. Alias-friendly perception tool for agents.",
  {
    ...clientTargetSchema(),
    canvasX: z.number().optional().describe("Optional RuneLite canvas-relative X coordinate. With canvasY, captures a crop around this point."),
    canvasY: z.number().optional().describe("Optional RuneLite canvas-relative Y coordinate. With canvasX, captures a crop around this point."),
    width: z.number().optional().describe("Optional canvas-relative crop width. Used with canvasX/canvasY as the top-left if radius is omitted."),
    height: z.number().optional().describe("Optional canvas-relative crop height. Used with canvasX/canvasY as the top-left if radius is omitted."),
    radius: z.number().optional().describe("Optional crop radius around canvasX/canvasY, default 140 canvas pixels."),
    includeImage: z.boolean().optional().describe("Include image content in the MCP response. Set false for lightweight smoke checks. Defaults to true."),
  },
  async ({ canvasX, canvasY, width, height, radius, includeImage, instanceId, playerName, port }) => {
    try {
      const baseURL = await resolveRuneliteApi({ instanceId, playerName, port });
      const result = await captureCanvasImage(baseURL, { canvasX, canvasY, width, height, radius, includeImage });
      const { base64, ...metadata } = result;
      const content: any[] = [
        { type: "text", text: JSON.stringify({ ...metadata, imageIncluded: Boolean(base64) }, null, 2) },
      ];
      if (base64) {
        content.push({ type: "image", data: base64, mimeType: "image/png" });
      }
      return { content };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("capturing RuneLite screenshot", e) }] };
    }
  }
);

server.tool(
  "get_latest_snapshot",
  "Get the latest cached RuneLite snapshot with state, NPCs, dialogue, objects, ground items, tick, capturedAt, and ageMs.",
  {
    ...clientTargetSchema(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port }, true);
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching latest snapshot", e) }] };
    }
  }
);

server.tool(
  "get_player_location",
  "Get the current player name, world location, health, run energy, tick, capturedAt, and ageMs.",
  {
    ...clientTargetSchema(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot.state ?? {}, null, 2) }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching player location", e) }] };
    }
  }
);

server.tool(
  "find_nearest_object",
  "Refresh object data and return the nearest matching object without clicking.",
  {
    name: z.string().optional().describe("Object name, for example Tree"),
    id: z.number().optional().describe("Object ID"),
    requireClickable: z.boolean().optional().describe("Only return objects with screenX/screenY"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 1000"),
    ...clientTargetSchema(),
  },
  async ({ name, id, requireClickable, maxAgeMs, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { snapshot } = await getSnapshotForTarget(targetClient, true);
      const objects = snapshot.objects ?? [];
      const playerLocation = snapshot.state?.location;
      const matches = sortNearestToPlayer(
        sortByDistance(objects.filter((object: any) => targetMatches(object, name, id))),
        playerLocation
      ).filter((object) => freshEnough(object, maxAgeMs ?? 1000))
        .filter((object) => !requireClickable || hasScreenPoint(object));
      return { content: [{ type: "text", text: formatTarget(matches[0]) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("finding nearest object", e) }] };
    }
  }
);

server.tool(
  "find_nearest_npc",
  "Refresh NPC data and return the nearest matching NPC without clicking.",
  {
    name: z.string().optional().describe("NPC name"),
    id: z.number().optional().describe("NPC ID"),
    requireClickable: z.boolean().optional().describe("Only return NPCs with screenX/screenY"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 1000"),
    ...clientTargetSchema(),
  },
  async ({ name, id, requireClickable, maxAgeMs, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { snapshot } = await getSnapshotForTarget(targetClient, true);
      const npcs = snapshot.npcs ?? [];
      const playerLocation = snapshot.state?.location;
      const matches = sortNearestToPlayer(
        sortByDistance(npcs.filter((npc: any) => targetMatches(npc, name, id))),
        playerLocation
      ).filter((npc) => freshEnough(npc, maxAgeMs ?? 1000))
        .filter((npc) => !requireClickable || hasScreenPoint(npc));
      return { content: [{ type: "text", text: formatTarget(matches[0]) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("finding nearest NPC", e) }] };
    }
  }
);

server.tool(
  "find_nearest_ground_item",
  "Refresh ground-item data and return the nearest matching item without clicking.",
  {
    name: z.string().optional().describe("Ground item name"),
    id: z.number().optional().describe("Item ID"),
    requireClickable: z.boolean().optional().describe("Only return items with screenX/screenY"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 1000"),
    ...clientTargetSchema(),
  },
  async ({ name, id, requireClickable, maxAgeMs, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { snapshot } = await getSnapshotForTarget(targetClient, true);
      const items = snapshot.groundItems ?? [];
      const playerLocation = snapshot.state?.location;
      const matches = sortNearestToPlayer(
        sortByDistance(items.filter((item: any) => targetMatches(item, name, id))),
        playerLocation
      ).filter((item) => freshEnough(item, maxAgeMs ?? 1000))
        .filter((item) => !requireClickable || hasScreenPoint(item));
      return { content: [{ type: "text", text: formatTarget(matches[0]) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("finding nearest ground item", e) }] };
    }
  }
);

server.tool(
  "verify_target_visible",
  "Refresh the latest snapshot and verify a matching entity is visible, fresh, click-ready, and from the expected coordinate source without clicking.",
  {
    entityType: z.string().describe("npc, object, ground_item, or player"),
    name: z.string().optional().describe("Entity name"),
    id: z.number().optional().describe("Entity ID where available"),
    nearestToPlayer: z.boolean().optional().describe("Prefer nearest matching entity to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    coordinateSource: z.string().optional().describe("Optional required coordinateSource, for example clickbox or convexHull"),
    ...clientTargetSchema(),
  },
  async ({ entityType, name, id, nearestToPlayer, maxAgeMs, coordinateSource, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const items = targetsForType(snapshot, entityType).filter((item: any) => targetMatches(item, name, id));
      const sorted = sortNearestToPlayer(sortByDistance(items), nearestToPlayer ? snapshot.state?.location : null);
      const target = coordinateSource
        ? sorted.find((item) => item.coordinateSource === coordinateSource && hasScreenPoint(item))
        : sorted.find((item) => hasScreenPoint(item));
      requireFreshClickable(target, maxAgeMs ?? 600, coordinateSource);
      return { content: [{ type: "text", text: JSON.stringify({ visible: true, target }, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: JSON.stringify({ visible: false, error: e.message }, null, 2) }] };
    }
  }
);

server.tool(
  "get_vars",
  "Read selected RuneLite varbit and varp values for quest/state checks without dumping every game variable.",
  {
    varbits: z.array(z.number()).optional().describe("Varbit IDs to read"),
    varps: z.array(z.number()).optional().describe("VarPlayer/varp IDs to read"),
    ...clientTargetSchema(),
  },
  async ({ varbits, varps, instanceId, playerName, port }) => {
    try {
      const api = await apiForTarget({ instanceId, playerName, port });
      const res = await api.get("/vars", { params: { varbits: (varbits ?? []).join(","), varps: (varps ?? []).join(",") } });
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching vars", e) }] };
    }
  }
);

server.tool(
  "get_quest_state",
  "Read RuneLite quest state by quest name, enum name, or id. Omit name to list all quest states.",
  {
    name: z.string().optional().describe("Quest name or enum name, for example Cook's Assistant or COOKS_ASSISTANT"),
    id: z.number().optional().describe("RuneLite quest id"),
    ...clientTargetSchema(),
  },
  async ({ name, id, instanceId, playerName, port }) => {
    try {
      const res = await (await apiForTarget({ instanceId, playerName, port })).get("/quest_state", {
        params: { name: name ?? id },
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching quest state", e) }] };
    }
  }
);

server.tool(
  "get_prayers",
  "Read prayer level, active prayers, prayer varbits, and prayer/quick-prayer orb coordinates.",
  {
    ...clientTargetSchema(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
      return { content: [{ type: "text", text: JSON.stringify(snapshot.prayers ?? {}, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching prayers", e) }] };
    }
  }
);

server.tool(
  "click_prayer_orb",
  "Click the minimap prayer orb or quick-prayer orb using fresh widget screen coordinates.",
  {
    orb: z.enum(["prayer", "quick_prayer"]).describe("Which orb to click"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
  },
  async ({ orb, rightClick, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const baseURL = await resolveRuneliteApi(targetClient);
      await assertClientReady(baseURL);
      const res = await runeliteApi(baseURL).get("/prayers");
      const label = orb === "quick_prayer" ? "quickPrayerOrb" : "prayerOrb";
      const target = (res.data?.controls ?? []).find((control: any) => control.label === label);
      requireFreshClickable(target, 1000, "widgetBounds");
      await clickPoint(target.screenX, target.screenY, rightClick);
      return { content: [{ type: "text", text: `Clicked ${label} at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error clicking prayer orb: ${e.message}` }] };
    }
  }
);

server.tool(
  "get_combat",
  "Read combat style widgets, auto-retaliate widget, combat tab coordinates, and player combat state.",
  {
    ...clientTargetSchema(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
      return { content: [{ type: "text", text: JSON.stringify(snapshot.combat ?? {}, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching combat controls", e) }] };
    }
  }
);

server.tool(
  "click_combat_style",
  "Click one of the four visible combat style widgets using fresh widget screen coordinates.",
  {
    style: z.number().min(1).max(4).describe("Combat style number 1-4"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
  },
  async ({ style, rightClick, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const baseURL = await resolveRuneliteApi(targetClient);
      await assertClientReady(baseURL);
      const res = await runeliteApi(baseURL).get("/combat");
      const target = (res.data?.controls ?? []).find((control: any) => control.label === `style${style}`);
      requireFreshClickable(target, 1000, "widgetBounds");
      await clickPoint(target.screenX, target.screenY, rightClick);
      return { content: [{ type: "text", text: `Clicked combat style ${style} at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error clicking combat style: ${e.message}` }] };
    }
  }
);

server.tool(
  "toggle_auto_retaliate",
  "Click the auto-retaliate combat widget using fresh widget screen coordinates.",
  {
    ...clientTargetSchema(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const baseURL = await resolveRuneliteApi(targetClient);
      await assertClientReady(baseURL);
      const res = await runeliteApi(baseURL).get("/combat");
      const target = (res.data?.controls ?? []).find((control: any) => control.label === "autoRetaliate");
      requireFreshClickable(target, 1000, "widgetBounds");
      await clickPoint(target.screenX, target.screenY);
      return { content: [{ type: "text", text: `Clicked auto-retaliate at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error toggling auto-retaliate: ${e.message}` }] };
    }
  }
);

server.tool(
  "click_special_attack",
  "Click the visible special-attack combat widget using fresh widget screen coordinates when available.",
  {
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
  },
  async ({ rightClick, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const baseURL = await resolveRuneliteApi(targetClient);
      await assertClientReady(baseURL);
      const res = await runeliteApi(baseURL).get("/combat");
      const target = (res.data?.specialAttackWidgets ?? []).find((widget: any) => Number.isFinite(widget.screenX) && Number.isFinite(widget.screenY));
      requireFreshClickable(target, 1000, "widgetBounds");
      await clickPoint(target.screenX, target.screenY, rightClick);
      return { content: [{ type: "text", text: `Clicked special attack at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error clicking special attack: ${e.message}` }] };
    }
  }
);

server.tool(
  "get_shop",
  "Read visible shop/trade action widgets with Buy/Sell actions and click-ready widget coordinates.",
  {
    ...clientTargetSchema(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const res = await (await apiForTarget({ instanceId, playerName, port })).get("/shop");
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching shop", e) }] };
    }
  }
);

server.tool(
  "click_shop_action",
  "Click a visible shop/trade widget whose actions include Buy/Sell text, optionally filtered by item name or item id.",
  {
    actionText: z.string().describe("Action text to match, for example Buy 1, Buy, Sell 5"),
    itemName: z.string().optional().describe("Optional item widget name/text substring"),
    itemId: z.number().optional().describe("Optional item id"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
  },
  async ({ actionText, itemName, itemId, rightClick, instanceId, playerName, port }) => {
    try {
      const target = await clickShopAction(actionText, itemName, itemId, rightClick, { instanceId, playerName, port });
      return { content: [{ type: "text", text: `Clicked shop action at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error clicking shop action: ${e.message}` }] };
    }
  }
);

server.tool(
  "buy_item",
  "Click a visible shop Buy action for an item, optionally filtered by item name or item id.",
  {
    quantity: z.string().optional().describe("Quantity suffix to prefer, for example 1, 5, 10, 50. Omit to match any Buy action."),
    itemName: z.string().optional().describe("Optional item widget name/text substring"),
    itemId: z.number().optional().describe("Optional item id"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
  },
  async ({ quantity, itemName, itemId, rightClick, instanceId, playerName, port }) => {
    try {
      const actionText = quantity ? `Buy ${quantity}` : "Buy";
      const target = await clickShopAction(actionText, itemName, itemId, rightClick, { instanceId, playerName, port });
      return { content: [{ type: "text", text: `Clicked ${actionText} for shop item at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error buying shop item: ${e.message}` }] };
    }
  }
);

server.tool(
  "sell_item",
  "Click a visible shop Sell action for an item, optionally filtered by item name or item id.",
  {
    quantity: z.string().optional().describe("Quantity suffix to prefer, for example 1, 5, 10, 50. Omit to match any Sell action."),
    itemName: z.string().optional().describe("Optional item widget name/text substring"),
    itemId: z.number().optional().describe("Optional item id"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
  },
  async ({ quantity, itemName, itemId, rightClick, instanceId, playerName, port }) => {
    try {
      const actionText = quantity ? `Sell ${quantity}` : "Sell";
      const target = await clickShopAction(actionText, itemName, itemId, rightClick, { instanceId, playerName, port });
      return { content: [{ type: "text", text: `Clicked ${actionText} for shop item at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error selling shop item: ${e.message}` }] };
    }
  }
);

server.tool(
  "get_minimap",
  "Read minimap bounds and optionally project a world tile to minimap screen coordinates.",
  {
    worldX: z.number().optional().describe("Optional target world X tile to project"),
    worldY: z.number().optional().describe("Optional target world Y tile to project"),
    plane: z.number().optional().describe("Optional target plane"),
    ...clientTargetSchema(),
  },
  async ({ worldX, worldY, plane, instanceId, playerName, port }) => {
    try {
      const params = worldX !== undefined && worldY !== undefined ? { worldX, worldY, plane } : undefined;
      const res = await (await apiForTarget({ instanceId, playerName, port })).get("/minimap", { params });
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching minimap", e) }] };
    }
  }
);

server.tool(
  "get_camera",
  "Read RuneLite camera yaw, pitch, position, map angle, minimap zoom, viewport size, and player orientation context.",
  {
    ...clientTargetSchema(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const res = await (await apiForTarget({ instanceId, playerName, port })).get("/camera");
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching camera", e) }] };
    }
  }
);

server.tool(
  "get_context_menu",
  "Read the current RuneLite right-click/context menu entries and row screen coordinates when the menu is open.",
  {
    ...clientTargetSchema(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const res = await (await apiForTarget({ instanceId, playerName, port })).get("/context_menu");
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching context menu", e) }] };
    }
  }
);

server.tool(
  "wait_for_game_tick",
  "Wait until RuneLite reports one or more new 600ms OSRS game ticks. Use before timing-sensitive in-client actions or after an action when tick evidence matters.",
  {
    ticks: z.number().optional().describe("Number of game ticks to wait, default 1"),
    timeoutMs: z.number().optional().describe("Maximum wait time in milliseconds, default 1800"),
    pollMs: z.number().optional().describe("Polling interval in milliseconds, default 75"),
    ...clientTargetSchema(),
  },
  async ({ ticks, timeoutMs, pollMs, instanceId, playerName, port }) => {
    try {
      const baseURL = await resolveRuneliteApi({ instanceId, playerName, port });
      const result = await waitForGameTick(baseURL, ticks ?? 1, timeoutMs ?? 1800, pollMs ?? 75);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("waiting for game tick", e) }] };
    }
  }
);

server.tool(
  "invoke_menu_action",
  "Invoke a RuneLite menu action inside the client on the RuneLite ClientThread. Use params from get_context_menu entries or dryRun first when unsure.",
  {
    param0: z.number().describe("RuneLite menu action param0, usually scene X, widget child id, or slot depending on action type"),
    param1: z.number().describe("RuneLite menu action param1, usually scene Y, widget packed id, or widget id depending on action type"),
    menuAction: z.string().describe("RuneLite MenuAction enum name, for example GAME_OBJECT_FIRST_OPTION, NPC_FIRST_OPTION, WIDGET_TARGET, or WALK"),
    identifier: z.number().optional().describe("RuneLite menu action identifier. If omitted, id is used."),
    id: z.number().optional().describe("Alias for identifier"),
    itemId: z.number().optional().describe("Item ID for item/widget actions, otherwise -1"),
    option: z.string().optional().describe("Menu option text, for example Chop down, Talk-to, Use, Walk here"),
    target: z.string().optional().describe("Menu target text"),
    dryRun: z.boolean().optional().describe("Validate and echo the action without invoking it in-game"),
    tickAligned: z.boolean().optional().describe("Wait for the next OSRS game tick before invoking the action"),
    tickTimeoutMs: z.number().optional().describe("Maximum wait for tickAligned actions in milliseconds, default 1800"),
    ...clientTargetSchema(),
  },
  async ({ param0, param1, menuAction, identifier, id, itemId, option, target, dryRun, tickAligned, tickTimeoutMs, instanceId, playerName, port }) => {
    try {
      const baseURL = await resolveRuneliteApi({ instanceId, playerName, port });
      const result = await invokeMenuAction(baseURL, {
        param0,
        param1,
        menuAction,
        identifier,
        id,
        itemId,
        option,
        target,
        dryRun,
        tickAligned,
        tickTimeoutMs,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("invoking menu action", e) }] };
    }
  }
);

server.tool(
  "invoke_walk_action",
  "Invoke a RuneLite WALK menu action inside the client for a loaded-scene world tile. This is not long-distance pathfinding.",
  {
    worldX: z.number().describe("Target world X tile. Must be in the currently loaded scene."),
    worldY: z.number().describe("Target world Y tile. Must be in the currently loaded scene."),
    plane: z.number().optional().describe("Target plane. Defaults to the client's current plane."),
    dryRun: z.boolean().optional().describe("Validate and echo the walk action without invoking it in-game"),
    tickAligned: z.boolean().optional().describe("Wait for the next OSRS game tick before invoking the walk action"),
    tickTimeoutMs: z.number().optional().describe("Maximum wait for tickAligned actions in milliseconds, default 1800"),
    ...clientTargetSchema(),
  },
  async ({ worldX, worldY, plane, dryRun, tickAligned, tickTimeoutMs, instanceId, playerName, port }) => {
    try {
      const baseURL = await resolveRuneliteApi({ instanceId, playerName, port });
      const result = await invokeWalkAction(baseURL, { worldX, worldY, plane, dryRun, tickAligned, tickTimeoutMs });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("invoking walk action", e) }] };
    }
  }
);

server.tool(
  "invoke_widget_action",
  "Invoke a RuneLite widget menu action inside the client. Prefer raw params from a widget/menu entry; otherwise use packedId or groupId+childId with actionIndex 1-5.",
  {
    packedId: z.number().optional().describe("Packed widget id. Used as param1 when provided."),
    groupId: z.number().optional().describe("Widget group id; combine with childId when packedId is not provided."),
    childId: z.number().optional().describe("Widget child id; combine with groupId when packedId is not provided."),
    param0: z.number().optional().describe("Raw param0 for the widget action. Defaults to 0."),
    param1: z.number().optional().describe("Raw param1/packed widget id. Used if packedId is omitted."),
    actionIndex: z.number().optional().describe("Widget option index 1-5. Defaults to 1 unless menuAction/type is passed."),
    menuAction: z.string().optional().describe("Explicit RuneLite MenuAction enum name for advanced widget actions."),
    type: z.string().optional().describe("Alias for menuAction, useful when passing context menu entry data."),
    identifier: z.number().optional().describe("RuneLite action identifier. Defaults to id or actionIndex."),
    id: z.number().optional().describe("Alias for identifier."),
    itemId: z.number().optional().describe("Item ID for item/widget actions, otherwise -1."),
    option: z.string().optional().describe("Menu option text."),
    target: z.string().optional().describe("Menu target text."),
    dryRun: z.boolean().optional().describe("Validate and echo the widget action without invoking it in-game"),
    tickAligned: z.boolean().optional().describe("Wait for the next OSRS game tick before invoking the widget action"),
    tickTimeoutMs: z.number().optional().describe("Maximum wait for tickAligned actions in milliseconds, default 1800"),
    ...clientTargetSchema(),
  },
  async ({ packedId, groupId, childId, param0, param1, actionIndex, menuAction, type, identifier, id, itemId, option, target, dryRun, tickAligned, tickTimeoutMs, instanceId, playerName, port }) => {
    try {
      const baseURL = await resolveRuneliteApi({ instanceId, playerName, port });
      const result = await invokeWidgetAction(baseURL, {
        packedId,
        groupId,
        childId,
        param0,
        param1,
        actionIndex,
        menuAction,
        type,
        identifier,
        id,
        itemId,
        option,
        target,
        dryRun,
        tickAligned,
        tickTimeoutMs,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("invoking widget action", e) }] };
    }
  }
);

server.tool(
  "open_context_menu_for_target",
  "Right-click a fresh NPC, object, player, or ground item target and return the resulting RuneLite context menu without selecting an option.",
  {
    entityType: z.enum(["npc", "object", "ground_item", "player"]).describe("Target type to right-click"),
    name: z.string().optional().describe("Optional exact target name"),
    id: z.number().optional().describe("Optional target ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching target to the player"),
    coordinateSource: z.string().optional().describe("Required coordinate source. Defaults to clickbox for objects and convexHull for NPCs/players."),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    menuDelayMs: z.number().optional().describe("Delay after right-click before reading the menu, default 150"),
    ...clientTargetSchema(),
  },
  async ({ entityType, name, id, nearestToPlayer, coordinateSource, maxAgeMs, menuDelayMs, instanceId, playerName, port }) => {
    try {
      const result = await openContextMenuForTarget({
        entityType,
        name,
        id,
        nearestToPlayer,
        coordinateSource,
        maxAgeMs,
        menuDelayMs,
        instanceId,
        playerName,
        port
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error opening context menu for target: ${e.message}` }] };
    }
  }
);

server.tool(
  "interact_with",
  "Interact with a fresh NPC, object, player, or ground item by opening its context menu and invoking the selected RuneLite menu action in-client.",
  {
    entityType: z.enum(["npc", "object", "ground_item", "player"]).describe("Target type to interact with"),
    option: z.string().describe("Menu option to select, for example Chop down, Talk-to, Attack, Take, Use, or Open"),
    name: z.string().optional().describe("Optional exact target name"),
    id: z.number().optional().describe("Optional target ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching target to the player"),
    exact: z.boolean().optional().describe("Require an exact option/option+target match instead of substring matching"),
    coordinateSource: z.string().optional().describe("Required coordinate source. Defaults to clickbox for objects and convexHull for NPCs/players."),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    menuDelayMs: z.number().optional().describe("Delay after right-click before reading the menu, default 150"),
    ...clientTargetSchema(),
  },
  async ({ entityType, option, name, id, nearestToPlayer, exact, coordinateSource, maxAgeMs, menuDelayMs, instanceId, playerName, port }) => {
    try {
      const result = await interactWithTarget({
        entityType,
        option,
        name,
        id,
        nearestToPlayer,
        exact,
        coordinateSource,
        maxAgeMs,
        menuDelayMs,
        instanceId,
        playerName,
        port
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error interacting with target: ${e.message}` }] };
    }
  }
);

server.tool(
  "right_click_npc",
  "Right-click a fresh NPC convexHull target and return the resulting RuneLite context menu.",
  {
    name: z.string().optional().describe("NPC name"),
    id: z.number().optional().describe("NPC ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching NPC to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    menuDelayMs: z.number().optional().describe("Delay after right-click before reading the menu, default 150"),
    ...clientTargetSchema(),
  },
  async ({ name, id, nearestToPlayer, maxAgeMs, menuDelayMs, instanceId, playerName, port }) => {
    try {
      const result = await openContextMenuForTarget({ entityType: "npc", name, id, nearestToPlayer, maxAgeMs, menuDelayMs, instanceId, playerName, port });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error right-clicking NPC: ${e.message}` }] };
    }
  }
);

server.tool(
  "right_click_object",
  "Right-click a fresh object clickbox target and return the resulting RuneLite context menu.",
  {
    name: z.string().optional().describe("Object name, for example Tree"),
    id: z.number().optional().describe("Object ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching object to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    menuDelayMs: z.number().optional().describe("Delay after right-click before reading the menu, default 150"),
    ...clientTargetSchema(),
  },
  async ({ name, id, nearestToPlayer, maxAgeMs, menuDelayMs, instanceId, playerName, port }) => {
    try {
      const result = await openContextMenuForTarget({ entityType: "object", name, id, nearestToPlayer, maxAgeMs, menuDelayMs, instanceId, playerName, port });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error right-clicking object: ${e.message}` }] };
    }
  }
);

server.tool(
  "right_click_ground_item",
  "Right-click a fresh ground item target and return the resulting RuneLite context menu.",
  {
    name: z.string().optional().describe("Ground item name"),
    id: z.number().optional().describe("Item ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching item to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    menuDelayMs: z.number().optional().describe("Delay after right-click before reading the menu, default 150"),
    ...clientTargetSchema(),
  },
  async ({ name, id, nearestToPlayer, maxAgeMs, menuDelayMs, instanceId, playerName, port }) => {
    try {
      const result = await openContextMenuForTarget({ entityType: "ground_item", name, id, nearestToPlayer, maxAgeMs, menuDelayMs, instanceId, playerName, port });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error right-clicking ground item: ${e.message}` }] };
    }
  }
);

server.tool(
  "select_option",
  "Select an option from the currently open RuneLite right-click/context menu by visible option text.",
  {
    text: z.string().describe("Visible menu option text, for example Attack, Talk-to, Use, Drop, Deposit-All"),
    exact: z.boolean().optional().describe("Require exact option text instead of substring matching"),
    ...clientTargetSchema(),
  },
  async ({ text, exact, instanceId, playerName, port }) => {
    try {
      const match = await selectContextMenuOption(text, { instanceId, playerName, port }, exact);
      return { content: [{ type: "text", text: `Selected context option ${match.option ?? ""} ${match.target ?? ""}`.trim() }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error selecting context option: ${e.message}` }] };
    }
  }
);

server.tool(
  "walk_to",
  "Walk to a nearby world tile. In auto mode, try an in-client WALK action for loaded-scene tiles before falling back to minimap click.",
  {
    worldX: z.number().describe("Target world X tile"),
    worldY: z.number().describe("Target world Y tile"),
    plane: z.number().optional().describe("Target plane, defaults to 0 if omitted"),
    mode: z.enum(["auto", "client_action", "minimap"]).optional().describe("Action mode. auto tries in-client loaded-scene walk first, then minimap fallback."),
    ...clientTargetSchema(),
  },
  async ({ worldX, worldY, plane, mode, instanceId, playerName, port }) => {
    try {
      if (mode !== "minimap") {
        const baseURL = await resolveRuneliteApi({ instanceId, playerName, port });
        try {
          const result = await invokeWalkAction(baseURL, { worldX, worldY, plane });
          return { content: [{ type: "text", text: JSON.stringify({ mode: "client_action", result }, null, 2) }] };
        } catch (e: any) {
          if (mode === "client_action") {
            throw e;
          }
        }
      }
      const target = await clickMinimapProjection(worldX, worldY, plane, { instanceId, playerName, port });
      return { content: [{ type: "text", text: JSON.stringify({ mode: "minimap", message: `Clicked minimap projection for ${worldX}, ${worldY}, ${plane ?? 0} at ${target.screenX}, ${target.screenY}.`, target }, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error walking to tile: ${e.message}` }] };
    }
  }
);

server.tool(
  "calculate_path_to",
  "Calculate a local-scene collision-aware path to a target world tile without clicking, falling back to bounded straight-line minimap steps when the target is outside the loaded scene.",
  {
    worldX: z.number().describe("Target world X tile"),
    worldY: z.number().describe("Target world Y tile"),
    plane: z.number().optional().describe("Target plane, defaults to the player's current plane"),
    maxStepTiles: z.number().optional().describe("Maximum tiles per minimap step, default 18"),
    maxSteps: z.number().optional().describe("Maximum steps to return, default 12"),
    maxNodes: z.number().optional().describe("Maximum local collision-map nodes to search, default 4096"),
    ...clientTargetSchema(),
  },
  async ({ worldX, worldY, plane, maxStepTiles, maxSteps, maxNodes, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      let collisionPath: LocalPathResult | undefined;
      try {
        collisionPath = await calculateCollisionAwarePath(baseURL, worldX, worldY, plane, maxNodes ?? 4096);
        if (collisionPath.success) {
          return { content: [{ type: "text", text: JSON.stringify(collisionPath, null, 2) }] };
        }
      } catch (error: any) {
        collisionPath = {
          success: false,
          error: "COLLISION_PATH_REQUEST_FAILED",
          message: errorText("requesting collision-aware path", error),
        };
      }

      const fallback = withStraightLineFallback(
        snapshot,
        { worldX, worldY, plane },
        maxStepTiles ?? 18,
        maxSteps ?? 12,
        collisionPath,
      );
      return { content: [{ type: "text", text: JSON.stringify(fallback, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error calculating path: ${e.message}` }] };
    }
  }
);

server.tool(
  "walk_path_to",
  "Walk one bounded step toward a target world tile, preferring local collision-aware in-client walking and falling back to minimap projection when needed.",
  {
    worldX: z.number().describe("Target world X tile"),
    worldY: z.number().describe("Target world Y tile"),
    plane: z.number().optional().describe("Target plane, defaults to the player's current plane"),
    maxStepTiles: z.number().optional().describe("Maximum tiles per minimap step, default 18"),
    maxNodes: z.number().optional().describe("Maximum local collision-map nodes to search, default 4096"),
    maxAgeMs: z.number().optional().describe("Maximum accepted minimap projection age in milliseconds, default 1000"),
    ...clientTargetSchema(),
  },
  async ({ worldX, worldY, plane, maxStepTiles, maxNodes, maxAgeMs, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      const safeMaxStepTiles = maxStepTiles ?? 18;
      let collisionPath: LocalPathResult | undefined;

      try {
        collisionPath = await calculateCollisionAwarePath(baseURL, worldX, worldY, plane, maxNodes ?? 4096);
        if (collisionPath.success) {
          const step = chooseLocalPathStep(collisionPath, safeMaxStepTiles);
          if (!step) {
            throw new Error("Collision-aware path returned no walkable steps");
          }

          const result = await invokeWalkAction(baseURL, {
            worldX: step.worldX,
            worldY: step.worldY,
            plane: step.plane,
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                mode: "collision_aware_local",
                walkedStep: step,
                result,
                path: collisionPath,
              }, null, 2)
            }]
          };
        }
      } catch (error: any) {
        collisionPath = {
          success: false,
          error: collisionPath?.error ?? "COLLISION_LOCAL_WALK_FAILED",
          message: errorText("walking collision-aware path", error),
          collisionPath,
        };
      }

      const path = withStraightLineFallback(
        snapshot,
        { worldX, worldY, plane },
        safeMaxStepTiles,
        1,
        collisionPath,
      );
      const step = path.steps[0];
      const clicked = await clickMinimapProjection(step.worldX, step.worldY, step.plane, targetClient, maxAgeMs ?? 1000);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            mode: "minimap_fallback",
            clickedStep: step,
            clickedAt: { screenX: clicked.screenX, screenY: clicked.screenY },
            path,
          }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error walking path step: ${e.message}` }] };
    }
  }
);

server.tool(
  "walk_route_to",
  "Walk toward a target world tile over multiple bounded steps, re-planning from fresh state after each movement. Prefer this for practical navigation inside or near the loaded scene.",
  {
    worldX: z.number().describe("Target world X tile"),
    worldY: z.number().describe("Target world Y tile"),
    plane: z.number().optional().describe("Target plane, defaults to the player's current plane"),
    destinationRadius: z.number().optional().describe("Accepted radius around the final target, default 1"),
    stepRadius: z.number().optional().describe("Accepted radius around each intermediate step, default 2"),
    maxRouteSteps: z.number().optional().describe("Maximum movement actions before stopping, default 8"),
    maxStepTiles: z.number().optional().describe("Maximum local path tiles per movement action, default 18"),
    maxNodes: z.number().optional().describe("Maximum local collision-map nodes to search per re-plan, default 4096"),
    stepTimeoutMs: z.number().optional().describe("Maximum wait after each movement action, default 8000"),
    pollMs: z.number().optional().describe("Location polling interval while waiting, default 500"),
    maxAgeMs: z.number().optional().describe("Maximum accepted minimap projection age for fallback clicks, default 1000"),
    allowMinimapFallback: z.boolean().optional().describe("Use bounded minimap fallback when local collision path is unavailable, default true"),
    tickAligned: z.boolean().optional().describe("Wait for the next OSRS game tick before each in-client walk action, default true"),
    ...clientTargetSchema(),
  },
  async ({
    worldX,
    worldY,
    plane,
    destinationRadius,
    stepRadius,
    maxRouteSteps,
    maxStepTiles,
    maxNodes,
    stepTimeoutMs,
    pollMs,
    maxAgeMs,
    allowMinimapFallback,
    tickAligned,
    instanceId,
    playerName,
    port,
  }) => {
    const targetClient = { instanceId, playerName, port };
    const routeStartedAt = Date.now();
    const safeMaxRouteSteps = Math.max(1, Math.min(Math.floor(maxRouteSteps ?? 8), 50));
    const safeMaxStepTiles = Math.max(1, Math.min(Math.floor(maxStepTiles ?? 18), 64));
    const finalRadius = Math.max(0, destinationRadius ?? 1);
    const intermediateRadius = Math.max(0, stepRadius ?? 2);
    const movementTimeout = Math.max(500, stepTimeoutMs ?? 8000);
    const interval = Math.max(100, pollMs ?? 500);
    const useFallback = allowMinimapFallback ?? true;
    const steps: any[] = [];
    let lastSnapshot: RuneLiteSnapshot | undefined;
    let lastDistance = Number.MAX_SAFE_INTEGER;

    try {
      const { baseURL } = await getSnapshotForTarget(targetClient, true);
      await assertClientLoggedIn(baseURL);

      for (let routeStep = 1; routeStep <= safeMaxRouteSteps; routeStep++) {
        lastSnapshot = await getSnapshotForBase(baseURL, true);
        const currentLocation = lastSnapshot.state?.location;
        lastDistance = tileDistance(currentLocation, worldX, worldY, plane);
        if (lastDistance <= finalRadius) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                reached: true,
                reason: "already_at_destination",
                waitedMs: Date.now() - routeStartedAt,
                distance: lastDistance,
                location: currentLocation,
                steps,
              }, null, 2)
            }]
          };
        }

        let mode = "collision_aware_local";
        let plannedPath: any;
        let walkedStep: PathStep | undefined;
        let actionResult: any;

        try {
          const collisionPath = await calculateCollisionAwarePath(baseURL, worldX, worldY, plane, maxNodes ?? 4096);
          plannedPath = collisionPath;
          if (!collisionPath.success) {
            throw new Error(collisionPath.message ?? collisionPath.error ?? "Collision path unavailable");
          }
          walkedStep = chooseLocalPathStep(collisionPath, safeMaxStepTiles);
          if (!walkedStep) {
            throw new Error("Collision-aware path returned no walkable steps");
          }
          actionResult = await invokeWalkAction(baseURL, {
            worldX: walkedStep.worldX,
            worldY: walkedStep.worldY,
            plane: walkedStep.plane,
            tickAligned: tickAligned ?? true,
          });
        } catch (error: any) {
          if (!useFallback) {
            throw error;
          }
          mode = "minimap_fallback";
          const fallback = withStraightLineFallback(
            lastSnapshot,
            { worldX, worldY, plane },
            safeMaxStepTiles,
            1,
            plannedPath,
          );
          plannedPath = fallback;
          walkedStep = fallback.steps?.[0];
          if (!walkedStep) {
            throw new Error(`No fallback route step available after path failure: ${errorText("planning route step", error)}`);
          }
          const clicked = await clickMinimapProjection(walkedStep.worldX, walkedStep.worldY, walkedStep.plane, targetClient, maxAgeMs ?? 1000);
          actionResult = { clickedAt: { screenX: clicked.screenX, screenY: clicked.screenY }, target: clicked };
        }

        const wait = await waitUntilBaseLocation(
          baseURL,
          walkedStep.worldX,
          walkedStep.worldY,
          walkedStep.plane,
          walkedStep.final ? finalRadius : intermediateRadius,
          movementTimeout,
          interval,
        );
        lastSnapshot = await getSnapshotForBase(baseURL, true);
        lastDistance = tileDistance(lastSnapshot.state?.location, worldX, worldY, plane);
        steps.push({
          routeStep,
          mode,
          from: currentLocation,
          walkedStep,
          actionResult,
          wait,
          distanceToDestination: lastDistance,
          pathSummary: {
            success: plannedPath?.success,
            collisionAware: plannedPath?.collisionAware,
            scope: plannedPath?.scope,
            stepsCount: plannedPath?.stepsCount ?? plannedPath?.steps?.length,
            fallbackUsed: plannedPath?.fallbackUsed,
            fallbackReason: plannedPath?.fallbackReason,
          },
        });

        if (lastDistance <= finalRadius) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                reached: true,
                waitedMs: Date.now() - routeStartedAt,
                distance: lastDistance,
                location: lastSnapshot.state?.location,
                steps,
              }, null, 2)
            }]
          };
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            reached: false,
            reason: "max_route_steps_exhausted",
            waitedMs: Date.now() - routeStartedAt,
            distance: lastDistance,
            location: lastSnapshot?.state?.location,
            steps,
          }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error walking route: ${e.message}` }] };
    }
  }
);

server.tool(
  "click_minimap_tile",
  "Project a nearby world tile onto the minimap and click the resulting minimapProjection point.",
  {
    worldX: z.number().describe("Target world X tile"),
    worldY: z.number().describe("Target world Y tile"),
    plane: z.number().optional().describe("Target plane, defaults to 0 if omitted"),
    maxAgeMs: z.number().optional().describe("Maximum accepted minimap projection age in milliseconds, default 1000"),
    ...clientTargetSchema(),
  },
  async ({ worldX, worldY, plane, maxAgeMs, instanceId, playerName, port }) => {
    try {
      const target = await clickMinimapProjection(worldX, worldY, plane, { instanceId, playerName, port }, maxAgeMs ?? 1000);
      return { content: [{ type: "text", text: `Clicked minimap tile ${worldX}, ${worldY}, ${plane ?? 0} at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error clicking minimap tile: ${e.message}` }] };
    }
  }
);

server.tool(
  "click_inventory_slot",
  "Click an inventory slot using slotScreenX/slotScreenY from the live plugin snapshot.",
  {
    slot: z.number().describe("Inventory slot index 0-27"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    maxAgeMs: z.number().optional().describe("Maximum accepted slot data age in milliseconds, default 1000"),
    ...clientTargetSchema(),
  },
  async ({ slot, rightClick, maxAgeMs, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const inventory = snapshot.inventory ?? [];
      const item = inventory.find((candidate: any) => candidate.slot === slot);
      if (!item || !Number.isFinite(item.slotScreenX) || !Number.isFinite(item.slotScreenY)) {
        throw new Error(`No click-ready item found in inventory slot ${slot}`);
      }
      if (item.ageMs !== undefined && item.ageMs > (maxAgeMs ?? 1000)) {
        throw new Error(`Inventory slot data is stale: ageMs=${item.ageMs}`);
      }
      await clickPoint(item.slotScreenX!, item.slotScreenY!, rightClick);
      return { content: [{ type: "text", text: `Clicked inventory slot ${slot} (${item.name ?? item.id}) at ${item.slotScreenX}, ${item.slotScreenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error clicking inventory slot: ${e.message}` }] };
    }
  }
);

server.tool(
  "use_inventory_item",
  "Left-click the first matching inventory item by name/id, using live slot screen coordinates.",
  {
    name: z.string().optional().describe("Item name"),
    id: z.number().optional().describe("Item ID"),
    ...clientTargetSchema(),
  },
  async ({ name, id, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const item = findInventoryItem(snapshot, name, id);
      requireFreshInventoryItem(item, 1000);
      await clickPoint(item.slotScreenX!, item.slotScreenY!);
      return { content: [{ type: "text", text: `Used inventory item ${item.name ?? item.id} in slot ${(item as any).slot}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error using inventory item: ${e.message}` }] };
    }
  }
);

server.tool(
  "use_inventory_item_on_object",
  "Select Use on a fresh inventory item, then click a fresh object clickbox target.",
  {
    itemName: z.string().optional().describe("Inventory item name"),
    itemId: z.number().optional().describe("Inventory item ID"),
    slot: z.number().optional().describe("Inventory slot index 0-27"),
    objectName: z.string().optional().describe("Object name, for example Door"),
    objectId: z.number().optional().describe("Object ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching object to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    itemMaxAgeMs: z.number().optional().describe("Maximum accepted inventory item age in milliseconds, default 1000"),
    useRightClickMenu: z.boolean().optional().describe("Right-click the item and select Use first. Defaults to true."),
    ...clientTargetSchema(),
  },
  async ({ itemName, itemId, slot, objectName, objectId, nearestToPlayer, maxAgeMs, itemMaxAgeMs, useRightClickMenu, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const item = findInventoryItem(snapshot, itemName, itemId, slot);
      requireFreshInventoryItem(item, itemMaxAgeMs ?? 1000);
      await selectInventoryItemForUse(item, targetClient, useRightClickMenu ?? true);

      const freshSnapshot = await getSnapshotForBase(baseURL, true);
      const target = selectLiveTarget(freshSnapshot, "object", objectName, objectId, nearestToPlayer ?? true, "clickbox");
      requireFreshClickable(target, maxAgeMs ?? 600, "clickbox");
      await clickPoint(target.screenX, target.screenY);
      return { content: [{ type: "text", text: `Used ${item.name ?? item.id} on object ${target.name ?? target.id} at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error using inventory item on object: ${e.message}` }] };
    }
  }
);

server.tool(
  "withdraw_bank_item",
  "Click a visible bank Withdraw action for an item, optionally filtered by item name or item id.",
  {
    quantity: z.string().optional().describe("Quantity suffix to prefer, for example 1, 5, 10, X, All. Omit to match any Withdraw action."),
    itemName: z.string().optional().describe("Optional bank item widget name/text substring"),
    itemId: z.number().optional().describe("Optional item id"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
  },
  async ({ quantity, itemName, itemId, rightClick, instanceId, playerName, port }) => {
    try {
      const actionText = quantity ? `Withdraw-${quantity}` : "Withdraw";
      const target = await clickBankAction(actionText, itemName, itemId, rightClick, { instanceId, playerName, port });
      return { content: [{ type: "text", text: `Clicked ${actionText} for bank item at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error withdrawing bank item: ${e.message}` }] };
    }
  }
);

server.tool(
  "deposit_inventory_item",
  "Click a visible bank Deposit action for an inventory item, optionally filtered by item name or item id.",
  {
    quantity: z.string().optional().describe("Quantity suffix to prefer, for example 1, 5, 10, X, All. Omit to match any Deposit action."),
    itemName: z.string().optional().describe("Optional inventory item widget name/text substring"),
    itemId: z.number().optional().describe("Optional item id"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
  },
  async ({ quantity, itemName, itemId, rightClick, instanceId, playerName, port }) => {
    try {
      const actionText = quantity ? `Deposit-${quantity}` : "Deposit";
      const target = await clickBankAction(actionText, itemName, itemId, rightClick, { instanceId, playerName, port });
      return { content: [{ type: "text", text: `Clicked ${actionText} for inventory item at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error depositing inventory item: ${e.message}` }] };
    }
  }
);

server.tool(
  "use_inventory_item_on_npc",
  "Select Use on a fresh inventory item, then click a fresh NPC convexHull target.",
  {
    itemName: z.string().optional().describe("Inventory item name"),
    itemId: z.number().optional().describe("Inventory item ID"),
    slot: z.number().optional().describe("Inventory slot index 0-27"),
    npcName: z.string().optional().describe("NPC name"),
    npcId: z.number().optional().describe("NPC ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching NPC to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    itemMaxAgeMs: z.number().optional().describe("Maximum accepted inventory item age in milliseconds, default 1000"),
    useRightClickMenu: z.boolean().optional().describe("Right-click the item and select Use first. Defaults to true."),
    ...clientTargetSchema(),
  },
  async ({ itemName, itemId, slot, npcName, npcId, nearestToPlayer, maxAgeMs, itemMaxAgeMs, useRightClickMenu, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const item = findInventoryItem(snapshot, itemName, itemId, slot);
      requireFreshInventoryItem(item, itemMaxAgeMs ?? 1000);
      await selectInventoryItemForUse(item, targetClient, useRightClickMenu ?? true);

      const freshSnapshot = await getSnapshotForBase(baseURL, true);
      const target = selectLiveTarget(freshSnapshot, "npc", npcName, npcId, nearestToPlayer ?? true, "convexHull");
      requireFreshClickable(target, maxAgeMs ?? 600, "convexHull");
      await clickPoint(target.screenX, target.screenY);
      return { content: [{ type: "text", text: `Used ${item.name ?? item.id} on NPC ${target.name ?? target.id} at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error using inventory item on NPC: ${e.message}` }] };
    }
  }
);

server.tool(
  "use_inventory_item_on_inventory_item",
  "Select Use on one fresh inventory item, then click another fresh inventory item slot.",
  {
    itemName: z.string().optional().describe("Source inventory item name"),
    itemId: z.number().optional().describe("Source inventory item ID"),
    slot: z.number().optional().describe("Source inventory slot index 0-27"),
    targetItemName: z.string().optional().describe("Target inventory item name"),
    targetItemId: z.number().optional().describe("Target inventory item ID"),
    targetSlot: z.number().optional().describe("Target inventory slot index 0-27"),
    itemMaxAgeMs: z.number().optional().describe("Maximum accepted inventory item age in milliseconds, default 1000"),
    useRightClickMenu: z.boolean().optional().describe("Right-click the source item and select Use first. Defaults to true."),
    ...clientTargetSchema(),
  },
  async ({ itemName, itemId, slot, targetItemName, targetItemId, targetSlot, itemMaxAgeMs, useRightClickMenu, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const item = findInventoryItem(snapshot, itemName, itemId, slot);
      requireFreshInventoryItem(item, itemMaxAgeMs ?? 1000);
      await selectInventoryItemForUse(item, targetClient, useRightClickMenu ?? true);

      const freshSnapshot = await getSnapshotForBase(baseURL, true);
      const target = findInventoryItem(freshSnapshot, targetItemName, targetItemId, targetSlot);
      requireFreshInventoryItem(target, itemMaxAgeMs ?? 1000);
      await clickPoint(target.slotScreenX, target.slotScreenY);
      return { content: [{ type: "text", text: `Used ${item.name ?? item.id} on inventory item ${target.name ?? target.id} in slot ${target.slot}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error using inventory item on inventory item: ${e.message}` }] };
    }
  }
);

server.tool(
  "drop_inventory_item",
  "Right-click the first matching inventory item and select Drop from the context menu.",
  {
    name: z.string().optional().describe("Item name"),
    id: z.number().optional().describe("Item ID"),
    ...clientTargetSchema(),
  },
  async ({ name, id, instanceId, playerName, port }) => {
    try {
      const target = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(target, true);
      await assertClientReady(baseURL);
      const inventory = snapshot.inventory ?? [];
      const item = inventory.find((candidate: any) => targetMatches(candidate, name, id) && Number.isFinite(candidate.slotScreenX) && Number.isFinite(candidate.slotScreenY));
      if (!item) {
        throw new Error("No matching inventory item with slot coordinates found");
      }
      await clickPoint(item.slotScreenX!, item.slotScreenY!, true);
      await new Promise((resolve) => setTimeout(resolve, 120));
      await selectContextMenuOption("Drop", target, false);
      return { content: [{ type: "text", text: `Dropped inventory item ${item.name ?? item.id} from slot ${(item as any).slot}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error dropping inventory item: ${e.message}` }] };
    }
  }
);

server.tool(
  "get_chat_messages",
  "Read recent RuneLite chat/game messages buffered by the plugin.",
  {
    limit: z.number().optional().describe("Maximum messages to return, default 20"),
    ...clientTargetSchema(),
  },
  async ({ limit, instanceId, playerName, port }) => {
    try {
      const res = await (await apiForTarget({ instanceId, playerName, port })).get("/chat", { params: { limit } });
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching chat messages", e) }] };
    }
  }
);

server.tool(
  "get_recent_events",
  "Read recent plugin event hooks such as GameTick, chat, animation changes, item-container changes, and widget loads.",
  {
    limit: z.number().optional().describe("Maximum events to return, default 50"),
    eventType: z.string().optional().describe("Optional exact eventType filter, for example GameTick, ChatMessage, AnimationChanged, ItemContainerChanged, or WidgetLoaded"),
    ...clientTargetSchema(),
  },
  async ({ limit, eventType, instanceId, playerName, port }) => {
    try {
      const res = await (await apiForTarget({ instanceId, playerName, port })).get("/events", { params: { limit, eventType } });
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching recent events", e) }] };
    }
  }
);

server.tool(
  "wait_until_idle",
  "Poll fresh snapshots until the player is idle or the timeout elapses.",
  {
    timeoutMs: z.number().optional().describe("Maximum wait time in milliseconds, default 10000"),
    pollMs: z.number().optional().describe("Polling interval in milliseconds, default 500"),
    stablePolls: z.number().optional().describe("How many consecutive idle polls are required, default 2"),
    ...clientTargetSchema(),
  },
  async ({ timeoutMs, pollMs, stablePolls, instanceId, playerName, port }) => {
    const startedAt = Date.now();
    const timeout = Math.max(1, timeoutMs ?? 10000);
    const interval = Math.max(100, pollMs ?? 500);
    const requiredStablePolls = Math.max(1, stablePolls ?? 2);
    let idlePolls = 0;
    let lastState: any = {};

    try {
      while (Date.now() - startedAt <= timeout) {
        const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port }, true);
        lastState = snapshot.state ?? {};
        if (isPlayerIdle(lastState)) {
          idlePolls += 1;
          if (idlePolls >= requiredStablePolls) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ idle: true, waitedMs: Date.now() - startedAt, stablePolls: idlePolls, state: lastState }, null, 2)
              }]
            };
          }
        } else {
          idlePolls = 0;
        }
        await sleep(interval);
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ idle: false, waitedMs: Date.now() - startedAt, stablePolls: idlePolls, state: lastState }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error waiting for idle: ${e.message}` }] };
    }
  }
);

server.tool(
  "wait_until_location",
  "Poll fresh snapshots until the player is within a Chebyshev tile radius of a world location.",
  {
    worldX: z.number().describe("Target world X tile"),
    worldY: z.number().describe("Target world Y tile"),
    plane: z.number().optional().describe("Required plane, omitted means any plane"),
    radius: z.number().optional().describe("Accepted tile radius, default 1"),
    timeoutMs: z.number().optional().describe("Maximum wait time in milliseconds, default 15000"),
    pollMs: z.number().optional().describe("Polling interval in milliseconds, default 500"),
    ...clientTargetSchema(),
  },
  async ({ worldX, worldY, plane, radius, timeoutMs, pollMs, instanceId, playerName, port }) => {
    const startedAt = Date.now();
    const timeout = Math.max(1, timeoutMs ?? 15000);
    const interval = Math.max(100, pollMs ?? 500);
    const acceptedRadius = Math.max(0, radius ?? 1);
    let lastLocation: any = null;
    let lastDistance = Number.MAX_SAFE_INTEGER;

    try {
      while (Date.now() - startedAt <= timeout) {
        const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port }, true);
        lastLocation = snapshot.state?.location;
        lastDistance = tileDistance(lastLocation, worldX, worldY, plane);
        if (lastDistance <= acceptedRadius) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ reached: true, waitedMs: Date.now() - startedAt, distance: lastDistance, location: lastLocation }, null, 2)
            }]
          };
        }
        await sleep(interval);
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ reached: false, waitedMs: Date.now() - startedAt, distance: lastDistance, location: lastLocation }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error waiting for location: ${e.message}` }] };
    }
  }
);

server.tool(
  "wait_for_chat_message",
  "Poll recent chat/game messages until a fresh message contains the requested text.",
  {
    text: z.string().describe("Message substring to wait for"),
    type: z.string().optional().describe("Optional RuneLite chat message type filter, for example GAMEMESSAGE or SPAM"),
    caseSensitive: z.boolean().optional().describe("Whether matching is case-sensitive"),
    sinceNow: z.boolean().optional().describe("Ignore old buffered messages and only match messages captured after the tool starts, default true"),
    timeoutMs: z.number().optional().describe("Maximum wait time in milliseconds, default 10000"),
    pollMs: z.number().optional().describe("Polling interval in milliseconds, default 500"),
    limit: z.number().optional().describe("Recent message count to scan per poll, default 50"),
    ...clientTargetSchema(),
  },
  async ({ text, type, caseSensitive, sinceNow, timeoutMs, pollMs, limit, instanceId, playerName, port }) => {
    const startedAt = Date.now();
    const timeout = Math.max(1, timeoutMs ?? 10000);
    const interval = Math.max(100, pollMs ?? 500);
    const onlyFresh = sinceNow ?? true;
    let lastMessages: any[] = [];

    try {
      const api = await apiForTarget({ instanceId, playerName, port });
      while (Date.now() - startedAt <= timeout) {
        const res = await api.get("/chat", { params: { limit: limit ?? 50 } });
        lastMessages = res.data?.messages ?? [];
        const match = lastMessages.find((message: any) =>
          (!onlyFresh || Number(message.capturedAt ?? 0) >= startedAt) &&
          matchesChatMessage(message, text, caseSensitive, type)
        );
        if (match) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ matched: true, waitedMs: Date.now() - startedAt, message: match }, null, 2)
            }]
          };
        }
        await sleep(interval);
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ matched: false, waitedMs: Date.now() - startedAt, scanned: lastMessages.length, lastMessages }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error waiting for chat message: ${e.message}` }] };
    }
  }
);

server.tool(
  "verify_after_action",
  "Poll fresh snapshots until expected post-action evidence is observed, then return a compact verification report.",
  {
    timeoutMs: z.number().optional().describe("Maximum wait time in milliseconds, default 8000"),
    pollMs: z.number().optional().describe("Polling interval in milliseconds, default 500"),
    expectIdle: z.boolean().optional().describe("Require the player to be idle"),
    expectedWorldX: z.number().optional().describe("Expected player world X tile"),
    expectedWorldY: z.number().optional().describe("Expected player world Y tile"),
    expectedPlane: z.number().optional().describe("Expected plane when checking location"),
    locationRadius: z.number().optional().describe("Accepted Chebyshev tile radius for location, default 1"),
    chatContains: z.string().optional().describe("Require a fresh chat/game message containing this text"),
    chatType: z.string().optional().describe("Optional RuneLite chat message type filter"),
    caseSensitive: z.boolean().optional().describe("Whether chat matching is case-sensitive"),
    inventoryItemName: z.string().optional().describe("Inventory item name to check"),
    inventoryItemId: z.number().optional().describe("Inventory item id to check"),
    inventoryQuantityAtLeast: z.number().optional().describe("Require the matching inventory quantity to be at least this value"),
    inventoryQuantityChangedFrom: z.number().optional().describe("Require the matching inventory quantity to differ from this previous value"),
    entityType: z.enum(["npc", "object", "ground_item", "player"]).optional().describe("Entity type to verify visible"),
    entityName: z.string().optional().describe("Entity name to verify visible"),
    entityId: z.number().optional().describe("Entity id to verify visible"),
    requireEntityVisible: z.boolean().optional().describe("Require a matching entity to be visible"),
    dialogueType: z.string().optional().describe("Require this dialogue/interface type, for example NONE or OPTIONS"),
    ...clientTargetSchema(),
  },
  async ({
    timeoutMs,
    pollMs,
    expectIdle,
    expectedWorldX,
    expectedWorldY,
    expectedPlane,
    locationRadius,
    chatContains,
    chatType,
    caseSensitive,
    inventoryItemName,
    inventoryItemId,
    inventoryQuantityAtLeast,
    inventoryQuantityChangedFrom,
    entityType,
    entityName,
    entityId,
    requireEntityVisible,
    dialogueType,
    instanceId,
    playerName,
    port,
  }) => {
    const startedAt = Date.now();
    const timeout = Math.max(1, timeoutMs ?? 8000);
    const interval = Math.max(100, pollMs ?? 500);
    let lastReport: any = null;

    try {
      while (Date.now() - startedAt <= timeout) {
        const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port }, true);
        lastReport = buildActionVerification(snapshot, {
          startedAt,
          expectIdle,
          expectedWorldX,
          expectedWorldY,
          expectedPlane,
          locationRadius,
          chatContains,
          chatType,
          caseSensitive,
          inventoryItemName,
          inventoryItemId,
          inventoryQuantityAtLeast,
          inventoryQuantityChangedFrom,
          entityType,
          entityName,
          entityId,
          requireEntityVisible,
          dialogueType,
        });
        if (lastReport.ok) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ verified: true, waitedMs: Date.now() - startedAt, ...lastReport }, null, 2)
            }]
          };
        }
        await sleep(interval);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ verified: false, waitedMs: Date.now() - startedAt, ...lastReport }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error verifying action result: ${e.message}` }] };
    }
  }
);

server.tool(
  "mark_action_baseline",
  "Capture the current snapshot as the before-state for verify_last_action. Use immediately before a risky click, in-client action, skilling loop step, or UI interaction.",
  {
    note: z.string().optional().describe("Optional human-readable note describing the action you are about to perform"),
    inventoryItemName: z.string().optional().describe("Optional item name to include in the baseline summary"),
    inventoryItemId: z.number().optional().describe("Optional item id to include in the baseline summary"),
    ...clientTargetSchema(),
  },
  async ({ note, inventoryItemName, inventoryItemId, instanceId, playerName, port }) => {
    try {
      const baseURL = await resolveRuneliteApi({ instanceId, playerName, port });
      const snapshot = await getSnapshotForBase(baseURL, true);
      const capturedAt = Date.now();
      actionBaselines.set(baseURL, { baseURL, capturedAt, note, snapshot });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            marked: true,
            baseURL,
            capturedAt,
            note,
            summary: snapshotDiffSummary(snapshot, inventoryItemName, inventoryItemId),
          }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error marking action baseline: ${e.message}` }] };
    }
  }
);

server.tool(
  "verify_last_action",
  "Compare the latest fresh snapshot against the most recent mark_action_baseline snapshot, optionally polling until requested deltas appear.",
  {
    timeoutMs: z.number().optional().describe("Maximum wait time in milliseconds, default 8000"),
    pollMs: z.number().optional().describe("Polling interval in milliseconds, default 500"),
    inventoryItemName: z.string().optional().describe("Inventory item name to diff"),
    inventoryItemId: z.number().optional().describe("Inventory item id to diff"),
    expectInventoryQuantityChanged: z.boolean().optional().describe("Require matching item quantity to change"),
    expectInventoryIncreased: z.boolean().optional().describe("Require matching item quantity to increase"),
    expectInventoryDecreased: z.boolean().optional().describe("Require matching item quantity to decrease"),
    expectInventorySlotsChanged: z.boolean().optional().describe("Require used inventory slot count to change"),
    expectLocationChanged: z.boolean().optional().describe("Require player location to differ from baseline"),
    expectedWorldX: z.number().optional().describe("Expected player world X tile"),
    expectedWorldY: z.number().optional().describe("Expected player world Y tile"),
    expectedPlane: z.number().optional().describe("Expected player plane"),
    locationRadius: z.number().optional().describe("Accepted radius for expected location, default 1"),
    expectDialogueChanged: z.boolean().optional().describe("Require dialogue type or text to differ from baseline"),
    dialogueType: z.string().optional().describe("Require current dialogue/interface type"),
    expectNewChat: z.boolean().optional().describe("Require at least one new chat/game message after baseline"),
    chatContains: z.string().optional().describe("Require a new chat/game message containing this text"),
    chatType: z.string().optional().describe("Optional RuneLite chat message type filter"),
    caseSensitive: z.boolean().optional().describe("Whether chat matching is case-sensitive"),
    entityType: z.enum(["npc", "object", "ground_item", "player"]).optional().describe("Entity type to diff count"),
    entityName: z.string().optional().describe("Entity name to diff count"),
    entityId: z.number().optional().describe("Entity id to diff count"),
    expectEntityCountChanged: z.boolean().optional().describe("Require matching visible entity count to change"),
    requireAnyChange: z.boolean().optional().describe("Require any snapshot diff when no specific expectation is provided, default true"),
    clearBaseline: z.boolean().optional().describe("Clear the stored baseline after a successful verification, default false"),
    ...clientTargetSchema(),
  },
  async ({
    timeoutMs,
    pollMs,
    inventoryItemName,
    inventoryItemId,
    expectInventoryQuantityChanged,
    expectInventoryIncreased,
    expectInventoryDecreased,
    expectInventorySlotsChanged,
    expectLocationChanged,
    expectedWorldX,
    expectedWorldY,
    expectedPlane,
    locationRadius,
    expectDialogueChanged,
    dialogueType,
    expectNewChat,
    chatContains,
    chatType,
    caseSensitive,
    entityType,
    entityName,
    entityId,
    expectEntityCountChanged,
    requireAnyChange,
    clearBaseline,
    instanceId,
    playerName,
    port,
  }) => {
    const startedAt = Date.now();
    const timeout = Math.max(1, timeoutMs ?? 8000);
    const interval = Math.max(100, pollMs ?? 500);
    let lastReport: any = null;

    try {
      const baseURL = await resolveRuneliteApi({ instanceId, playerName, port });
      const baseline = actionBaselines.get(baseURL);
      if (!baseline) {
        throw new Error("No action baseline is stored for this client. Call mark_action_baseline before the action you want to verify.");
      }

      while (Date.now() - startedAt <= timeout) {
        const snapshot = await getSnapshotForBase(baseURL, true);
        lastReport = buildSnapshotDiffVerification(baseline.snapshot, snapshot, baseline.capturedAt, {
          inventoryItemName,
          inventoryItemId,
          expectInventoryQuantityChanged,
          expectInventoryIncreased,
          expectInventoryDecreased,
          expectInventorySlotsChanged,
          expectLocationChanged,
          expectedWorldX,
          expectedWorldY,
          expectedPlane,
          locationRadius,
          expectDialogueChanged,
          dialogueType,
          expectNewChat,
          chatContains,
          chatType,
          caseSensitive,
          entityType,
          entityName,
          entityId,
          expectEntityCountChanged,
          requireAnyChange,
        });
        if (lastReport.ok) {
          if (clearBaseline) {
            actionBaselines.delete(baseURL);
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ verified: true, waitedMs: Date.now() - startedAt, baseline: { capturedAt: baseline.capturedAt, note: baseline.note }, ...lastReport }, null, 2)
            }]
          };
        }
        await sleep(interval);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ verified: false, waitedMs: Date.now() - startedAt, baseline: { capturedAt: baseline.capturedAt, note: baseline.note }, ...lastReport }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error verifying last action: ${e.message}` }] };
    }
  }
);

server.tool(
  "handle_dialogue",
  "Continue dialogue and optionally select a dialogue option over several safe steps.",
  {
    desiredOption: z.string().optional().describe("Option text to choose when dialogue options appear"),
    optionIndex: z.number().optional().describe("1-based option index to choose when dialogue options appear"),
    selectFirstOption: z.boolean().optional().describe("Select the first option if desiredOption/optionIndex are not provided. Defaults to false."),
    maxSteps: z.number().optional().describe("Maximum dialogue actions to perform, default 8"),
    waitMs: z.number().optional().describe("Delay after each action before re-reading dialogue, default 450"),
    preferKeyboardContinue: z.boolean().optional().describe("Press Space for NPC/player dialogue continue, default true"),
    ...clientTargetSchema(),
  },
  async ({ desiredOption, optionIndex, selectFirstOption, maxSteps, waitMs, preferKeyboardContinue, instanceId, playerName, port }) => {
    const targetClient = { instanceId, playerName, port };
    const steps: any[] = [];
    const limit = Math.max(1, maxSteps ?? 8);
    const delay = Math.max(100, waitMs ?? 450);

    try {
      const baseURL = await resolveRuneliteApi(targetClient);
      await assertClientReady(baseURL);

      for (let step = 0; step < limit; step += 1) {
        const snapshot = await getSnapshotForBase(baseURL, true);
        const dialogue = snapshot.dialogue ?? {};
        const type = dialogue.type ?? "NONE";

        if (type === "NONE") {
          return { content: [{ type: "text", text: JSON.stringify({ done: true, steps, dialogue }, null, 2) }] };
        }

        if (type === "NPC_DIALOGUE" || type === "PLAYER_DIALOGUE") {
          if (preferKeyboardContinue ?? true) {
            await keyboard.type(Key.Space);
            steps.push({ action: "continue", method: "keyboard_space", dialogueType: type, text: cleanUiText(dialogue.text) });
          } else if (Number.isFinite(dialogue.continueScreenX) && Number.isFinite(dialogue.continueScreenY)) {
            await clickPoint(dialogue.continueScreenX, dialogue.continueScreenY);
            steps.push({ action: "continue", method: "click_continue_widget", dialogueType: type, text: cleanUiText(dialogue.text) });
          } else {
            throw new Error("Dialogue continue coordinate is unavailable");
          }
          await sleep(delay);
          continue;
        }

        if (type === "DIALOGUE_OPTIONS") {
          const options = Array.isArray(dialogue.options) ? dialogue.options : [];
          const selectedIndex = optionIndex !== undefined
            ? optionIndex - 1
            : desiredOption
              ? options.findIndex((option: any) => cleanUiText(option.text).toLowerCase().includes(desiredOption.toLowerCase()))
              : (selectFirstOption ? 0 : -1);

          if (selectedIndex < 0 || selectedIndex >= options.length) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  done: false,
                  needsChoice: true,
                  message: "Dialogue options are open; provide desiredOption, optionIndex, or selectFirstOption.",
                  options: options.map((option: any, index: number) => ({ index: index + 1, text: cleanUiText(option.text) })),
                  steps,
                }, null, 2)
              }]
            };
          }

          const selected = options[selectedIndex];
          if (Number.isFinite(selected.screenX) && Number.isFinite(selected.screenY)) {
            await clickPoint(selected.screenX, selected.screenY);
            steps.push({ action: "select_option", method: "click_option_widget", index: selectedIndex + 1, text: cleanUiText(selected.text) });
          } else if (selectedIndex >= 0 && selectedIndex <= 8) {
            await keyboard.type([Key.Num1, Key.Num2, Key.Num3, Key.Num4, Key.Num5, Key.Num6, Key.Num7, Key.Num8, Key.Num9][selectedIndex]);
            steps.push({ action: "select_option", method: "keyboard_number", index: selectedIndex + 1, text: cleanUiText(selected.text) });
          } else {
            throw new Error("Selected dialogue option has no click coordinate and no supported number key");
          }
          await sleep(delay);
          continue;
        }

        return { content: [{ type: "text", text: JSON.stringify({ done: false, unsupportedDialogueType: type, dialogue, steps }, null, 2) }] };
      }

      const finalSnapshot = await getSnapshotForTarget(targetClient, true);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ done: false, reason: "MAX_STEPS_REACHED", steps, dialogue: finalSnapshot.snapshot.dialogue ?? {} }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error handling dialogue: ${e.message}` }] };
    }
  }
);

server.tool(
  "eat_food_when",
  "Eat a matching food item only when hitpoints are below the requested threshold.",
  {
    hpBelow: z.number().optional().describe("Eat when current hitpoints are below this value"),
    hpBelowPercent: z.number().optional().describe("Eat when current hitpoints percent is below this value"),
    foodName: z.string().optional().describe("Preferred food name substring"),
    foodNames: z.array(z.string()).optional().describe("Preferred food name substrings, checked before default food names"),
    foodId: z.number().optional().describe("Preferred food item id"),
    slot: z.number().optional().describe("Specific inventory slot to eat from"),
    waitMs: z.number().optional().describe("Delay after eating before verifying, default 700"),
    ...clientTargetSchema(),
  },
  async ({ hpBelow, hpBelowPercent, foodName, foodNames, foodId, slot, waitMs, instanceId, playerName, port }) => {
    const targetClient = { instanceId, playerName, port };

    try {
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const currentHp = Number(snapshot.state?.health);
      const currentPercent = healthPercent(snapshot);
      const shouldEatByHp = hpBelow === undefined || (Number.isFinite(currentHp) && currentHp < hpBelow);
      const shouldEatByPercent = hpBelowPercent === undefined || (currentPercent !== undefined && currentPercent < hpBelowPercent);

      if (!shouldEatByHp || !shouldEatByPercent) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ate: false, reason: "THRESHOLD_NOT_MET", health: currentHp, healthPercent: currentPercent, hpBelow, hpBelowPercent }, null, 2)
          }]
        };
      }

      const item = findFoodItem(snapshot, foodNames, foodName, foodId, slot);
      requireFreshInventoryItem(item, 1000);
      const beforeHp = currentHp;
      const selected = await selectInventoryItemOption(item, "Eat", targetClient);
      await sleep(Math.max(100, waitMs ?? 700));
      const after = await getSnapshotForBase(baseURL, true);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ate: true,
            item: { name: item.name, id: item.id, slot: item.slot },
            selected,
            before: { health: beforeHp, healthPercent: currentPercent },
            after: { health: after.state?.health, healthPercent: healthPercent(after) },
          }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error eating food: ${e.message}` }] };
    }
  }
);

server.tool(
  "perform_until",
  "Repeat one high-level entity interaction until a snapshot condition is met or the iteration limit is reached.",
  {
    actionEntityType: z.enum(["npc", "object", "ground_item", "player"]).describe("Entity type to interact with each iteration"),
    actionName: z.string().optional().describe("Entity name to interact with"),
    actionId: z.number().optional().describe("Entity id to interact with"),
    actionOption: z.string().describe("Menu option to choose, for example Chop down, Mine, Bank, Talk-to"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching action target, default true"),
    condition: z.enum(["inventory_full", "inventory_quantity_at_least", "chat_contains", "entity_gone", "location_reached", "idle"]).describe("Stop condition"),
    inventoryItemName: z.string().optional().describe("Item name for inventory_quantity_at_least"),
    inventoryItemId: z.number().optional().describe("Item id for inventory_quantity_at_least"),
    inventoryQuantityAtLeast: z.number().optional().describe("Required quantity for inventory_quantity_at_least"),
    chatContains: z.string().optional().describe("Message text for chat_contains"),
    chatType: z.string().optional().describe("Optional chat type for chat_contains"),
    caseSensitive: z.boolean().optional().describe("Whether chat matching is case-sensitive"),
    entityType: z.enum(["npc", "object", "ground_item", "player"]).optional().describe("Entity type for entity_gone"),
    entityName: z.string().optional().describe("Entity name for entity_gone"),
    entityId: z.number().optional().describe("Entity id for entity_gone"),
    worldX: z.number().optional().describe("World X for location_reached"),
    worldY: z.number().optional().describe("World Y for location_reached"),
    plane: z.number().optional().describe("Plane for location_reached"),
    radius: z.number().optional().describe("Radius for location_reached, default 1"),
    maxIterations: z.number().optional().describe("Maximum interactions to perform, default 10"),
    settleMs: z.number().optional().describe("Delay after each interaction before condition polling, default 700"),
    pollMs: z.number().optional().describe("Condition polling interval after each interaction, default 500"),
    pollTimeoutMs: z.number().optional().describe("Maximum condition polling time after each interaction, default 8000"),
    ...clientTargetSchema(),
  },
  async ({
    actionEntityType,
    actionName,
    actionId,
    actionOption,
    nearestToPlayer,
    condition,
    inventoryItemName,
    inventoryItemId,
    inventoryQuantityAtLeast,
    chatContains,
    chatType,
    caseSensitive,
    entityType,
    entityName,
    entityId,
    worldX,
    worldY,
    plane,
    radius,
    maxIterations,
    settleMs,
    pollMs,
    pollTimeoutMs,
    instanceId,
    playerName,
    port,
  }) => {
    const targetClient = { instanceId, playerName, port };
    const startedAt = Date.now();
    const iterations: any[] = [];
    const limit = Math.max(1, maxIterations ?? 10);
    const interval = Math.max(100, pollMs ?? 500);
    const perActionTimeout = Math.max(100, pollTimeoutMs ?? 8000);

    try {
      for (let iteration = 0; iteration <= limit; iteration += 1) {
        const before = await getSnapshotForTarget(targetClient, true);
        const beforeCondition = conditionMet(before.snapshot, {
          condition,
          startedAt,
          inventoryItemName,
          inventoryItemId,
          inventoryQuantityAtLeast,
          chatContains,
          chatType,
          caseSensitive,
          entityType,
          entityName,
          entityId,
          worldX,
          worldY,
          plane,
          radius,
        });
        if (beforeCondition.met) {
          return { content: [{ type: "text", text: JSON.stringify({ done: true, reason: "CONDITION_MET", iterations, condition: beforeCondition }, null, 2) }] };
        }
        if (iteration === limit) {
          return { content: [{ type: "text", text: JSON.stringify({ done: false, reason: "MAX_ITERATIONS_REACHED", iterations, lastCondition: beforeCondition }, null, 2) }] };
        }

        const action = await interactWithTarget({
          entityType: actionEntityType,
          name: actionName,
          id: actionId,
          option: actionOption,
          nearestToPlayer: nearestToPlayer ?? true,
          instanceId,
          playerName,
          port,
        });
        await sleep(Math.max(100, settleMs ?? 700));

        const pollStartedAt = Date.now();
        let lastCondition: any = null;
        while (Date.now() - pollStartedAt <= perActionTimeout) {
          const after = await getSnapshotForTarget(targetClient, true);
          lastCondition = conditionMet(after.snapshot, {
            condition,
            startedAt,
            inventoryItemName,
            inventoryItemId,
            inventoryQuantityAtLeast,
            chatContains,
            chatType,
            caseSensitive,
            entityType,
            entityName,
            entityId,
            worldX,
            worldY,
            plane,
            radius,
          });
          if (lastCondition.met) {
            iterations.push({ iteration: iteration + 1, action, condition: lastCondition });
            return { content: [{ type: "text", text: JSON.stringify({ done: true, reason: "CONDITION_MET_AFTER_ACTION", iterations, condition: lastCondition }, null, 2) }] };
          }
          if (condition === "idle" && lastCondition.met) {
            break;
          }
          await sleep(interval);
        }

        iterations.push({ iteration: iteration + 1, action, condition: lastCondition });
      }

      return { content: [{ type: "text", text: JSON.stringify({ done: false, reason: "LOOP_EXITED", iterations }, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error performing action loop: ${e.message}` }] };
    }
  }
);

server.tool(
  "get_stream_status",
  "Inspect the MCP server's live /api/stream snapshot cache status for a RuneLite client.",
  {
    ...clientTargetSchema(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const baseURL = await resolveRuneliteApi({ instanceId, playerName, port });
      if (await ensureSnapshotStreamSupported(baseURL)) {
        startSnapshotStream(baseURL);
      }
      return { content: [{ type: "text", text: JSON.stringify(snapshotStreamStatus(baseURL), null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("checking stream status", e) }] };
    }
  }
);

server.tool("list_clients", "List active OSRS MCP RuneLite plugin clients discovered on local ports 8080-8090", {}, async () => {
  try {
    const clients = await discoverClients();
    return {
      content: [{ type: "text", text: JSON.stringify({ selectedBaseUrl: selectedRuneliteApi, clients }, null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("listing clients", e) }] };
  }
});

server.tool(
  "diagnose_runtime",
  "Check active RuneLite MCP plugin runtimes for stale jars, missing endpoints, and feature flags before attempting gameplay actions.",
  {
    ...clientTargetSchema(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const clients = await discoverClients();
      const selectedClients = clients.filter((client: any) =>
        (port !== undefined && client.port === port) ||
        (instanceId && client.instanceId === instanceId) ||
        (playerName && String(client.playerName ?? "").toLowerCase() === playerName.toLowerCase()) ||
        (port === undefined && !instanceId && !playerName)
      );
      const reports = [];
      for (const client of selectedClients) {
        reports.push(await diagnoseClientRuntime(client));
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            selectedBaseUrl: selectedRuneliteApi,
            expectedApiVersion: EXPECTED_PLUGIN_API_VERSION,
            checkedClients: reports.length,
            allOk: reports.length > 0 && reports.every((report) => report.status === "ok"),
            reports,
            note: reports.length === 0
              ? "No active RuneLite MCP plugin clients were discovered on ports 8080-8090."
              : reports.some((report) => report.staleRuntime)
              ? "Rebuild/install can stage the jar, but a running RuneLite process must reload the plugin before new Java endpoints appear. This tool does not restart or close RuneLite."
              : "Runtime feature checks passed for the selected client(s).",
          }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("diagnosing runtime", e) }] };
    }
  }
);

server.tool(
  "select_client",
  "Select the active RuneLite client by instanceId, playerName, or port. Required when multiple clients are active.",
  {
    instanceId: z.string().optional(),
    playerName: z.string().optional(),
    port: z.number().optional(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const clients = await discoverClients();
      const matches = clients.filter((client: any) =>
        (instanceId && client.instanceId === instanceId) ||
        (playerName && String(client.playerName ?? "").toLowerCase() === playerName.toLowerCase()) ||
        (port !== undefined && client.port === port)
      );

      if (matches.length !== 1) {
        return {
          content: [{
            type: "text",
            text: `Expected exactly one matching client, found ${matches.length}.\n${JSON.stringify(clients, null, 2)}`
          }]
        };
      }

      selectedRuneliteApi = matches[0].baseUrl;
      selectedClientInstanceId = matches[0].instanceId;
      return {
        content: [{ type: "text", text: `Selected OSRS MCP client ${matches[0].instanceId} at ${selectedRuneliteApi}` }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("selecting client", e) }] };
    }
  }
);

server.tool(
  "click_object",
  "Refresh the newest object snapshot, find a matching object, and click its fresh clickbox-backed screenX/screenY.",
  {
    name: z.string().optional().describe("Object name, for example Tree"),
    id: z.number().optional().describe("Object ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching object to the player"),
    option: z.string().optional().describe("Optional menu option to invoke in-client, for example Chop down or Open. When set, this uses the hybrid context-menu/menuAction path."),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
  },
  async ({ name, id, nearestToPlayer, option, maxAgeMs, rightClick, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      if (option) {
        const result = await interactWithTarget({ entityType: "object", option, name, id, nearestToPlayer, maxAgeMs, instanceId, playerName, port });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const objects = snapshot.objects ?? [];
      const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
      const matches = sortNearestToPlayer(
        sortByDistance(objects.filter((object: any) => targetMatches(object, name, id))),
        playerLocation
      );
      const target = matches.find((object: any) => object.coordinateSource === "clickbox" && Number.isFinite(object.screenX) && Number.isFinite(object.screenY));
      requireFreshClickable(target, maxAgeMs ?? 600, "clickbox");
      await clickPoint(target.screenX, target.screenY, rightClick);
      return { content: [{ type: "text", text: `Clicked object ${target.name} (${target.id}) at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error clicking object: ${e.message}` }] };
    }
  }
);

server.tool(
  "hover_object",
  "Refresh the newest object snapshot, find a matching object, and move the mouse to its fresh clickbox-backed screenX/screenY without clicking.",
  {
    name: z.string().optional().describe("Object name, for example Tree"),
    id: z.number().optional().describe("Object ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching object to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    ...clientTargetSchema(),
  },
  async ({ name, id, nearestToPlayer, maxAgeMs, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const objects = snapshot.objects ?? [];
      const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
      const matches = sortNearestToPlayer(
        sortByDistance(objects.filter((object: any) => targetMatches(object, name, id))),
        playerLocation
      );
      const target = matches.find((object: any) => object.coordinateSource === "clickbox" && Number.isFinite(object.screenX) && Number.isFinite(object.screenY));
      requireFreshClickable(target, maxAgeMs ?? 600, "clickbox");
      await movePoint(target.screenX, target.screenY);
      return { content: [{ type: "text", text: `Moved mouse to object ${target.name} (${target.id}) at ${target.screenX}, ${target.screenY} without clicking.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error hovering object: ${e.message}` }] };
    }
  }
);

server.tool(
  "click_npc",
  "Refresh the newest NPC snapshot, find a matching NPC, and click its fresh convexHull-backed screenX/screenY.",
  {
    name: z.string().optional().describe("NPC name"),
    id: z.number().optional().describe("NPC ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching NPC to the player"),
    option: z.string().optional().describe("Optional menu option to invoke in-client, for example Talk-to or Attack. When set, this uses the hybrid context-menu/menuAction path."),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
  },
  async ({ name, id, nearestToPlayer, option, maxAgeMs, rightClick, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      if (option) {
        const result = await interactWithTarget({ entityType: "npc", option, name, id, nearestToPlayer, maxAgeMs, instanceId, playerName, port });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const npcs = snapshot.npcs ?? [];
      const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
      const matches = sortNearestToPlayer(
        sortByDistance(npcs.filter((npc: any) => targetMatches(npc, name, id))),
        playerLocation
      );
      const target = matches.find((npc: any) => npc.coordinateSource === "convexHull" && Number.isFinite(npc.screenX) && Number.isFinite(npc.screenY));
      requireFreshClickable(target, maxAgeMs ?? 600, "convexHull");
      await clickPoint(target.screenX, target.screenY, rightClick);
      return { content: [{ type: "text", text: `Clicked NPC ${target.name} (${target.id}) at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error clicking NPC: ${e.message}` }] };
    }
  }
);

server.tool(
  "hover_npc",
  "Refresh the newest NPC snapshot, find a matching NPC, and move the mouse to its fresh convexHull-backed screenX/screenY without clicking.",
  {
    name: z.string().optional().describe("NPC name"),
    id: z.number().optional().describe("NPC ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching NPC to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    ...clientTargetSchema(),
  },
  async ({ name, id, nearestToPlayer, maxAgeMs, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const npcs = snapshot.npcs ?? [];
      const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
      const matches = sortNearestToPlayer(
        sortByDistance(npcs.filter((npc: any) => targetMatches(npc, name, id))),
        playerLocation
      );
      const target = matches.find((npc: any) => npc.coordinateSource === "convexHull" && Number.isFinite(npc.screenX) && Number.isFinite(npc.screenY));
      requireFreshClickable(target, maxAgeMs ?? 600, "convexHull");
      await movePoint(target.screenX, target.screenY);
      return { content: [{ type: "text", text: `Moved mouse to NPC ${target.name} (${target.id}) at ${target.screenX}, ${target.screenY} without clicking.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error hovering NPC: ${e.message}` }] };
    }
  }
);

server.tool(
  "click_ground_item",
  "Refresh the newest ground-item snapshot, find a matching item, and click its fresh screenX/screenY.",
  {
    name: z.string().optional().describe("Ground item name"),
    id: z.number().optional().describe("Item ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching item to the player"),
    option: z.string().optional().describe("Optional menu option to invoke in-client, for example Take. When set, this uses the hybrid context-menu/menuAction path."),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
  },
  async ({ name, id, nearestToPlayer, option, maxAgeMs, rightClick, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      if (option) {
        const result = await interactWithTarget({ entityType: "ground_item", option, name, id, nearestToPlayer, maxAgeMs, instanceId, playerName, port });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const items = snapshot.groundItems ?? [];
      const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
      const matches = sortNearestToPlayer(
        sortByDistance(items.filter((item: any) => targetMatches(item, name, id))),
        playerLocation
      );
      const target = matches.find((item: any) => Number.isFinite(item.screenX) && Number.isFinite(item.screenY));
      requireFreshClickable(target, maxAgeMs ?? 600);
      await clickPoint(target.screenX, target.screenY, rightClick);
      return { content: [{ type: "text", text: `Clicked ground item ${target.name} (${target.id}) at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error clicking ground item: ${e.message}` }] };
    }
  }
);

server.tool(
  "hover_ground_item",
  "Refresh the newest ground-item snapshot, find a matching item, and move the mouse to its fresh screenX/screenY without clicking.",
  {
    name: z.string().optional().describe("Ground item name"),
    id: z.number().optional().describe("Item ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching item to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    ...clientTargetSchema(),
  },
  async ({ name, id, nearestToPlayer, maxAgeMs, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const items = snapshot.groundItems ?? [];
      const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
      const matches = sortNearestToPlayer(
        sortByDistance(items.filter((item: any) => targetMatches(item, name, id))),
        playerLocation
      );
      const target = matches.find((item: any) => Number.isFinite(item.screenX) && Number.isFinite(item.screenY));
      requireFreshClickable(target, maxAgeMs ?? 600);
      await movePoint(target.screenX, target.screenY);
      return { content: [{ type: "text", text: `Moved mouse to ground item ${target.name} (${target.id}) at ${target.screenX}, ${target.screenY} without clicking.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error hovering ground item: ${e.message}` }] };
    }
  }
);

// --- Action Tools (OS-Level) ---

server.tool(
  "get_input_profile",
  "Inspect OS fallback input settings. In-client menu actions are still preferred over OS mouse input.",
  {},
  async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        humanizeMouse: HUMANIZE_MOUSE,
        mouseSpeed: mouse.config.mouseSpeed,
        mouseDelayMs: { min: MOUSE_MIN_DELAY_MS, max: MOUSE_MAX_DELAY_MS },
        note: "These settings apply only to nut-js OS fallback mouse movement; interact_with and invoke_* use in-client actions when possible.",
      }, null, 2)
    }]
  })
);

server.tool(
  "move_mouse",
  "Moves the hardware mouse to an absolute desktop screen X/Y coordinate without clicking. Use this to verify RuneLite screenX/screenY safely.",
  {
    x: z.number().describe("The absolute desktop screen X coordinate, usually a screenX value from the RuneLite API"),
    y: z.number().describe("The absolute desktop screen Y coordinate, usually a screenY value from the RuneLite API")
  },
  async ({ x, y }) => {
    try {
      await movePoint(x, y);
      return {
        content: [{ type: "text", text: `Successfully moved mouse to ${x}, ${y} without clicking.` }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error moving mouse: ${e.message}` }] };
    }
  }
);

server.tool(
  "move_mouse_and_click",
  "Moves the hardware mouse to an absolute desktop screen X/Y coordinate and clicks. Use screenX/screenY from RuneLite API results, not canvasX/canvasY.",
  {
    x: z.number().describe("The absolute desktop screen X coordinate, usually a screenX value from the RuneLite API"),
    y: z.number().describe("The absolute desktop screen Y coordinate, usually a screenY value from the RuneLite API"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click")
  },
  async ({ x, y, rightClick }) => {
    try {
      await moveMouseHumanized(x, y);
      await settleBeforeClick();
      if (rightClick) {
        await mouse.rightClick();
      } else {
        await mouse.leftClick();
      }
      return {
        content: [{ type: "text", text: `Successfully moved mouse to ${x}, ${y} and clicked.` }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error moving mouse: ${e.message}` }] };
    }
  }
);

server.tool(
  "type_text",
  "Types text using the hardware keyboard. Useful for naming character, entering bank pins, or chatting.",
  {
    text: z.string().describe("The text to type"),
    pressEnter: z.boolean().optional().describe("Whether to press Enter after typing")
  },
  async ({ text, pressEnter }) => {
    try {
      await keyboard.type(text);
      if (pressEnter) {
        await keyboard.type(Key.Enter);
      }
      return {
        content: [{ type: "text", text: `Successfully typed: "${text}"` }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error typing text: ${e.message}` }] };
    }
  }
);

server.tool(
  "press_key",
  "Press a specific key on the keyboard, like 'Space' (often used to continue dialogue) or 'Escape'.",
  {
    keyName: z.string().describe("The name of the key to press (e.g., 'Space', 'Escape', 'Enter')")
  },
  async ({ keyName }) => {
    try {
      const normalized = keyName.toLowerCase();
      const keyMap: Record<string, any> = {
        space: Key.Space,
        escape: Key.Escape,
        esc: Key.Escape,
        enter: Key.Enter,
        return: Key.Enter,
        tab: Key.Tab,
        backspace: Key.Backspace,
        delete: Key.Delete,
        up: Key.Up,
        arrowup: Key.Up,
        down: Key.Down,
        arrowdown: Key.Down,
        left: Key.Left,
        arrowleft: Key.Left,
        right: Key.Right,
        arrowright: Key.Right,
        f1: Key.F1,
        f2: Key.F2,
        f3: Key.F3,
        f4: Key.F4,
        f5: Key.F5,
        f6: Key.F6,
        f7: Key.F7,
        f8: Key.F8,
        f9: Key.F9,
        f10: Key.F10,
        f11: Key.F11,
        f12: Key.F12,
        "0": Key.Num0,
        "1": Key.Num1,
        "2": Key.Num2,
        "3": Key.Num3,
        "4": Key.Num4,
        "5": Key.Num5,
        "6": Key.Num6,
        "7": Key.Num7,
        "8": Key.Num8,
        "9": Key.Num9,
      };
      const k = keyMap[normalized];
      if (k === undefined) {
        return { content: [{ type: "text", text: `Unsupported key: ${keyName}` }] };
      }
      await keyboard.type(k);
      return {
        content: [{ type: "text", text: `Successfully pressed key: ${keyName}` }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error pressing key: ${e.message}` }] };
    }
  }
);

// --- Start Server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OSRS MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
