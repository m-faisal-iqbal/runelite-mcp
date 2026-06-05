import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import { createRequire } from "node:module";
import { access, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mouse, Point, keyboard, Key, screen, Region, FileType } from "@nut-tree-fork/nut-js";
import { apiBaseFromPort, StateCache, type ClientTarget, type LocalPathResult, type PathStep, type RuneLiteSnapshot, type RuneLiteTarget } from "./client.js";
import { actionStep, buildAgentStepPackage, buildNextActionPlan } from "./planner.js";
import { buildAgentContext } from "./agent-context.js";
import { AgentMemoryStore, strategyCacheKey } from "./agent-memory.js";
import {
  getKnowledgeRecord,
  getMethodKnowledge,
  knowledgeSummary,
  queryKnowledge,
} from "./knowledge-base.js";
import { discoverClients as discoverRuntimeClients, selectDiscoveredClient } from "./client-discovery.js";
import { diagnoseClientRuntime as diagnoseRuntimeClient, EXPECTED_PLUGIN_API_VERSION } from "./runtime-diagnostics.js";
import { calculateStraightLineSteps, chooseLocalPathStep, tileDistance, withStraightLineFallback } from "./navigation.js";
import { buildSemanticInterface, findSemanticControls, planQuestStep } from "./semantic-interface.js";
import { ReflexEngine, validateReflexPolicySafety, type LoadedReflexPolicy, type ReflexExecutionMode, type ReflexPolicy, type ReflexStep } from "./engine/ReflexEngine.js";
import { findTransportNode, nearestTransportNode, nextRouteWaypoint, planTransportRoute, transportGraphSummary } from "./transport-graph.js";

const require = createRequire(import.meta.url);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = ["build", "src"].includes(path.basename(moduleDir))
  ? path.resolve(moduleDir, "..")
  : moduleDir;
const repoRoot = path.resolve(serverRoot, "..");
const workDir = path.join(repoRoot, "work");
const osControlRequestPath = path.join(workDir, "os-control-request.json");

type ActionBaseline = {
  baseURL: string;
  capturedAt: number;
  note?: string;
  snapshot: RuneLiteSnapshot;
};

type AgentSessionStatus = "created" | "running" | "paused" | "stopped" | "completed" | "blocked";

type AgentSessionEvent = {
  at: number;
  type: string;
  data?: any;
};

type AgentSession = {
  id: string;
  goal: string;
  status: AgentSessionStatus;
  executionMode: "dry_run" | "execute";
  createdAt: number;
  updatedAt: number;
  selectedClient?: ClientTarget;
  stepCount: number;
  stopReason?: string;
  goalState?: any;
  lastSelectedStep?: any;
  lastVerification?: any;
  lastResult?: any;
  history: AgentSessionEvent[];
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
const configuredSnapshotCacheTtlMs = Number(process.env.OSRS_SNAPSHOT_CACHE_TTL_MS ?? "1500");
const SNAPSHOT_CACHE_TTL_MS = Number.isFinite(configuredSnapshotCacheTtlMs) && configuredSnapshotCacheTtlMs >= 0
  ? configuredSnapshotCacheTtlMs
  : 250;
const stateCache = new StateCache(SNAPSHOT_CACHE_TTL_MS, API_TIMEOUT_MS, async (baseURL) => {
  return (await runeliteApi(baseURL).get("/snapshot")).data as RuneLiteSnapshot;
});
const actionBaselines = new Map<string, ActionBaseline>();
const agentSessions = new Map<string, AgentSession>();
let activeAgentSessionId: string | undefined;
const agentMemory = new AgentMemoryStore();
let agentMemoryLoaded = false;
const EXECUTE_AGENT_STEP_CONFIRMATION = "EXECUTE_ONE_STEP";
const RUN_AUTONOMY_CONFIRMATION = "RUN_AUTONOMY";
const LOAD_POLICY_EXECUTE_CONFIRMATION = "LOAD_POLICY_EXECUTE";
const NAVIGATE_EXECUTE_CONFIRMATION = "NAVIGATE_ONE_STEP";
const EXECUTE_SEMANTIC_CONTROL_CONFIRMATION = "EXECUTE_SEMANTIC_CONTROL";
const EXECUTABLE_AGENT_TOOLS = new Set([
  "invoke_menu_action",
  "invoke_walk_action",
  "invoke_widget_action",
  "interact_with",
  "perform_until",
  "click_object",
  "click_npc",
  "click_ground_item",
  "deposit_inventory_item",
  "withdraw_bank_item",
  "drop_inventory_item",
]);

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
  return discoverRuntimeClients(API_TIMEOUT_MS);
}

async function diagnoseClientRuntime(client: any) {
  return diagnoseRuntimeClient(client, API_TIMEOUT_MS);
}

function lightweightRuntimeStatus(client: any) {
  const apiVersion = Number(client?.apiVersion ?? 0);
  if (Number.isFinite(apiVersion) && apiVersion > 0 && apiVersion < EXPECTED_PLUGIN_API_VERSION) {
    return {
      status: "needs_reload",
      staleRuntime: true,
      apiVersion,
      expectedApiVersion: EXPECTED_PLUGIN_API_VERSION,
      warnings: [
        `Plugin API version ${apiVersion} is older than expected ${EXPECTED_PLUGIN_API_VERSION}. Run diagnose_runtime for endpoint details and reload RuneLite plugin before real autonomy.`,
      ],
      lightweight: true,
    };
  }
  return {
    status: "not_checked",
    apiVersion: Number.isFinite(apiVersion) && apiVersion > 0 ? apiVersion : undefined,
    expectedApiVersion: EXPECTED_PLUGIN_API_VERSION,
    lightweight: true,
  };
}

function baseUrlForClient(client: any): string {
  if (client?.baseUrl) {
    return client.baseUrl;
  }
  if (typeof client?.port === "number") {
    return apiBaseFromPort(client.port);
  }
  throw new Error(`Discovered RuneLite client is missing baseUrl and port: ${JSON.stringify(client)}`);
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

async function getSemanticInterfaceForTarget(target: ClientTarget = {}, args: {
  forceRefresh?: boolean;
  widgetFilter?: string;
  maxWidgets?: number;
  includeHidden?: boolean;
} = {}) {
  const baseURL = await resolveRuneliteApi(target);
  const snapshot = await getSnapshotForBase(baseURL, args.forceRefresh === true);
  let widgets: any[] = [];
  let widgetError: string | undefined;
  try {
    const res = await runeliteApi(baseURL).get("/widgets", {
      params: {
        filter: args.widgetFilter,
        includeHidden: args.includeHidden ?? false,
        maxWidgets: Math.max(1, Math.min(500, args.maxWidgets ?? 150)),
        maxDepth: 8,
      },
    });
    widgets = Array.isArray(res.data?.widgets)
      ? res.data.widgets
      : Array.isArray(res.data)
        ? res.data
        : Array.isArray(res.data?.actionWidgets)
          ? res.data.actionWidgets
          : [];
  } catch (error: any) {
    widgetError = error?.message ?? String(error);
  }
  return {
    baseURL,
    snapshot,
    widgets,
    widgetError,
    semantic: buildSemanticInterface(snapshot, widgets),
  };
}

async function getPathfindingStatusForTarget(target: ClientTarget = {}) {
  return getPathfindingStatusForBase(await resolveRuneliteApi(target));
}

async function getPathfindingStatusForBase(baseURL: string) {
  const api = runeliteApi(baseURL);
  try {
    const res = await api.get("/path/status");
    return { ...res.data, statusEndpointAvailable: true };
  } catch (error: any) {
    const oldPluginPathStatusFallback =
      error?.response?.status === 404 ||
      (error?.response?.status === 400 &&
        error?.response?.data?.error === "BAD_REQUEST" &&
        String(error?.response?.data?.message ?? "").includes("worldX and worldY"));
    if (!oldPluginPathStatusFallback) {
      throw error;
    }

    const identity = (await api.get("/identity")).data;
    return {
      status: identity?.supportsLocalPathfinding === true ? "LOCAL_SCENE_READY" : "UNAVAILABLE",
      provider: identity?.pathfindingProvider ?? "runelite_collision_map",
      supportsLocalPathfinding: identity?.supportsLocalPathfinding === true,
      supportsGlobalPathfinding: identity?.supportsGlobalPathfinding === true,
      supportsShortestPathBridge: identity?.supportsShortestPathBridge === true,
      scope: identity?.pathfindingScope ?? "loaded_scene",
      globalProvider: identity?.supportsGlobalPathfinding === true ? "unknown" : "none",
      shortestPathBridgeStatus: identity?.supportsShortestPathBridge === true ? "UNKNOWN" : "NOT_CONFIGURED",
      statusEndpointAvailable: false,
      baseURL,
      note: "Running plugin does not expose /api/path/status yet; this fallback is derived from /api/identity. Rebuild/reload RuneLite to expose detailed pathfinding status.",
    };
  }
}

async function assertClientReady(baseURL: string, options: { requireActiveWindow?: boolean } = {}) {
  const identity = (await runeliteApi(baseURL).get("/identity")).data;
  if (identity?.windowMinimized) {
    throw new Error(`RuneLite client ${identity.instanceId ?? baseURL} is minimized`);
  }
  if (identity?.canvasShowing === false) {
    throw new Error(`RuneLite client ${identity.instanceId ?? baseURL} canvas is not visible`);
  }
  if (options.requireActiveWindow === true && identity?.windowActive === false) {
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
  await requireOsControl(`Hardware ${rightClick ? "right" : "left"} click requested at ${Math.round(x)}, ${Math.round(y)}.`);
  await moveMouseHumanized(x, y);
  await settleBeforeClick();
  if (rightClick) {
    await mouse.rightClick();
  } else {
    await mouse.leftClick();
  }
}

async function movePoint(x: number, y: number) {
  await requireOsControl(`Hardware mouse move requested at ${Math.round(x)}, ${Math.round(y)}.`);
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
  const pluginCapture = await captureCanvasImageFromPlugin(baseURL, args).catch((error: any) => ({
    status: "PLUGIN_CANVAS_CAPTURE_UNAVAILABLE",
    error: error?.message ?? String(error),
  }));
  if (pluginCapture.status === "CANVAS_SCREENSHOT_READY") {
    return pluginCapture;
  }

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

async function captureCanvasImageFromPlugin(baseURL: string, args: {
  canvasX?: number;
  canvasY?: number;
  width?: number;
  height?: number;
  radius?: number;
  includeImage?: boolean;
}) {
  const params: Record<string, any> = {
    includeImage: args.includeImage !== false,
  };
  for (const key of ["canvasX", "canvasY", "width", "height", "radius"] as const) {
    if (Number.isFinite(args[key])) {
      params[key] = args[key];
    }
  }

  const plugin = (await runeliteApi(baseURL).get("/canvas/screenshot", { params })).data;
  if (plugin?.status !== "CANVAS_SCREENSHOT_READY") {
    throw new Error(plugin?.reason ?? plugin?.error ?? `Unexpected plugin screenshot status ${plugin?.status ?? "UNKNOWN"}`);
  }

  let filePath: string | undefined;
  if (args.includeImage !== false) {
    if (typeof plugin.base64 !== "string") {
      throw new Error("Plugin screenshot did not include base64 image data.");
    }
    const outputDir = path.join(os.tmpdir(), "runelite-mcp-captures");
    await mkdir(outputDir, { recursive: true });
    filePath = path.join(outputDir, `plugin_canvas_${Date.now()}.png`);
    await writeFile(filePath, Buffer.from(plugin.base64, "base64"));
  }

  const response: any = {
    status: "CANVAS_SCREENSHOT_READY",
    source: "plugin_canvas_screenshot",
    mimeType: plugin.mimeType ?? "image/png",
    capturedAt: plugin.capturedAt ?? Date.now(),
    canvas: {
      x: plugin.canvasX ?? 0,
      y: plugin.canvasY ?? 0,
      width: plugin.width,
      height: plugin.height,
    },
    screen: Number.isFinite(plugin.screenX) && Number.isFinite(plugin.screenY)
      ? {
          x: plugin.screenX,
          y: plugin.screenY,
          width: plugin.width,
          height: plugin.height,
        }
      : undefined,
    canvasOriginNutX: plugin.canvasOriginX,
    canvasOriginNutY: plugin.canvasOriginY,
    canvasWidth: plugin.canvasWidth,
    canvasHeight: plugin.canvasHeight,
    byteLength: plugin.byteLength,
  };
  if (filePath) {
    response.filePath = filePath;
  }
  if (args.includeImage !== false) {
    response.base64 = plugin.base64;
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

function hasDirectMenuParams(target: any): boolean {
  return Boolean(
    target &&
    Number.isFinite(target.param0) &&
    Number.isFinite(target.param1) &&
    (Number.isFinite(target.identifier) || Number.isFinite(target.id)) &&
    target.menuAction
  );
}

function scenePoiDefaultOption(poi: any, requestedOption?: string): string | undefined {
  if (requestedOption) {
    return requestedOption;
  }
  const semantic = String(poi?.semantic ?? "").toLowerCase();
  const name = String(poi?.name ?? "").toLowerCase();
  if (semantic === "resource_tree" || name === "tree" || name.includes("tree")) {
    return "Chop down";
  }
  if (semantic === "resource_rocks" || name.includes("rocks")) {
    return "Mine";
  }
  if (semantic === "bank") {
    return "Bank";
  }
  if (semantic === "door") {
    return "Open";
  }
  return requestedOption;
}

async function scenePoiObjectTargets(baseURL: string, name?: string, id?: number, option?: string): Promise<RuneLiteTarget[]> {
  const [iconsResponse, pathStatusResponse] = await Promise.all([
    runeliteApi(baseURL).get("/minimap/icons", { params: { maxEntities: 120 } }),
    runeliteApi(baseURL).get("/path/status"),
  ]);
  const icons = Array.isArray(iconsResponse.data?.icons) ? iconsResponse.data.icons : [];
  const pathStatus = pathStatusResponse.data ?? {};
  const baseX = Number(pathStatus.baseX);
  const baseY = Number(pathStatus.baseY);
  const sceneSizeX = Number(pathStatus.sceneSizeX ?? 104);
  const sceneSizeY = Number(pathStatus.sceneSizeY ?? 104);
  if (!Number.isFinite(baseX) || !Number.isFinite(baseY)) {
    return [];
  }

  return icons
    .filter((poi: any) => poi?.type === "scenePoi")
    .filter((poi: any) => targetMatches(poi, name, id))
    .map((poi: any) => {
      const worldX = Number(poi.worldX);
      const worldY = Number(poi.worldY);
      const sceneX = worldX - baseX;
      const sceneY = worldY - baseY;
      if (
        !Number.isFinite(worldX) ||
        !Number.isFinite(worldY) ||
        !Number.isFinite(sceneX) ||
        !Number.isFinite(sceneY) ||
        sceneX < 0 ||
        sceneY < 0 ||
        sceneX >= sceneSizeX ||
        sceneY >= sceneSizeY
      ) {
        return undefined;
      }

      const selectedOption = scenePoiDefaultOption(poi, option);
      const targetText = poi.name ? `<col=ffff>${poi.name}</col>` : "";
      const action = selectedOption
        ? {
            option: selectedOption,
            actionIndex: 1,
            menuAction: "GAME_OBJECT_FIRST_OPTION",
            identifier: Number(poi.id),
            param0: sceneX,
            param1: sceneY,
            itemId: -1,
            target: targetText,
          }
        : undefined;

      return {
        ...poi,
        coordinateSource: "scenePoiMenuAction",
        param0: sceneX,
        param1: sceneY,
        identifier: Number(poi.id),
        itemId: -1,
        menuAction: action?.menuAction,
        option: action?.option,
        target: targetText,
        menuActions: action ? [action] : [],
        scenePoiFallback: true,
      } as RuneLiteTarget;
    })
    .filter((target: RuneLiteTarget | undefined): target is RuneLiteTarget => Boolean(target));
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

async function selectActionTarget(
  baseURL: string,
  snapshot: RuneLiteSnapshot,
  entityType: string,
  name?: string,
  id?: number,
  nearestToPlayer?: boolean,
  coordinateSource?: string,
  option?: string
): Promise<RuneLiteTarget | undefined> {
  const target = selectLiveTarget(snapshot, entityType, name, id, nearestToPlayer, coordinateSource);
  if (target) {
    return target;
  }

  if (entityType.toLowerCase() !== "object" && entityType.toLowerCase() !== "objects") {
    return undefined;
  }

  const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
  const fallbackTargets = sortNearestToPlayer(
    sortByDistance(await scenePoiObjectTargets(baseURL, name, id, option)),
    playerLocation
  );
  return fallbackTargets.find((candidate: any) => hasDirectMenuParams(candidate));
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

server.registerResource(
  "transport-graph",
  "osrs://transport/graph",
  {
    title: "OSRS Transport Graph",
    description: "Curated F2P foundation graph of major locations and walking edges used by System 1 route planning.",
    mimeType: "application/json",
  },
  async () => resourceText("osrs://transport/graph", {
    status: "TRANSPORT_GRAPH_READY",
    provider: "graphology_transport_graph",
    callsLlm: false,
    ...transportGraphSummary(),
  })
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
          "4. For Twin-Brain autonomy, issue bounded policies through load_policy and monitor reflex_status/reflex_history.",
          "5. Use navigate_to for bounded travel planning or one explicitly armed navigation step.",
          "6. Prefer high-level policy tools over raw input; raw mouse/keyboard requires request_os_control approval.",
          "7. Verify each action through snapshot changes, chat messages, location, animation, inventory, or interfaceSummary.",
          "8. Before risky actions, call mark_action_baseline; afterward use verify_last_action for snapshot diffs.",
          "9. When coordinates are needed for debugging, reject stale or warning-marked targets; raw coordinate clicks are fallback only.",
          "10. Use wait_for_game_tick for timing-sensitive verification.",
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

let osControlApprovedUntil = 0;

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function osControlPayload(reason: string) {
  return {
    status: "OS_CONTROL_REQUIRED",
    reason,
    requestFile: osControlRequestPath,
    approvalCommand: "npm run approve-os-control",
    timeoutMs: 60000,
    note: "Gameplay uses in-client RuneLite actions by default. Hardware mouse/keyboard input is blocked unless this request is explicitly approved.",
  };
}

async function requireOsControl(reason: string) {
  if (Date.now() < osControlApprovedUntil && !(await fileExists(osControlRequestPath))) {
    return;
  }
  throw new Error(JSON.stringify(osControlPayload(reason)));
}

async function notifyOsControlRequest(reason: string) {
  try {
    const notifier = require("node-notifier") as {
      notify: (options: Record<string, unknown>) => void;
    };
    notifier.notify({
      title: "OSRS MCP needs OS control",
      message: reason,
      wait: false,
    });
  } catch {
    // Notification support is best-effort; the request file is authoritative.
  }
}

async function waitForOsControlApproval(timeoutMs = 60000, pollMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await fileExists(osControlRequestPath))) {
      osControlApprovedUntil = Date.now() + timeoutMs;
      return {
        approved: true,
        waitedMs: Date.now() - startedAt,
        approvedUntil: osControlApprovedUntil,
      };
    }
    await sleep(pollMs);
  }
  osControlApprovedUntil = 0;
  return {
    approved: false,
    waitedMs: Date.now() - startedAt,
    stopReason: "OS_CONTROL_REQUEST_TIMEOUT",
  };
}

async function typeHardwareInput(input: any, reason: string) {
  await requireOsControl(reason);
  return keyboard.type(input);
}

async function readClientState(baseURL: string) {
  const [identityResponse, stateResponse] = await Promise.all([
    runeliteApi(baseURL).get("/identity"),
    runeliteApi(baseURL).get("/state").catch(() => undefined),
  ]);
  const identity = identityResponse.data;
  const state = stateResponse?.data ?? {};
  return {
    ...identity,
    ...state,
    tick: state?.tick ?? identity?.gameTick,
    status: identity?.playerName ? "LOGGED_IN" : "UNKNOWN",
    name: state?.name ?? identity?.playerName,
  };
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
  const target = await selectActionTarget(
    baseURL,
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
  const targetClient = { instanceId: args.instanceId, playerName: args.playerName, port: args.port };
  const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
  await assertClientLoggedIn(baseURL);
  const expectedSource = args.coordinateSource ?? defaultCoordinateSourceForType(args.entityType);
  const target = await selectActionTarget(
    baseURL,
    snapshot,
    args.entityType,
    args.name,
    args.id,
    args.nearestToPlayer ?? true,
    args.coordinateSource,
    args.option
  );
  if (!target) {
    return {
      actionMode: "target_not_visible",
      success: false,
      executed: false,
      requested: {
        entityType: args.entityType,
        name: args.name,
        id: args.id,
        option: args.option,
      },
      stopReason: "TARGET_NOT_VISIBLE",
      reason: "No matching target is currently visible in the RuneLite snapshot or scene POI feed.",
    };
  }

  const directAction = directMenuActionForTarget(target, args.option);
  if (directAction) {
    const actionResult = await invokeMenuAction(baseURL, directAction);
    return {
      actionMode: "direct_menu_action",
      target: compactTarget(target),
      selected: {
        option: directAction.option,
        menuAction: directAction.menuAction,
        param0: directAction.param0,
        param1: directAction.param1,
        identifier: directAction.identifier,
        itemId: directAction.itemId,
      },
      actionResult,
    };
  }

  requireFreshClickable(target, args.maxAgeMs ?? 600, expectedSource);

  return {
    actionMode: "in_client_action_unavailable",
    success: false,
    executed: false,
    target: compactTarget(target),
    requestedOption: args.option,
    stopReason: "OS_CONTROL_REQUIRED",
    ...osControlPayload(`No direct in-client menu action was available for ${args.entityType} ${target.name ?? target.id} option '${args.option}'.`),
  };
}

function widgetActionIndex(widget: any, actionText: string): { actionIndex: number; option: string } | undefined {
  const needle = actionText.toLowerCase();
  const actions = Array.isArray(widget?.actions) ? widget.actions : [];
  const index = actions.findIndex((action: unknown) => String(action ?? "").toLowerCase().includes(needle));
  if (index < 0) {
    return undefined;
  }
  return { actionIndex: index + 1, option: String(actions[index]) };
}

async function invokeVisibleWidgetAction(baseURL: string, widget: any, actionText: string) {
  const action = widgetActionIndex(widget, actionText);
  if (!action) {
    throw new Error(JSON.stringify(osControlPayload(`Visible widget has no in-client action matching '${actionText}'.`)));
  }
  if (!Number.isFinite(widget?.packedId) && !(Number.isFinite(widget?.groupId) && Number.isFinite(widget?.childId))) {
    throw new Error(JSON.stringify(osControlPayload(`Visible widget for '${actionText}' has no packedId/groupId+childId for in-client invocation.`)));
  }
  return invokeWidgetAction(baseURL, {
    packedId: widget.packedId,
    groupId: widget.groupId,
    childId: widget.childId,
    actionIndex: action.actionIndex,
    itemId: widget.itemId,
    option: action.option,
    target: widget.name ?? widget.text ?? "",
  });
}

async function clickMinimapProjection(worldX: number, worldY: number, plane: number | undefined, target: ClientTarget = {}, maxAgeMs = 1000) {
  const api = await apiForTarget(target);
  await assertClientReady(api.defaults.baseURL ?? selectedRuneliteApi, { requireActiveWindow: true });
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
  const action = await invokeVisibleWidgetAction(baseURL, shopTarget, actionText);
  return { ...shopTarget, actionMode: "in_client_widget_action", action };
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
  const action = await invokeVisibleWidgetAction(baseURL, bankTarget, actionText);
  return { ...bankTarget, actionMode: "in_client_widget_action", action };
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
  const baseURL = await resolveRuneliteApi(target);
  const directAction = directMenuActionForTarget(item, "Use");
  if (!directAction) {
    throw new Error(JSON.stringify(osControlPayload(`Inventory item ${item.name ?? item.id} has no direct in-client Use action.`)));
  }
  return invokeMenuAction(baseURL, directAction);
}

async function selectInventoryItemOption(item: RuneLiteTarget & { slotScreenX: number; slotScreenY: number }, option: string, target: ClientTarget) {
  const baseURL = await resolveRuneliteApi(target);
  let directAction = directMenuActionForTarget(item, option);
  const inventoryActions = Array.isArray((item as any).menuActions) ? (item as any).menuActions : [];
  const actionMetadata = inventoryActions.find((action: any) => matchesOption(action?.option, option));
  if (directAction && String(directAction.menuAction).startsWith("ITEM_")) {
    directAction = {
      ...directAction,
      menuAction: "CC_OP_LOW_PRIORITY",
      identifier: Number.isFinite(actionMetadata?.actionIndex) ? Number(actionMetadata.actionIndex) + 2 : directAction.identifier,
      target: directAction.target || `<col=ff9040>${item.name ?? ""}</col>`,
    };
  }
  if (!directAction) {
    throw new Error(JSON.stringify(osControlPayload(`Inventory item ${item.name ?? item.id} has no direct in-client '${option}' action.`)));
  }
  return invokeMenuAction(baseURL, directAction);
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

  return {
    ...match,
    actionMode: "in_client_action_unavailable",
    success: false,
    executed: false,
    ...osControlPayload(`Context menu entry '${text}' has no in-client menu params.`),
  };
}

function isPlayerIdle(state: any): boolean {
  return state?.isIdle === true || (state?.animation === -1 && !state?.interactingWith);
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
    menuAction: target.menuAction,
    identifier: target.identifier,
    param0: target.param0,
    param1: target.param1,
    itemId: target.itemId,
    ageMs: target.ageMs,
  };
}

function matchesOption(actual: unknown, requested: string) {
  const actualText = String(actual ?? "").trim().toLowerCase();
  const requestedText = requested.trim().toLowerCase();
  return actualText === requestedText || actualText.replace(/-/g, " ") === requestedText.replace(/-/g, " ");
}

function directMenuActionForTarget(target: RuneLiteTarget, option: string) {
  const actions = Array.isArray((target as any).menuActions) ? (target as any).menuActions : [];
  const matchedAction = actions.find((action: any) => matchesOption(action?.option, option));
  const source = matchedAction ?? (matchesOption(target.option, option) ? target : undefined);
  if (!source) {
    return undefined;
  }
  if (!Number.isFinite(source.param0) || !Number.isFinite(source.param1) || !source.menuAction) {
    return undefined;
  }
  const identifier = Number.isFinite(source.identifier) ? source.identifier : source.id;
  if (!Number.isFinite(identifier)) {
    return undefined;
  }
  return {
    param0: source.param0,
    param1: source.param1,
    menuAction: source.menuAction,
    identifier,
    itemId: Number.isFinite(source.itemId) ? source.itemId : -1,
    option: source.option ?? option,
    target: source.target ?? "",
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
      ? await selectActionTarget(baseURL, snapshot, entityType, stepArgs.name, stepArgs.id, stepArgs.nearestToPlayer ?? true, undefined, stepArgs.option)
      : undefined;
    const fresh = Boolean(target && (!target.ageMs || target.ageMs <= maxAgeMs));
    const directAction = target && stepArgs.option ? directMenuActionForTarget(target, stepArgs.option) : undefined;
    const actionReady = Boolean(directAction || (target && hasScreenPoint(target)));
    return {
      ...base,
      valid: Boolean(target) && fresh && actionReady,
      validationMode: directAction ? "fresh_target_direct_menu_action" : "fresh_target_snapshot",
      reason: target
        ? fresh
          ? actionReady
            ? directAction
              ? "Matching live target is present with in-client menu action params."
              : "Matching live target is present and fresh."
            : "Matching target exists but has no direct in-client menu params or screen point."
          : "Matching target exists but is stale."
        : "No matching target is currently visible in the snapshot.",
      target: compactTarget(target),
    };
  }

  if (tool === "perform_until") {
    const target = await selectActionTarget(baseURL, snapshot, stepArgs.actionEntityType, stepArgs.actionName, stepArgs.actionId, stepArgs.nearestToPlayer ?? true, undefined, stepArgs.actionOption);
    const fresh = Boolean(target && (!target.ageMs || target.ageMs <= maxAgeMs));
    const directAction = target && stepArgs.actionOption ? directMenuActionForTarget(target, stepArgs.actionOption) : undefined;
    const actionReady = Boolean(directAction || (target && hasScreenPoint(target)));
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
      valid: Boolean(target) && fresh && actionReady,
      validationMode: directAction ? "loop_target_direct_menu_action" : "loop_target_and_condition_snapshot",
      reason: target
        ? fresh
          ? actionReady
            ? directAction
              ? "Loop target is present with in-client menu action params."
              : "Loop target is present and fresh."
            : "Loop target exists but has no direct in-client menu params or screen point."
          : "Loop target exists but is stale."
        : "No matching loop action target is currently visible.",
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

  if (tool === "drop_inventory_item") {
    const item = findInventoryItem(snapshot, stepArgs.name, stepArgs.id, stepArgs.slot) as any;
    const fresh = Boolean(item && Number.isFinite(item.slotScreenX) && Number.isFinite(item.slotScreenY) && (!item.ageMs || item.ageMs <= maxAgeMs));
    return {
      ...base,
      valid: fresh,
      validationMode: "inventory_drop_snapshot",
      item: item ? { id: item.id, name: item.name, slot: item.slot, quantity: item.quantity, ageMs: item.ageMs } : null,
      reason: fresh ? "Matching inventory item is present with fresh slot coordinates." : "No fresh matching inventory item is available to drop.",
    };
  }

  return {
    ...base,
    valid: false,
    validationMode: "unsupported_step_validation",
    reason: `No safe validator is registered for tool ${tool}.`,
  };
}

function stepTargetArgs(stepArgs: any, target: ClientTarget): any {
  return {
    ...stepArgs,
    instanceId: stepArgs.instanceId ?? target.instanceId,
    playerName: stepArgs.playerName ?? target.playerName,
    port: stepArgs.port ?? target.port,
  };
}

function clickToolEntityType(tool: string): "object" | "npc" | "ground_item" | undefined {
  switch (tool) {
    case "click_object":
      return "object";
    case "click_npc":
      return "npc";
    case "click_ground_item":
      return "ground_item";
    default:
      return undefined;
  }
}

async function dropInventoryItemAction(args: {
  name?: string;
  id?: number;
  slot?: number;
  instanceId?: string;
  playerName?: string;
  port?: number;
}) {
  const target = { instanceId: args.instanceId, playerName: args.playerName, port: args.port };
  const { baseURL, snapshot } = await getSnapshotForTarget(target, true);
  await assertClientReady(baseURL);
  const item = findInventoryItem(snapshot, args.name, args.id, args.slot);
  requireFreshInventoryItem(item, 1000);

  const inventoryActions = Array.isArray((item as any).menuActions) ? (item as any).menuActions : [];
  const dropActionMetadata = inventoryActions.find((action: any) => matchesOption(action?.option, "Drop"));
  let directAction = directMenuActionForTarget(item, "Drop");
  if (directAction && String(directAction.menuAction).startsWith("ITEM_")) {
    directAction = {
      ...directAction,
      menuAction: "CC_OP_LOW_PRIORITY",
      identifier: Number.isFinite(dropActionMetadata?.actionIndex) ? Number(dropActionMetadata.actionIndex) + 2 : 7,
      target: directAction.target || `<col=ff9040>${item.name ?? ""}</col>`,
    };
  }
  if (!directAction && Number.isFinite((item as any).slot) && Number.isFinite((item as any).inventoryWidgetId) && Number.isFinite((item as any).id)) {
    directAction = {
      param0: Number((item as any).slot),
      param1: Number((item as any).inventoryWidgetId),
      menuAction: "CC_OP_LOW_PRIORITY",
      identifier: 7,
      itemId: Number((item as any).id),
      option: "Drop",
      target: `<col=ff9040>${item.name ?? ""}</col>`,
    };
  }
  if (directAction) {
    const action = await invokeMenuAction(baseURL, directAction);
    return {
      success: true,
      executed: true,
      actionMode: "direct_inventory_menu_action",
      selected: {
        option: directAction.option,
        menuAction: directAction.menuAction,
        param0: directAction.param0,
        param1: directAction.param1,
        identifier: directAction.identifier,
        itemId: directAction.itemId,
      },
      action,
      item: { id: item.id, name: item.name, slot: item.slot, quantity: item.quantity },
    };
  }

  return {
    success: false,
    executed: false,
    actionMode: "in_client_action_unavailable",
    ...osControlPayload(`Inventory item ${item.name ?? item.id} has no direct in-client Drop action.`),
    item: { id: item.id, name: item.name, slot: item.slot, quantity: item.quantity },
  };
}

async function dryRunAgentStep(baseURL: string, step: any, target: ClientTarget) {
  const tool = step?.tool;
  const stepArgs = stepTargetArgs(step?.arguments ?? {}, target);
  if (tool === "invoke_menu_action") {
    return invokeMenuAction(baseURL, { ...stepArgs, dryRun: true, tickAligned: false });
  }
  if (tool === "invoke_walk_action") {
    return invokeWalkAction(baseURL, { ...stepArgs, dryRun: true, tickAligned: false });
  }
  if (tool === "invoke_widget_action") {
    return invokeWidgetAction(baseURL, { ...stepArgs, dryRun: true, tickAligned: false });
  }
  if (tool === "interact_with" || clickToolEntityType(tool)) {
    return {
      success: true,
      dryRun: true,
      actionMode: "validation_only",
      reason: "This target interaction uses the live context menu and cannot be fully dry-run without moving/clicking. execute_agent_step validated the target snapshot and did not click.",
      plannedInteraction: {
        tool,
        entityType: stepArgs.entityType ?? clickToolEntityType(tool),
        name: stepArgs.name,
        id: stepArgs.id,
        option: stepArgs.option,
        nearestToPlayer: stepArgs.nearestToPlayer ?? true,
      },
    };
  }
  if (tool === "perform_until") {
    const snapshot = await getSnapshotForBase(baseURL, true);
    const startedAt = Date.now();
    const beforeCondition = conditionMet(snapshot, {
      condition: stepArgs.condition,
      startedAt,
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
      success: true,
      dryRun: true,
      actionMode: "perform_until_one_iteration_preview",
      reason: beforeCondition.met
        ? "The stop condition is already met; no interaction would be performed."
        : "execute_agent_step would perform exactly one interaction from this loop, then return control for verification.",
      beforeCondition,
      plannedInteraction: {
        tool: "interact_with",
        entityType: stepArgs.actionEntityType,
        name: stepArgs.actionName,
        id: stepArgs.actionId,
        option: stepArgs.actionOption,
        nearestToPlayer: stepArgs.nearestToPlayer ?? true,
      },
    };
  }
  if (tool === "deposit_inventory_item" || tool === "withdraw_bank_item") {
    return {
      success: true,
      dryRun: true,
      actionMode: "bank_action_preview",
      plannedInteraction: {
        tool,
        quantity: stepArgs.quantity,
        itemName: stepArgs.itemName,
        itemId: stepArgs.itemId,
      },
    };
  }
  if (tool === "drop_inventory_item") {
    return {
      success: true,
      dryRun: true,
      actionMode: "drop_inventory_item_preview",
      plannedInteraction: {
        tool,
        name: stepArgs.name,
        id: stepArgs.id,
        slot: stepArgs.slot,
      },
    };
  }
  return {
    success: false,
    dryRun: true,
    reason: `execute_agent_step does not support dry-running ${tool}.`,
  };
}

async function executeAgentStepAction(baseURL: string, step: any, target: ClientTarget, args: {
  tickAligned?: boolean;
  tickTimeoutMs?: number;
}) {
  const tool = step?.tool;
  const stepArgs = stepTargetArgs(step?.arguments ?? {}, target);
  if (!EXECUTABLE_AGENT_TOOLS.has(tool)) {
    return {
      success: false,
      executed: false,
      reason: `execute_agent_step can only execute one supported action tool, not ${tool}.`,
    };
  }

  if (tool === "invoke_menu_action") {
    return invokeMenuAction(baseURL, {
      ...stepArgs,
      dryRun: false,
      tickAligned: stepArgs.tickAligned ?? args.tickAligned,
      tickTimeoutMs: stepArgs.tickTimeoutMs ?? args.tickTimeoutMs,
    });
  }
  if (tool === "invoke_walk_action") {
    return invokeWalkAction(baseURL, {
      ...stepArgs,
      dryRun: false,
      tickAligned: stepArgs.tickAligned ?? args.tickAligned,
      tickTimeoutMs: stepArgs.tickTimeoutMs ?? args.tickTimeoutMs,
    });
  }
  if (tool === "invoke_widget_action") {
    return invokeWidgetAction(baseURL, {
      ...stepArgs,
      dryRun: false,
      tickAligned: stepArgs.tickAligned ?? args.tickAligned,
      tickTimeoutMs: stepArgs.tickTimeoutMs ?? args.tickTimeoutMs,
    });
  }
  if (tool === "perform_until") {
    const startedAt = Date.now();
    const snapshot = await getSnapshotForBase(baseURL, true);
    const beforeCondition = conditionMet(snapshot, {
      condition: stepArgs.condition,
      startedAt,
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
    if (beforeCondition.met) {
      return {
        success: true,
        executed: false,
        actionMode: "perform_until_condition_already_met",
        beforeCondition,
        reason: "The stop condition was already met, so execute_agent_step did not perform an interaction.",
      };
    }
    const action = await interactWithTarget({
      entityType: stepArgs.actionEntityType,
      name: stepArgs.actionName,
      id: stepArgs.actionId,
      option: stepArgs.actionOption,
      nearestToPlayer: stepArgs.nearestToPlayer ?? true,
      instanceId: stepArgs.instanceId,
      playerName: stepArgs.playerName,
      port: stepArgs.port,
    });
    return {
      success: true,
      executed: true,
      actionMode: "perform_until_one_iteration",
      beforeCondition,
      action,
      nextInstruction: "This executed one iteration only. Verify the result before calling execute_agent_step again.",
    };
  }
  if (tool === "deposit_inventory_item") {
    const actionText = stepArgs.quantity ? `Deposit-${stepArgs.quantity}` : "Deposit";
    const targetWidget = await clickBankAction(actionText, stepArgs.itemName, stepArgs.itemId, stepArgs.rightClick, target);
    return {
      success: true,
      executed: true,
      actionMode: "deposit_inventory_item",
      actionText,
      target: targetWidget,
    };
  }
  if (tool === "withdraw_bank_item") {
    const actionText = stepArgs.quantity ? `Withdraw-${stepArgs.quantity}` : "Withdraw";
    const targetWidget = await clickBankAction(actionText, stepArgs.itemName, stepArgs.itemId, stepArgs.rightClick, target);
    return {
      success: true,
      executed: true,
      actionMode: "withdraw_bank_item",
      actionText,
      target: targetWidget,
    };
  }
  if (tool === "drop_inventory_item") {
    return dropInventoryItemAction(stepArgs);
  }

  const entityType = stepArgs.entityType ?? clickToolEntityType(tool);
  if (!entityType) {
    return {
      success: false,
      executed: false,
      reason: `No entity type could be inferred for ${tool}.`,
    };
  }
  if (!stepArgs.option) {
    return {
      success: false,
      executed: false,
      reason: `${tool} requires an option when executed through execute_agent_step so it can use the context-menu/in-client action path instead of a blind coordinate click.`,
    };
  }

  return interactWithTarget({
    ...stepArgs,
    entityType,
    option: stepArgs.option,
  });
}

async function runEatFoodStep(baseURL: string, step: ReflexStep, target: ClientTarget, mode: ReflexExecutionMode) {
  const stepArgs = stepTargetArgs(step.arguments ?? {}, target);
  const snapshot = await getSnapshotForBase(baseURL, true);
  const currentHp = Number(snapshot.state?.health);
  const currentPercent = healthPercent(snapshot);
  const shouldEatByHp = stepArgs.hpBelow === undefined || (Number.isFinite(currentHp) && currentHp < stepArgs.hpBelow);
  const shouldEatByPercent = stepArgs.hpBelowPercent === undefined || (currentPercent !== undefined && currentPercent < stepArgs.hpBelowPercent);
  const item = findFoodItem(snapshot, stepArgs.foodNames, stepArgs.foodName, stepArgs.foodId, stepArgs.slot) as any;
  const validation = {
    valid: shouldEatByHp && shouldEatByPercent && Boolean(item),
    validationMode: "reflex_survival_guard",
    health: currentHp,
    healthPercent: currentPercent,
    item: item ? { id: item.id, name: item.name, slot: item.slot, quantity: item.quantity } : null,
    reason: !shouldEatByHp || !shouldEatByPercent
      ? "Hitpoints are above the policy threshold."
      : item
        ? "Food is available and threshold is met."
        : "No matching food item is available.",
  };

  if (!validation.valid) {
    return {
      status: "EXECUTION_BLOCKED",
      willExecute: false,
      executed: false,
      step,
      validation,
      reason: validation.reason,
    };
  }

  if (mode !== "execute") {
    return {
      status: "DRY_RUN_READY",
      willExecute: false,
      executed: false,
      step,
      validation,
      actionResult: {
        success: true,
        dryRun: true,
        plannedInteraction: { tool: "eat_food_when", item: validation.item },
      },
    };
  }

  await assertClientReady(baseURL);
  requireFreshInventoryItem(item, 1000);
  const selected = await selectInventoryItemOption(item, "Eat", target);
  await sleep(Math.max(100, Number(stepArgs.waitMs ?? 700)));
  const after = await getSnapshotForBase(baseURL, true);

  return {
    status: "EXECUTED_ONE_STEP",
    willExecute: true,
    executed: true,
    step,
    validation,
    actionResult: {
      success: true,
      executed: true,
      selected,
      before: { health: currentHp, healthPercent: currentPercent },
      after: { health: after.state?.health, healthPercent: healthPercent(after) },
    },
  };
}

async function navigateToDestinationAction(args: {
  destination: string;
  from?: string;
  executionMode?: "dry_run" | "execute";
  confirmExecution?: string;
  maxStepTiles?: number;
  waypointRadius?: number;
  targetClient?: ClientTarget;
}) {
  const wantsExecution = args.executionMode === "execute";
  const targetClient = args.targetClient ?? {};
  let currentLocation: any;
  let baseURL: string | undefined;
  let snapshot: RuneLiteSnapshot | undefined;

  if (!args.from || (wantsExecution && args.confirmExecution === NAVIGATE_EXECUTE_CONFIRMATION)) {
    const current = await getSnapshotForTarget(targetClient, true);
    baseURL = current.baseURL;
    snapshot = current.snapshot;
    currentLocation = current.snapshot.state?.location;
  }

  const route = planTransportRoute({ from: args.from, to: args.destination, currentLocation });
  const responseBase = {
    ...route,
    willExecute: wantsExecution,
    executed: false,
    executionMode: args.executionMode ?? "dry_run",
    oneStepOnly: true,
    nextWaypoint: route.status === "ROUTE_PLANNED"
      ? nextRouteWaypoint(route, currentLocation, args.waypointRadius ?? 8)
      : undefined,
    callsLlm: false,
  };

  if (route.status !== "ROUTE_PLANNED") {
    return { ...responseBase, stopReason: route.stopReason };
  }

  if (!wantsExecution) {
    return {
      ...responseBase,
      nextInstruction: `To move one bounded step, call navigate_to with executionMode='execute' and confirmExecution='${NAVIGATE_EXECUTE_CONFIRMATION}'.`,
    };
  }

  if (args.confirmExecution !== NAVIGATE_EXECUTE_CONFIRMATION) {
    return {
      ...responseBase,
      willExecute: false,
      requiredConfirmation: NAVIGATE_EXECUTE_CONFIRMATION,
      stopReason: "Navigation execution was requested but not armed.",
    };
  }

  if (!snapshot || !baseURL) {
    throw new Error("A live RuneLite client is required to execute a navigation step.");
  }

  const waypoint = nextRouteWaypoint(route, snapshot.state?.location, args.waypointRadius ?? 8);
  if (!waypoint) {
    return {
      ...responseBase,
      stopReason: "No next route waypoint is available.",
    };
  }
  let localStep: PathStep | undefined;
  let localPath: any;
  try {
    localPath = await calculateCollisionAwarePath(baseURL, waypoint.worldX, waypoint.worldY, waypoint.plane, 4096);
    if (!localPath.success) {
      throw new Error(localPath.message ?? localPath.error ?? "Collision-aware local path unavailable");
    }
    localStep = chooseLocalPathStep(localPath, args.maxStepTiles ?? 18);
  } catch (pathError: any) {
    return {
      ...responseBase,
      status: "NAVIGATION_BLOCKED",
      willExecute: false,
      executed: false,
      nextWaypoint: waypoint,
      stopReason: "LOCAL_COLLISION_PATH_REQUIRED",
      action: {
        mode: "in_client_only",
        osFallback: false,
        localPath: {
          success: false,
          error: "COLLISION_LOCAL_PATH_FAILED",
          message: pathError?.message ?? String(pathError),
        },
      },
      nextInstruction: "The next waypoint is not reachable through the loaded-scene collision map. Add a global path bridge, more intermediate waypoints, or explicitly approve a different travel primitive.",
    };
  }

  if (!localStep) {
    return {
      ...responseBase,
      status: "NAVIGATION_BLOCKED",
      willExecute: false,
      executed: false,
      nextWaypoint: waypoint,
      stopReason: "NO_LOCAL_NAVIGATION_STEP_AVAILABLE",
      action: {
        mode: "in_client_only",
        osFallback: false,
        localPath,
      },
    };
  }

  let action: any;
  try {
    const walk = await invokeWalkAction(baseURL, {
      worldX: localStep.worldX,
      worldY: localStep.worldY,
      plane: localStep.plane,
      tickAligned: true,
    });
    const wait = await waitUntilBaseLocation(
      baseURL,
      localStep.worldX,
      localStep.worldY,
      localStep.plane,
      localStep.final ? Math.max(1, args.waypointRadius ?? 3) : 2,
      8000,
      500,
    );
    action = {
      mode: localPath?.success ? "collision_aware_local" : "straight_line_local",
      walk,
      wait,
      localPath,
    };
  } catch (clientActionError: any) {
    return {
      ...responseBase,
      status: "NAVIGATION_BLOCKED",
      willExecute: false,
      executed: false,
      nextWaypoint: waypoint,
      selectedStep: localStep,
      stopReason: `IN_CLIENT_NAVIGATION_STEP_FAILED:${clientActionError?.message ?? String(clientActionError)}`,
      action: {
        mode: "in_client_only",
        osFallback: false,
        reason: clientActionError?.message ?? String(clientActionError),
      },
      nextInstruction: "System 1 did not use minimap/OS fallback. Re-plan with a closer in-client route step or request OS control explicitly.",
    };
  }

  return {
    ...responseBase,
    executed: true,
    nextWaypoint: waypoint,
    selectedStep: localStep,
    action,
    nextInstruction: "System 1 moved one bounded step. Re-read state and call navigate_to again if the policy still requires travel.",
  };
}

async function observeReflexPolicy(policy: LoadedReflexPolicy) {
  const baseURL = await resolveRuneliteApi(policy.targetClient ?? {});
  const [snapshot, stateResponse, inventoryResponse, playersResponse] = await Promise.all([
    getSnapshotForBase(baseURL, true),
    runeliteApi(baseURL).get("/state").catch(() => undefined),
    runeliteApi(baseURL).get("/inventory").catch(() => undefined),
    runeliteApi(baseURL).get("/players").catch(() => undefined),
  ]);
  const liveState = stateResponse?.data ?? snapshot.state ?? {};
  const liveInventory = Array.isArray(inventoryResponse?.data) ? inventoryResponse.data : (snapshot.inventory ?? []);
  const livePlayers = Array.isArray(playersResponse?.data) ? playersResponse.data : (snapshot.players ?? []);
  const liveSnapshot = {
    ...snapshot,
    state: liveState,
    inventory: liveInventory,
    players: livePlayers,
  } as RuneLiteSnapshot;
  let minimapThreat: any;
  if (policy.stopOnMinimapPlayerThreat) {
    try {
      minimapThreat = (await runeliteApi(baseURL).get("/minimap/icons", {
        params: { maxEntities: 80 },
      })).data;
    } catch (error: any) {
      minimapThreat = {
        status: "MINIMAP_THREAT_UNAVAILABLE",
        error: error?.message ?? String(error),
      };
    }
  }
  return {
    baseURL,
    snapshot: liveSnapshot,
    health: Number.isFinite(Number(liveSnapshot.state?.health)) ? Number(liveSnapshot.state?.health) : undefined,
    healthPercent: healthPercent(liveSnapshot),
    inventorySlotsUsed: inventorySlotsUsed(liveSnapshot),
    inventoryFull: inventorySlotsUsed(liveSnapshot) >= 28,
    inventory: liveSnapshot.inventory ?? [],
    visiblePlayers: liveSnapshot.players ?? [],
    minimapPlayerThreat: minimapThreat?.visiblePlayerThreat === true,
    minimapThreat,
    bankOpen: liveSnapshot.interfaceSummary?.bankContainerAvailable === true,
    location: liveSnapshot.state?.location,
    isIdle: isPlayerIdle(liveSnapshot.state ?? {}),
    capturedAt: liveSnapshot.state?.capturedAt ?? (liveSnapshot as any).capturedAt,
    summary: {
      location: liveSnapshot.state?.location,
      animation: liveSnapshot.state?.animation,
      interacting: liveSnapshot.state?.interacting,
      dialogueType: liveSnapshot.interfaceSummary?.dialogueType ?? liveSnapshot.dialogue?.type,
      minimapPlayerThreat: minimapThreat?.visiblePlayerThreat === true,
      visibleMinimapPlayers: minimapThreat?.visiblePlayerCount,
    },
  };
}

async function runReflexPolicyStep(step: ReflexStep, policy: LoadedReflexPolicy, mode: ReflexExecutionMode) {
  const targetClient = policy.targetClient ?? {};
  const baseURL = await resolveRuneliteApi(targetClient);

  if (step.tool === "eat_food_when") {
    return runEatFoodStep(baseURL, step, targetClient, mode);
  }

  if (step.tool === "navigate_to") {
    const result = await navigateToDestinationAction({
      ...(step.arguments ?? {}),
      destination: String(step.arguments?.destination ?? policy.destination ?? policy.objective ?? ""),
      targetClient,
      executionMode: mode === "execute" ? "execute" : "dry_run",
      confirmExecution: mode === "execute" ? NAVIGATE_EXECUTE_CONFIRMATION : undefined,
    });
    return {
      status: result.status === "ROUTE_PLANNED" && result.executed === true
        ? "EXECUTED_ONE_STEP"
        : result.status === "ROUTE_PLANNED"
          ? "DRY_RUN_READY"
          : "EXECUTION_BLOCKED",
      willExecute: mode === "execute",
      executed: result.executed === true,
      step,
      validation: {
        valid: result.status === "ROUTE_PLANNED",
        routeStatus: result.status,
        stopReason: result.stopReason,
      },
      actionResult: result,
      reason: result.stopReason,
    };
  }

  const snapshot = await getSnapshotForBase(baseURL, true);
  const validation = await validatePreparedStep(baseURL, snapshot, step, {
    dryRunRawActions: true,
    maxAgeMs: 1200,
  });

  if (!validation.valid) {
    return {
      status: "EXECUTION_BLOCKED",
      willExecute: false,
      executed: false,
      step,
      validation,
      reason: validation.reason ?? "The Reflex Engine step did not validate against current state.",
    };
  }

  if (mode !== "execute") {
    return {
      status: "DRY_RUN_READY",
      willExecute: false,
      executed: false,
      step,
      validation,
      actionResult: await dryRunAgentStep(baseURL, step, targetClient),
    };
  }

  if (!EXECUTABLE_AGENT_TOOLS.has(step.tool)) {
    return {
      status: "EXECUTION_BLOCKED",
      willExecute: false,
      executed: false,
      step,
      validation,
      reason: `Reflex Engine cannot execute unsupported tool ${step.tool}.`,
    };
  }

  const actionResult = await executeAgentStepAction(baseURL, step, targetClient, {
    tickAligned: true,
    tickTimeoutMs: 1800,
  });

  return {
    status: actionResult?.success === false ? "EXECUTION_BLOCKED" : "EXECUTED_ONE_STEP",
    willExecute: true,
    executed: actionResult?.executed !== false,
    step,
    validation,
    actionResult,
    reason: actionResult?.reason,
  };
}

const reflexEngine = new ReflexEngine({
  observe: observeReflexPolicy,
  runStep: runReflexPolicyStep,
  readGameTick: async (policy) => {
    const baseURL = await resolveRuneliteApi(policy.targetClient ?? {});
    const state = await readClientState(baseURL);
    const tick = Number(state?.tick);
    return Number.isFinite(tick) ? tick : undefined;
  },
  onPolicyOutcome: (policy, outcome) => {
    void recordReflexPolicyOutcome(policy, outcome);
  },
}, {
  tickMs: 600,
  maxTicks: 100,
});

async function recordReflexPolicyOutcome(policy: LoadedReflexPolicy, outcome: {
  status: "completed" | "blocked";
  success: boolean;
  reason: string;
}) {
  await ensureAgentMemoryLoaded();
  const goal = policy.objective ?? policy.task ?? policy.id;
  const method = `reflex_policy_v2:${policy.task ?? policy.method ?? "general"}`;
  const policySnapshot = compactReflexPolicyForMemory(policy);
  await agentMemory.appendJournal({
    at: Date.now(),
    kind: "action",
    goal,
    data: {
      source: "ReflexEngine",
      policyId: policy.id,
      task: policy.task,
      method: policy.method,
      success: outcome.success,
      status: outcome.status,
      stopReason: outcome.reason,
      tickCount: policy.tickCount,
      policy: policySnapshot,
      lesson: outcome.success
        ? `Successful Reflex policy for ${goal}: ${outcome.reason}`
        : `Reflex policy blocked for ${goal}: ${outcome.reason}`,
    },
  });

  if (outcome.success) {
    await agentMemory.upsertStrategyCache({
      goal,
      method,
      source: "system1_reflex_outcome",
      status: "READY",
      policy: policySnapshot,
      contextSummary: {
        stopReason: outcome.reason,
        tickCount: policy.tickCount,
        itemName: policy.itemName,
        quantity: policy.quantity,
        quantityMode: policy.quantityMode,
        destination: policy.destination,
      },
      metadata: {
        cachedBy: "ReflexEngine",
        policyId: policy.id,
        completedAt: Date.now(),
      },
    });
    await agentMemory.recordStrategyCacheOutcome(goal, {
      method,
      success: true,
      metadata: {
        lastOutcome: outcome.reason,
        policyId: policy.id,
      },
    });
  }
}

function compactReflexPolicyForMemory(policy: LoadedReflexPolicy) {
  const {
    status,
    loadedAt,
    startedAt,
    updatedAt,
    tickCount,
    lastProcessedGameTick,
    stepIndex,
    stopReason,
    startQuantity,
    targetQuantity,
    ...payload
  } = policy;
  return {
    ...payload,
    startQuantity,
    targetQuantity,
    outcome: {
      status,
      stopReason,
      tickCount,
      startedAt,
      updatedAt,
      lastProcessedGameTick,
      stepIndex,
    },
  };
}

server.registerResource(
  "reflex-status",
  "osrs://reflex/status",
  {
    title: "System 1 Reflex Engine Status",
    description: "Active local policy state, tick-loop status, and recent Reflex Engine events. This resource never calls the LLM.",
    mimeType: "application/json",
  },
  async () => {
    return resourceText("osrs://reflex/status", {
      architecture: "System 1 Reflex Engine",
      callsLlm: false,
      ...reflexEngine.status(),
    });
  }
);

function makeAgentSessionId() {
  return `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function publicAgentSession(session: AgentSession | undefined) {
  if (!session) {
    return null;
  }
  return {
    id: session.id,
    goal: session.goal,
    status: session.status,
    executionMode: session.executionMode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    selectedClient: session.selectedClient,
    stepCount: session.stepCount,
    stopReason: session.stopReason,
    goalState: session.goalState,
    lastSelectedStep: session.lastSelectedStep,
    lastVerification: session.lastVerification,
    historyCount: session.history.length,
    lastEvents: session.history.slice(-10),
  };
}

function getAgentSession(sessionId?: string) {
  if (sessionId) {
    return agentSessions.get(sessionId);
  }
  return activeAgentSessionId ? agentSessions.get(activeAgentSessionId) : undefined;
}

function storedSessionFromAgent(session: AgentSession) {
  return {
    id: session.id,
    goal: session.goal,
    status: session.status,
    executionMode: session.executionMode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    selectedClient: session.selectedClient,
    stepCount: session.stepCount,
    stopReason: session.stopReason,
    goalState: session.goalState,
    lastSelectedStep: session.lastSelectedStep,
    lastVerification: session.lastVerification,
    lastResult: session.lastResult,
  };
}

function persistAgentSession(session: AgentSession | undefined) {
  if (!session) {
    return;
  }
  agentMemory.upsertSession(storedSessionFromAgent(session)).catch((error: any) => {
    console.error(`Agent memory session persistence failed: ${error?.message ?? String(error)}`);
  });
}

async function ensureAgentMemoryLoaded() {
  if (agentMemoryLoaded) {
    return;
  }
  await agentMemory.ensureReady();
  const storedSessions = await agentMemory.listSessions({ limit: 100 });
  for (const stored of storedSessions.reverse()) {
    if (agentSessions.has(stored.id)) {
      continue;
    }
    const events = await agentMemory.getEvents(stored.id, 500);
    const restoredStatus = stored.status === "running" ? "paused" : stored.status;
    const session: AgentSession = {
      id: stored.id,
      goal: stored.goal,
      status: ["created", "running", "paused", "stopped", "completed", "blocked"].includes(restoredStatus)
        ? restoredStatus as AgentSessionStatus
        : "paused",
      executionMode: stored.executionMode,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      selectedClient: stored.selectedClient,
      stepCount: stored.stepCount,
      stopReason: stored.status === "running"
        ? "Restored after MCP server restart; resume explicitly before continuing."
        : stored.stopReason,
      goalState: stored.goalState,
      lastSelectedStep: stored.lastSelectedStep,
      lastVerification: stored.lastVerification,
      lastResult: stored.lastResult,
      history: events.map((event) => ({ at: event.at, type: event.type, data: event.data })),
    };
    agentSessions.set(session.id, session);
    if (stored.status === "running") {
      persistAgentSession(session);
    }
  }
  const newestRunnable = Array.from(agentSessions.values())
    .filter((session) => session.status !== "stopped" && session.status !== "completed")
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const newestAny = Array.from(agentSessions.values()).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  activeAgentSessionId = activeAgentSessionId ?? newestRunnable?.id ?? newestAny?.id;
  agentMemoryLoaded = true;
}

function recordAgentEvent(session: AgentSession | undefined, type: string, data?: any) {
  if (!session) {
    return;
  }
  session.updatedAt = Date.now();
  const event = { at: session.updatedAt, type, data };
  session.history.push(event);
  if (session.history.length > 500) {
    session.history.splice(0, session.history.length - 500);
  }
  agentMemory.upsertSession(storedSessionFromAgent(session)).catch((error: any) => {
    console.error(`Agent memory session persistence failed: ${error?.message ?? String(error)}`);
  });
  agentMemory.appendEvent({ sessionId: session.id, ...event }).catch((error: any) => {
    console.error(`Agent memory event persistence failed: ${error?.message ?? String(error)}`);
  });
}

function jsonTool(data: any): any {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function requestedObjectiveCount(objective?: string): number | undefined {
  const match = String(objective ?? "").match(/\b(\d{1,3})\b/);
  if (!match) {
    return undefined;
  }
  const count = Number(match[1]);
  return Number.isFinite(count) && count > 0 ? Math.min(count, 28) : undefined;
}

function objectiveInventoryItem(objective?: string): string | undefined {
  const text = String(objective ?? "").toLowerCase();
  if (text.includes("oak")) {
    return "Oak logs";
  }
  if (text.includes("willow")) {
    return "Willow logs";
  }
  if (text.includes("maple")) {
    return "Maple logs";
  }
  if (text.includes("yew")) {
    return "Yew logs";
  }
  if (text.includes("log") || text.includes("tree") || text.includes("chop") || text.includes("woodcut")) {
    return "Logs";
  }
  if (text.includes("bone") || text.includes("chicken") || text.includes("cow") || text.includes("combat") || text.includes("kill") || text.includes("attack")) {
    return text.includes("bone") || text.includes("loot") ? "Bones" : undefined;
  }
  return undefined;
}

function initializeSessionGoalState(session: AgentSession, snapshot?: RuneLiteSnapshot) {
  if (session.goalState) {
    return;
  }
  const targetItemName = objectiveInventoryItem(session.goal);
  const requestedQuantity = requestedObjectiveCount(session.goal);
  const startQuantity = targetItemName && snapshot ? inventoryQuantity(snapshot, targetItemName) : undefined;
  session.goalState = {
    targetItemName,
    requestedQuantity,
    startQuantity,
    targetQuantity: targetItemName && requestedQuantity !== undefined && startQuantity !== undefined
      ? Math.min(28, startQuantity + requestedQuantity)
      : undefined,
  };
}

function evaluateSessionGoal(session: AgentSession, snapshot?: RuneLiteSnapshot) {
  initializeSessionGoalState(session, snapshot);
  const targetItemName = session.goalState?.targetItemName;
  const targetQuantity = session.goalState?.targetQuantity;
  if (!targetItemName || targetQuantity === undefined || !snapshot) {
    return { complete: false, reason: "No Phase 2 inventory completion heuristic applies to this objective." };
  }
  const currentQuantity = inventoryQuantity(snapshot, targetItemName);
  return {
    complete: currentQuantity >= targetQuantity,
    targetItemName,
    currentQuantity,
    targetQuantity,
    reason: currentQuantity >= targetQuantity
      ? `${targetItemName} target reached.`
    : `${targetItemName} ${currentQuantity}/${targetQuantity}.`,
  };
}

function memoryProfileFromSnapshot(baseURL: string, snapshot: RuneLiteSnapshot) {
  const skills = Object.fromEntries(Object.entries(snapshot.skills ?? {}).map(([name, value]: [string, any]) => [
    name,
    {
      level: value?.level,
      boostedLevel: value?.boostedLevel,
      xp: value?.xp,
    },
  ]));
  return {
    observedAt: Date.now(),
    baseURL,
    playerName: snapshot.state?.name,
    status: snapshot.state?.status,
    world: (snapshot as any).world,
    location: snapshot.state?.location,
    health: snapshot.state?.health,
    runEnergy: snapshot.state?.runEnergy,
    combat: (snapshot as any).combat,
    skills,
    inventory: {
      slotsUsed: inventorySlotsUsed(snapshot),
      freeSlots: Math.max(0, 28 - inventorySlotsUsed(snapshot)),
      items: (snapshot.inventory ?? [])
        .filter((item: any) => item && item.id && item.id !== -1)
        .map((item: any) => ({ slot: item.slot, id: item.id, name: item.name, quantity: item.quantity })),
    },
    equipment: snapshot.equipment ?? [],
    bankAvailable: Array.isArray(snapshot.bank),
    bankSlotsKnown: Array.isArray(snapshot.bank) ? snapshot.bank.length : undefined,
    interfaceSummary: snapshot.interfaceSummary,
  };
}

async function refreshMemoryProfile(target: ClientTarget = {}) {
  const { baseURL, snapshot } = await getSnapshotForTarget(target, true);
  const profile = memoryProfileFromSnapshot(baseURL, snapshot);
  const stored = await agentMemory.updateProfile(profile);
  await agentMemory.appendJournal({
    at: stored.updatedAt,
    kind: "observation",
    data: {
      source: "profile_refresh",
      playerName: profile.playerName,
      status: profile.status,
      location: profile.location,
      inventorySlotsUsed: profile.inventory.slotsUsed,
    },
  });
  return stored;
}

function inferVerificationForStep(step: any, snapshot: RuneLiteSnapshot): Parameters<typeof waitForActivityVerification>[1] | undefined {
  const args = step?.arguments ?? {};
  if (step?.tool === "perform_until") {
    if (args.condition === "inventory_quantity_at_least" && (args.inventoryItemName || args.inventoryItemId)) {
      const currentQuantity = inventoryQuantity(snapshot, args.inventoryItemName, args.inventoryItemId);
      const requestedTarget = Number(args.inventoryQuantityAtLeast);
      return {
        startedAt: Date.now(),
        inventoryItemName: args.inventoryItemName,
        inventoryItemId: args.inventoryItemId,
        inventoryQuantityAtLeast: Number.isFinite(requestedTarget)
          ? Math.min(requestedTarget, currentQuantity + 1)
          : currentQuantity + 1,
        timeoutMs: 14000,
        pollMs: 700,
      };
    }
    return {
      startedAt: Date.now(),
      expectIdle: true,
      timeoutMs: 14000,
      pollMs: 700,
    };
  }

  if (step?.tool === "interact_with") {
    const option = String(args.option ?? "").toLowerCase();
    if (option === "take") {
      const currentQuantity = inventoryQuantity(snapshot, args.name, args.id);
      return {
        startedAt: Date.now(),
        inventoryItemName: args.name,
        inventoryItemId: args.id,
        inventoryQuantityAtLeast: currentQuantity + 1,
        timeoutMs: 6000,
        pollMs: 500,
      };
    }
    if (option === "attack") {
      return {
        startedAt: Date.now(),
        expectIdle: true,
        timeoutMs: 25000,
        pollMs: 800,
      };
    }
    if (option.includes("talk")) {
      return {
        startedAt: Date.now(),
        dialogueType: "NPC",
        timeoutMs: 8000,
        pollMs: 500,
      };
    }
  }

  if (step?.tool === "invoke_walk_action") {
    return {
      startedAt: Date.now(),
      expectedWorldX: args.worldX,
      expectedWorldY: args.worldY,
      expectedPlane: args.plane,
      locationRadius: 1,
      timeoutMs: 10000,
      pollMs: 500,
    };
  }

  return undefined;
}

async function resolveActivityClient(target: ClientTarget = {}) {
  const clients = await discoverClients();
  if (clients.length === 0) {
    return {
      status: "NO_CLIENT",
      clients,
      reason: "No active RuneLite MCP plugin clients were discovered on ports 8080-8090.",
    };
  }
  const client = selectDiscoveredClient(clients, target, selectedRuneliteApi, selectedClientInstanceId);
  if (!client) {
    return {
      status: "NEEDS_CLIENT_SELECTION",
      clients,
      reason: "Multiple RuneLite clients are active. Use select_client or pass port/instanceId/playerName.",
    };
  }
  const baseURL = baseUrlForClient(client);
  const targetClient = {
    instanceId: target.instanceId ?? client.instanceId,
    playerName: target.playerName,
    port: target.port ?? client.port,
  };
  return { status: "READY", clients, client, baseURL, targetClient };
}

async function prepareAutonomyStep(args: {
  goal: string;
  target: ClientTarget;
  includeDiagnostics?: boolean;
  includeNearbyLimit?: number;
  includeInventoryLimit?: number;
  maxPreviewSteps?: number;
  stepChoice?: "firstAction" | "nextStep";
}) {
  const resolved = await resolveActivityClient(args.target);
  if (resolved.status !== "READY") {
    const plan = {
      mode: resolved.status === "NO_CLIENT" ? "start_runtime" : "select_client",
      steps: [actionStep(
        resolved.status === "NO_CLIENT" ? "diagnose_runtime" : "select_client",
        resolved.reason ?? "RuneLite client selection is not ready.",
        {},
        { priority: "blocker" }
      )],
      notes: ["agent_run_goal does not start, close, restart, click, or invoke RuneLite outside execute_agent_step-compatible actions."],
    };
    return {
      status: resolved.status,
      clients: resolved.clients,
      reason: resolved.reason,
      plan,
      package: buildAgentStepPackage({ status: resolved.status, readiness: { risks: [String(resolved.status).toLowerCase()] } }, plan, args.goal, args.maxPreviewSteps ?? 5),
      selectedStep: null,
    };
  }

  const baseURL = resolved.baseURL as string;
  const runtime = args.includeDiagnostics === false
    ? lightweightRuntimeStatus(resolved.client)
    : await diagnoseClientRuntime(resolved.client);
  const pathfindingStatus = await getPathfindingStatusForBase(baseURL);
  const snapshot = await getSnapshotForBase(baseURL, true);
  const context = buildAgentContext(baseURL, resolved.client, snapshot, runtime, {
    objective: args.goal,
    includeNearbyLimit: args.includeNearbyLimit ?? 8,
    includeInventoryLimit: args.includeInventoryLimit ?? 28,
    streamStatus: snapshotStreamStatus(baseURL),
    pathfindingStatus,
  });
  const plan = buildNextActionPlan(context, snapshot, args.goal);
  const stepPackage = buildAgentStepPackage(context, plan, args.goal, args.maxPreviewSteps ?? 5);
  const selectedStep = args.stepChoice === "nextStep"
    ? stepPackage.nextStep
    : stepPackage.firstAction ?? stepPackage.nextStep;

  return {
    status: "READY",
    clients: resolved.clients,
    client: resolved.client,
    baseURL,
    targetClient: resolved.targetClient as ClientTarget,
    runtime,
    pathfindingStatus,
    snapshot,
    context,
    plan,
    package: stepPackage,
    selectedStep,
  };
}

async function waitForActivityVerification(baseURL: string, args: {
  startedAt: number;
  timeoutMs?: number;
  pollMs?: number;
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
  entityType?: "npc" | "object" | "ground_item" | "player";
  entityName?: string;
  entityId?: number;
  requireEntityVisible?: boolean;
  dialogueType?: string;
}) {
  const timeout = Math.max(1, args.timeoutMs ?? 8000);
  const interval = Math.max(100, args.pollMs ?? 500);
  let lastReport: any = null;
  const startedPollingAt = Date.now();

  while (Date.now() - startedPollingAt <= timeout) {
    const snapshot = await getSnapshotForBase(baseURL, true);
    lastReport = buildActionVerification(snapshot, {
      startedAt: args.startedAt,
      expectIdle: args.expectIdle,
      expectedWorldX: args.expectedWorldX,
      expectedWorldY: args.expectedWorldY,
      expectedPlane: args.expectedPlane,
      locationRadius: args.locationRadius,
      chatContains: args.chatContains,
      chatType: args.chatType,
      caseSensitive: args.caseSensitive,
      inventoryItemName: args.inventoryItemName,
      inventoryItemId: args.inventoryItemId,
      inventoryQuantityAtLeast: args.inventoryQuantityAtLeast,
      inventoryQuantityChangedFrom: args.inventoryQuantityChangedFrom,
      entityType: args.entityType,
      entityName: args.entityName,
      entityId: args.entityId,
      requireEntityVisible: args.requireEntityVisible,
      dialogueType: args.dialogueType,
    });
    if (lastReport.ok) {
      return { verified: true, waitedMs: Date.now() - startedPollingAt, ...lastReport };
    }
    await sleep(interval);
  }

  return { verified: false, waitedMs: Date.now() - startedPollingAt, ...lastReport };
}

async function runActivityStep(args: {
  label: string;
  step: any;
  executionMode?: "dry_run" | "execute";
  session?: AgentSession;
  target?: ClientTarget;
  verification?: Parameters<typeof waitForActivityVerification>[1];
  maxAgeMs?: number;
  tickAligned?: boolean;
  tickTimeoutMs?: number;
}) {
  const executionMode = args.executionMode ?? "dry_run";
  const wantsExecution = executionMode === "execute";
  const resolved = await resolveActivityClient(args.target ?? {});
  if (resolved.status !== "READY") {
    const result = {
      status: resolved.status,
      willExecute: false,
      executed: false,
      selectedStep: args.step,
      verification: { verified: false, reason: resolved.reason },
      stopReason: resolved.reason,
      clients: resolved.clients,
    };
    recordAgentEvent(args.session, `${args.label}:blocked`, result);
    return result;
  }

  const baseURL = resolved.baseURL as string;
  const targetClient = resolved.targetClient as ClientTarget;
  const beforeSnapshot = await getSnapshotForBase(baseURL, true);
  const validation = await validatePreparedStep(baseURL, beforeSnapshot, args.step, {
    dryRunRawActions: true,
    maxAgeMs: args.maxAgeMs,
  });
  if (!validation.valid) {
    const result = {
      status: "EXECUTION_BLOCKED",
      willExecute: false,
      executed: false,
      selectedStep: args.step,
      validation,
      verification: { verified: false, reason: validation.reason },
      stopReason: validation.reason,
    };
    recordAgentEvent(args.session, `${args.label}:blocked`, result);
    return result;
  }

  if (!wantsExecution) {
    const actionResult = await dryRunAgentStep(baseURL, args.step, targetClient);
    const result = {
      status: "DRY_RUN_READY",
      willExecute: false,
      executed: false,
      selectedStep: args.step,
      validation,
      actionResult,
      verification: { verified: actionResult?.success !== false, dryRun: true },
      stopReason: undefined,
    };
    recordAgentEvent(args.session, `${args.label}:dry_run`, result);
    return result;
  }

  const baselineCapturedAt = Date.now();
  actionBaselines.set(baseURL, {
    baseURL,
    capturedAt: baselineCapturedAt,
    note: `${args.label}:${args.step.tool}`,
    snapshot: beforeSnapshot,
  });
  const actionResult = await executeAgentStepAction(baseURL, args.step, targetClient, {
    tickAligned: args.tickAligned,
    tickTimeoutMs: args.tickTimeoutMs,
  });
  const verification = args.verification
    ? await waitForActivityVerification(baseURL, { ...args.verification, startedAt: baselineCapturedAt })
    : (() => {
      return {
        verified: true,
        report: "No explicit verification requested beyond successful action dispatch.",
      };
    })();
  const result = {
    status: verification.verified === false ? "EXECUTED_NEEDS_REVIEW" : "EXECUTED",
    willExecute: true,
    executed: true,
    selectedStep: args.step,
    validation,
    actionResult,
    verification,
    stopReason: verification.verified === false ? "VERIFICATION_FAILED" : undefined,
  };
  if (args.session) {
    args.session.stepCount += 1;
  }
  recordAgentEvent(args.session, `${args.label}:execute`, result);
  return result;
}

type AcquisitionPlan = {
  supported: boolean;
  itemName: string;
  method: string;
  actionEntityType: "object";
  actionName: string;
  actionOption: string;
  unsupportedReason?: string;
};

function treeNameForItem(itemName?: string, method?: string) {
  const item = String(itemName ?? "").toLowerCase();
  const chosenMethod = String(method ?? "").toLowerCase();
  if (item.includes("oak") || chosenMethod.includes("oak")) {
    return "Oak tree";
  }
  if (item.includes("willow") || chosenMethod.includes("willow")) {
    return "Willow tree";
  }
  if (item.includes("maple") || chosenMethod.includes("maple")) {
    return "Maple tree";
  }
  if (item.includes("yew") || chosenMethod.includes("yew")) {
    return "Yew tree";
  }
  return "Tree";
}

function logsItemName(itemName?: string) {
  const item = String(itemName ?? "").toLowerCase();
  if (item.includes("oak")) {
    return "Oak logs";
  }
  if (item.includes("willow")) {
    return "Willow logs";
  }
  if (item.includes("maple")) {
    return "Maple logs";
  }
  if (item.includes("yew")) {
    return "Yew logs";
  }
  return itemName ?? "Logs";
}

function normalizedMiningItemName(itemName: string) {
  const item = itemName.toLowerCase();
  if (item.includes("tin")) {
    return "Tin ore";
  }
  if (item.includes("copper")) {
    return "Copper ore";
  }
  if (item.includes("iron")) {
    return "Iron ore";
  }
  if (item.includes("coal")) {
    return "Coal";
  }
  if (item.includes("clay")) {
    return "Clay";
  }
  if (item.includes("silver")) {
    return "Silver ore";
  }
  if (item.includes("gold")) {
    return "Gold ore";
  }
  if (item.includes("mithril")) {
    return "Mithril ore";
  }
  if (item.includes("adamant")) {
    return "Adamantite ore";
  }
  if (item.includes("rune") || item.includes("runite")) {
    return "Runite ore";
  }
  return itemName;
}

function miningRockNameForItem(itemName: string) {
  const item = normalizedMiningItemName(itemName).toLowerCase();
  if (item.includes("tin")) {
    return "Tin rocks";
  }
  if (item.includes("copper")) {
    return "Copper rocks";
  }
  if (item.includes("iron")) {
    return "Iron rocks";
  }
  if (item.includes("coal")) {
    return "Coal rocks";
  }
  if (item.includes("clay")) {
    return "Clay rocks";
  }
  if (item.includes("silver")) {
    return "Silver rocks";
  }
  if (item.includes("gold")) {
    return "Gold rocks";
  }
  if (item.includes("mithril")) {
    return "Mithril rocks";
  }
  if (item.includes("adamant")) {
    return "Adamantite rocks";
  }
  if (item.includes("rune") || item.includes("runite")) {
    return "Runite rocks";
  }
  if (item.endsWith(" ore")) {
    return `${itemName.replace(/\s+ore$/i, "")} rocks`;
  }
  return `${itemName} rocks`;
}

function resolveAcquisitionPlan(itemName: string, method?: string): AcquisitionPlan {
  const normalizedMethod = String(method ?? "").toLowerCase();
  const item = String(itemName ?? "").toLowerCase();
  const wantsMining = normalizedMethod.includes("mining") ||
    normalizedMethod.includes("mine") ||
    item.includes(" ore") ||
    ["tin", "copper", "iron", "coal", "clay", "silver", "gold", "mithril", "adamant", "runite"].some((needle) => item.includes(needle));
  if (wantsMining) {
    const normalizedItem = normalizedMiningItemName(itemName);
    return {
      supported: true,
      itemName: normalizedItem,
      method: "mining",
      actionEntityType: "object",
      actionName: miningRockNameForItem(normalizedItem),
      actionOption: "Mine",
    };
  }

  const wantsWoodcutting = normalizedMethod.includes("woodcut") ||
    normalizedMethod.includes("gather") ||
    normalizedMethod.includes("chop") ||
    item.includes("log") ||
    item.includes("tree");
  if (wantsWoodcutting) {
    return {
      supported: true,
      itemName: logsItemName(itemName),
      method: "woodcutting",
      actionEntityType: "object",
      actionName: treeNameForItem(itemName, method),
      actionOption: "Chop down",
    };
  }

  return {
    supported: false,
    itemName,
    method: method ?? "unknown",
    actionEntityType: "object",
    actionName: "",
    actionOption: "",
    unsupportedReason: "Phase 1 skill_acquire supports woodcutting/log acquisition and mining ore acquisition.",
  };
}

function skillLevel(snapshot: RuneLiteSnapshot, skill: string): number | undefined {
  const skills = snapshot.skills ?? {};
  const exact = skills[skill];
  const title = skills[skill.charAt(0).toUpperCase() + skill.slice(1).toLowerCase()];
  const value = exact ?? title;
  const level = Number(value?.level ?? value?.boostedLevel ?? value);
  return Number.isFinite(level) ? level : undefined;
}

function hasClientTarget(target: ClientTarget) {
  return target.instanceId !== undefined || target.playerName !== undefined || target.port !== undefined;
}

function normalizeReflexPolicyArgs(args: any): ReflexPolicy {
  const policy = (args.policy && typeof args.policy === "object") ? args.policy : {};
  const targetClient = {
    ...(policy.targetClient ?? {}),
    ...(hasClientTarget({ instanceId: args.instanceId, playerName: args.playerName, port: args.port })
      ? { instanceId: args.instanceId, playerName: args.playerName, port: args.port }
      : {}),
  };

  return {
    ...policy,
    task: args.task ?? policy.task,
    objective: args.objective ?? policy.objective,
    itemName: args.itemName ?? policy.itemName,
    quantity: args.quantity ?? policy.quantity,
    quantityMode: args.quantityMode ?? policy.quantityMode,
    method: args.method ?? policy.method,
      targetName: args.targetName ?? policy.targetName,
      targetId: args.targetId ?? policy.targetId,
      targetType: args.targetType ?? policy.targetType,
      actionOption: args.actionOption ?? policy.actionOption,
      destination: args.destination ?? policy.destination,
      from: args.from ?? policy.from,
      maxStepTiles: args.maxStepTiles ?? policy.maxStepTiles,
      waypointRadius: args.waypointRadius ?? policy.waypointRadius,
      destinationWorldX: args.destinationWorldX ?? policy.destinationWorldX,
      destinationWorldY: args.destinationWorldY ?? policy.destinationWorldY,
      destinationPlane: args.destinationPlane ?? policy.destinationPlane,
      destinationRadius: args.destinationRadius ?? policy.destinationRadius,
      eatAtHp: args.eatAtHp ?? policy.eatAtHp,
    eatAtHpPercent: args.eatAtHpPercent ?? policy.eatAtHpPercent,
      inventoryFullBehavior: args.inventoryFullBehavior ?? policy.inventoryFullBehavior,
      dropItemName: args.dropItemName ?? policy.dropItemName,
      dropItemId: args.dropItemId ?? policy.dropItemId,
      bankAction: args.bankAction ?? policy.bankAction,
      bankItemName: args.bankItemName ?? policy.bankItemName,
      bankItemId: args.bankItemId ?? policy.bankItemId,
      bankQuantity: args.bankQuantity ?? policy.bankQuantity,
      stopOnVisiblePlayers: args.stopOnVisiblePlayers ?? policy.stopOnVisiblePlayers,
      stopOnMinimapPlayerThreat: args.stopOnMinimapPlayerThreat ?? policy.stopOnMinimapPlayerThreat,
    tickMs: args.tickMs ?? policy.tickMs,
    maxTicks: args.maxTicks ?? policy.maxTicks,
    executionMode: args.executionMode ?? policy.executionMode,
    targetClient,
  };
}

function loadReflexPolicyResponse(args: any) {
  const policy = normalizeReflexPolicyArgs(args);
  const executionMode = (args.executionMode ?? policy.executionMode ?? "dry_run") as ReflexExecutionMode;
  const hasExecutableIntent = Boolean(policy.task || policy.objective || policy.steps?.length || (policy.targetType && policy.actionOption));
  const safetyErrors = validateReflexPolicySafety(policy);

  if (safetyErrors.length > 0) {
    return {
      status: "POLICY_REJECTED",
      willExecute: false,
      executed: false,
      reason: "Policy contains forbidden raw action capabilities. System 2 must issue high-level policies only.",
      safetyErrors,
    };
  }

  if (!hasExecutableIntent) {
    return {
      status: "POLICY_REJECTED",
      willExecute: false,
      executed: false,
      reason: "Policy must include task, objective, steps, or an explicit targetType/actionOption interaction.",
    };
  }

  if (executionMode === "execute" && args.confirmExecution !== LOAD_POLICY_EXECUTE_CONFIRMATION) {
    return {
      status: "POLICY_NOT_ARMED",
      willExecute: false,
      executed: false,
      requiredConfirmation: LOAD_POLICY_EXECUTE_CONFIRMATION,
      reason: "executionMode='execute' requires confirmExecution='LOAD_POLICY_EXECUTE'.",
      policyPreview: {
        task: policy.task,
        objective: policy.objective,
        targetClient: policy.targetClient,
        itemName: policy.itemName,
        quantity: policy.quantity,
        quantityMode: policy.quantityMode ?? "absolute",
        tickMs: policy.tickMs ?? 600,
        maxTicks: policy.maxTicks ?? 100,
      },
    };
  }

  const status = reflexEngine.loadPolicy(policy, {
    start: args.start !== false,
    executionMode,
  });

  return {
    status: "POLICY_LOADED",
    architecture: "System 1 Reflex Engine",
    willExecute: executionMode === "execute",
    executed: false,
    tickLoop: {
      local: true,
      callsLlm: false,
      tickMs: status.activePolicy?.tickMs,
    },
    engine: status,
  };
}

// --- State Reading Tools ---

server.tool(
  "load_policy",
  "Load a high-level System 1 Reflex Engine policy. This is the policy entrypoint for System 2; it starts a local 600ms tick loop and never calls the LLM.",
  {
    policy: z.any().optional().describe("Strategist policy JSON object emitted by osrs-agent-brain/System 2"),
    task: z.string().optional().describe("Policy task shorthand, for example chop_logs, combat, travel, interact"),
    objective: z.string().optional().describe("Human-readable policy objective"),
    itemName: z.string().optional().describe("Target inventory item for success counting, for example Logs"),
    quantity: z.number().optional().describe("Target inventory quantity for success counting"),
    quantityMode: z.enum(["absolute", "gain"]).optional().describe("absolute means inventory must reach quantity; gain means acquire quantity more than the starting count"),
    method: z.string().optional().describe("Method hint, for example woodcutting"),
    targetName: z.string().optional().describe("Entity name to interact with"),
    targetId: z.number().optional().describe("Entity id to interact with"),
    targetType: z.enum(["object", "npc", "ground_item", "player"]).optional().describe("Entity type for explicit interaction policies"),
    actionOption: z.string().optional().describe("Menu option for explicit interaction policies"),
    destination: z.string().optional().describe("Named transport destination for travel policies, for example Draynor Bank"),
    from: z.string().optional().describe("Optional named transport start node for travel policies"),
    maxStepTiles: z.number().optional().describe("Maximum tiles for one local navigation step, default 18"),
    waypointRadius: z.number().optional().describe("Consider a transport waypoint reached when within this many tiles, default 8"),
    destinationWorldX: z.number().optional().describe("Optional destination world X for travel success checks"),
    destinationWorldY: z.number().optional().describe("Optional destination world Y for travel success checks"),
    destinationPlane: z.number().optional().describe("Optional destination plane for travel success checks"),
    destinationRadius: z.number().optional().describe("Optional radius for travel success checks, default 2"),
    eatAtHp: z.number().optional().describe("Survival guard: eat when HP is at or below this value"),
    eatAtHpPercent: z.number().optional().describe("Survival guard: eat when HP percent is at or below this value"),
    inventoryFullBehavior: z.enum(["stop", "bank", "drop"]).optional().describe("What System 1 does when inventory is full: stop, deposit item if bank is open, or drop item"),
    dropItemName: z.string().optional().describe("Inventory item name to drop when inventoryFullBehavior=drop; defaults to itemName"),
    dropItemId: z.number().optional().describe("Inventory item id to drop when inventoryFullBehavior=drop"),
    bankAction: z.enum(["open", "deposit", "withdraw"]).optional().describe("Bank policy intent: open bank, deposit inventory item, or withdraw bank item"),
    bankItemName: z.string().optional().describe("Inventory item name to deposit when inventoryFullBehavior=bank; defaults to itemName"),
    bankItemId: z.number().optional().describe("Inventory item id to deposit when inventoryFullBehavior=bank"),
    bankQuantity: z.union([z.string(), z.number()]).optional().describe("Bank action quantity, for example All, 1, 5, or X"),
    stopOnVisiblePlayers: z.boolean().optional().describe("Stop the policy if visible players are detected"),
    stopOnMinimapPlayerThreat: z.boolean().optional().describe("Stop the policy if the minimap icon feed reports another player/red-dot threat"),
    tickMs: z.number().optional().describe("Policy tick interval in ms, default 600"),
    maxTicks: z.number().optional().describe("Maximum local ticks before stopping, default 100"),
    start: z.boolean().optional().describe("Start immediately after loading, default true"),
    executionMode: z.enum(["dry_run", "execute"]).optional().describe("dry_run validates/previews; execute performs local policy actions"),
    confirmExecution: z.string().optional().describe("Required for executionMode=execute: LOAD_POLICY_EXECUTE"),
    ...clientTargetSchema(),
  },
  async (args) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(loadReflexPolicyResponse(args), null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("loading Reflex Engine policy", e) }] };
    }
  }
);

server.tool(
  "reflex_status",
  "Inspect the active System 1 Reflex Engine policy and recent local tick history.",
  {},
  async () => ({ content: [{ type: "text", text: JSON.stringify(reflexEngine.status(), null, 2) }] })
);

server.tool(
  "reflex_pause",
  "Pause the active System 1 Reflex Engine policy without unloading it.",
  {
    reason: z.string().optional(),
  },
  async ({ reason }) => ({ content: [{ type: "text", text: JSON.stringify(reflexEngine.pause(reason), null, 2) }] })
);

server.tool(
  "reflex_resume",
  "Resume a loaded or paused System 1 Reflex Engine policy.",
  {},
  async () => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(reflexEngine.resume(), null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("resuming Reflex Engine", e) }] };
    }
  }
);

server.tool(
  "reflex_stop",
  "Stop the active System 1 Reflex Engine policy.",
  {
    reason: z.string().optional(),
  },
  async ({ reason }) => ({ content: [{ type: "text", text: JSON.stringify(reflexEngine.stop(reason), null, 2) }] })
);

server.tool(
  "reflex_tick_once",
  "Run one immediate System 1 Reflex Engine tick for the active running policy. Intended for tests/debugging; normal policies tick locally on their own timer.",
  {},
  async () => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await reflexEngine.runSingleTick(), null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("running Reflex Engine tick", e) }] };
    }
  }
);

server.tool(
  "reflex_history",
  "Read recent System 1 Reflex Engine events.",
  {
    limit: z.number().optional().describe("Maximum events to return, default 50"),
  },
  async ({ limit }) => ({ content: [{ type: "text", text: JSON.stringify({ events: reflexEngine.getHistory(limit ?? 50) }, null, 2) }] })
);

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

      const baseURL = baseUrlForClient(client);
      const runtime = includeDiagnostics === false
        ? lightweightRuntimeStatus(client)
        : await diagnoseClientRuntime(client);
      const pathfindingStatus = await getPathfindingStatusForBase(baseURL);
      const snapshot = await getSnapshotForBase(baseURL, false);
      const context = buildAgentContext(baseURL, client, snapshot, runtime, {
        objective,
        includeNearbyLimit,
        includeInventoryLimit,
        streamStatus: snapshotStreamStatus(baseURL),
        pathfindingStatus,
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
    forceRefresh: z.boolean().optional().describe("Force a fresh plugin snapshot, default false"),
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

      const client = selectDiscoveredClient(clients, { instanceId, playerName, port }, selectedRuneliteApi, selectedClientInstanceId);
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

      const baseURL = baseUrlForClient(client);
      const runtime = includeDiagnostics === false
        ? lightweightRuntimeStatus(client)
        : await diagnoseClientRuntime(client);
      const pathfindingStatus = await getPathfindingStatusForBase(baseURL);
      const snapshot = await getSnapshotForBase(baseURL, forceRefresh === true);
      const context = buildAgentContext(baseURL, client, snapshot, runtime, {
        objective,
        includeNearbyLimit,
        includeInventoryLimit,
        streamStatus: snapshotStreamStatus(baseURL),
        pathfindingStatus,
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

      const baseURL = baseUrlForClient(client);
      const runtime = includeDiagnostics === false
        ? lightweightRuntimeStatus(client)
        : await diagnoseClientRuntime(client);
      const pathfindingStatus = await getPathfindingStatusForBase(baseURL);
      const snapshot = await getSnapshotForBase(baseURL, true);
      const context = buildAgentContext(baseURL, client, snapshot, runtime, {
        objective,
        includeNearbyLimit: includeNearbyLimit ?? 6,
        includeInventoryLimit: 12,
        streamStatus: snapshotStreamStatus(baseURL),
        pathfindingStatus,
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

      const baseURL = baseUrlForClient(client);
      const runtime = includeDiagnostics === false
        ? lightweightRuntimeStatus(client)
        : await diagnoseClientRuntime(client);
      const pathfindingStatus = await getPathfindingStatusForBase(baseURL);
      const snapshot = await getSnapshotForBase(baseURL, true);
      const context = buildAgentContext(baseURL, client, snapshot, runtime, {
        objective,
        includeNearbyLimit: includeNearbyLimit ?? 6,
        includeInventoryLimit: 12,
        streamStatus: snapshotStreamStatus(baseURL),
        pathfindingStatus,
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

      const baseURL = baseUrlForClient(client);
      const runtime = includeDiagnostics === false
        ? lightweightRuntimeStatus(client)
        : await diagnoseClientRuntime(client);
      const pathfindingStatus = await getPathfindingStatusForBase(baseURL);
      const snapshot = await getSnapshotForBase(baseURL, true);
      const context = buildAgentContext(baseURL, client, snapshot, runtime, {
        objective,
        includeNearbyLimit: includeNearbyLimit ?? 6,
        includeInventoryLimit: 12,
        streamStatus: snapshotStreamStatus(baseURL),
        pathfindingStatus,
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

/**
 * @deprecated Old LLM-in-the-loop helper. Keep for compatibility only.
 * System 2 must use compact perception/knowledge tools and load_policy instead.
 */
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

      const client = selectDiscoveredClient(clients, { instanceId, playerName, port }, selectedRuneliteApi, selectedClientInstanceId);
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

      const baseURL = baseUrlForClient(client);
      const runtime = includeDiagnostics === false
        ? lightweightRuntimeStatus(client)
        : await diagnoseClientRuntime(client);
      const pathfindingStatus = await getPathfindingStatusForBase(baseURL);
      const snapshot = await getSnapshotForBase(baseURL, true);
      const context = buildAgentContext(baseURL, client, snapshot, runtime, {
        objective,
        includeNearbyLimit,
        includeInventoryLimit,
        streamStatus: snapshotStreamStatus(baseURL),
        pathfindingStatus,
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

/**
 * @deprecated Old LLM-in-the-loop execution helper. Keep for compatibility only.
 * System 2 must not call this tool; real autonomy flows through load_policy.
 */
server.tool(
  "execute_agent_step",
  "Validate and optionally execute exactly one prepared gameplay step. Defaults to dry-run; real execution requires confirmExecution='EXECUTE_ONE_STEP'.",
  {
    objective: z.string().optional().describe("Objective to prepare from when step is omitted, for example 'chop 5 normal trees'"),
    step: z.any().optional().describe("A step object from prepare_agent_step.package.firstAction/nextStep or plan_next_action.plan.steps[]"),
    stepChoice: z.enum(["firstAction", "nextStep"]).optional().describe("When preparing from objective, choose firstAction by default or nextStep explicitly."),
    executionMode: z.enum(["dry_run", "execute"]).optional().describe("dry_run validates/previews only. execute performs exactly one action if confirmExecution is EXECUTE_ONE_STEP."),
    confirmExecution: z.string().optional().describe("Required arming phrase for executionMode=execute: EXECUTE_ONE_STEP"),
    baselineBeforeAction: z.boolean().optional().describe("Capture a verification baseline immediately before a real action, default true"),
    includePostActionSnapshot: z.boolean().optional().describe("Refresh and include a compact post-action snapshot summary after real execution, default true"),
    includeDiagnostics: z.boolean().optional().describe("Run runtime endpoint/feature diagnostics before preparing/executing, default true"),
    includeNearbyLimit: z.number().optional().describe("Maximum nearby entries to include in context, default 8"),
    includeInventoryLimit: z.number().optional().describe("Maximum inventory entries to include, default 28"),
    maxPreviewSteps: z.number().optional().describe("Maximum prepared package plan steps to preview, default 5"),
    maxAgeMs: z.number().optional().describe("Maximum target age accepted by snapshot target validators, default 1200"),
    tickAligned: z.boolean().optional().describe("For raw invoke_* actions, wait for the next OSRS game tick before real execution"),
    tickTimeoutMs: z.number().optional().describe("Maximum wait for tickAligned raw actions in milliseconds, default 1800"),
    ...clientTargetSchema(),
  },
  async ({
    objective,
    step,
    stepChoice,
    executionMode,
    confirmExecution,
    baselineBeforeAction,
    includePostActionSnapshot,
    includeDiagnostics,
    includeNearbyLimit,
    includeInventoryLimit,
    maxPreviewSteps,
    maxAgeMs,
    tickAligned,
    tickTimeoutMs,
    instanceId,
    playerName,
    port,
  }) => {
    try {
      const wantsExecution = executionMode === "execute";
      const clients = await discoverClients();
      if (clients.length === 0) {
        const plan = {
          mode: "start_runtime",
          steps: [actionStep("diagnose_runtime", "No RuneLite MCP plugin client was discovered; start/load RuneLite before executing an agent step.", {}, { priority: "blocker" })],
          notes: ["execute_agent_step never starts, closes, or restarts RuneLite."],
        };
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "NO_CLIENT",
              willExecute: false,
              executed: false,
              plan,
              package: buildAgentStepPackage({ status: "NO_CLIENT", readiness: { risks: ["no_client"] } }, plan, objective, maxPreviewSteps ?? 5),
              validation: { valid: false, willExecute: false, reason: "No active RuneLite MCP plugin client was discovered." },
            }, null, 2)
          }]
        };
      }

      const client = selectDiscoveredClient(clients, { instanceId, playerName, port }, selectedRuneliteApi, selectedClientInstanceId);
      if (!client) {
        const plan = {
          mode: "select_client",
          steps: [actionStep("select_client", "Multiple RuneLite clients are active; select the intended account/window before acting.", {}, { priority: "blocker" })],
          notes: ["Pass port, instanceId, or playerName to execute_agent_step when multiple clients are open."],
        };
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "NEEDS_CLIENT_SELECTION",
              willExecute: false,
              executed: false,
              clients,
              plan,
              package: buildAgentStepPackage({ status: "NEEDS_CLIENT_SELECTION", readiness: { risks: ["needs_client_selection"] } }, plan, objective, maxPreviewSteps ?? 5),
              validation: { valid: false, willExecute: false, reason: "Select the intended RuneLite client before executing a gameplay step." },
            }, null, 2)
          }]
        };
      }

      const targetClient = {
        instanceId: instanceId ?? client.instanceId,
        playerName,
        port: port ?? client.port,
      };
      const baseURL = baseUrlForClient(client);
      const runtime = includeDiagnostics === false
        ? lightweightRuntimeStatus(client)
        : await diagnoseClientRuntime(client);
      const pathfindingStatus = await getPathfindingStatusForBase(baseURL);
      const snapshot = await getSnapshotForBase(baseURL, true);
      const context = buildAgentContext(baseURL, client, snapshot, runtime, {
        objective,
        includeNearbyLimit,
        includeInventoryLimit,
        streamStatus: snapshotStreamStatus(baseURL),
        pathfindingStatus,
      });
      const plan = buildNextActionPlan(context, snapshot, objective);
      const stepPackage = buildAgentStepPackage(context, plan, objective, maxPreviewSteps ?? 5);
      const selectedStep = step ?? (stepChoice === "nextStep"
        ? stepPackage.nextStep
        : stepPackage.firstAction ?? stepPackage.nextStep);
      const validation = selectedStep
        ? await validatePreparedStep(baseURL, snapshot, selectedStep, {
          dryRunRawActions: true,
          maxAgeMs,
        })
        : {
          valid: false,
          willExecute: false,
          reason: "No step was selected by the planner.",
        };

      if (!validation.valid) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "EXECUTION_BLOCKED",
              willExecute: false,
              executed: false,
              context,
              plan,
              package: stepPackage,
              selectedStep,
              validation,
              reason: "The selected step did not pass current-state validation.",
              nextInstruction: "Refresh observation or resolve the validation reason before attempting execution.",
            }, null, 2)
          }]
        };
      }

      if (!EXECUTABLE_AGENT_TOOLS.has(selectedStep.tool)) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "EXECUTION_BLOCKED",
              willExecute: false,
              executed: false,
              context,
              plan,
              package: stepPackage,
              selectedStep,
              validation,
              reason: `execute_agent_step can execute only one supported action tool. ${selectedStep.tool} is not currently supported.`,
              supportedTools: Array.from(EXECUTABLE_AGENT_TOOLS),
            }, null, 2)
          }]
        };
      }

      if (!wantsExecution) {
        const dryRunResult = await dryRunAgentStep(baseURL, selectedStep, targetClient);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "DRY_RUN_READY",
              willExecute: false,
              executed: false,
              context,
              plan,
              package: stepPackage,
              selectedStep,
              validation,
              actionResult: dryRunResult,
              armingRequired: EXECUTE_AGENT_STEP_CONFIRMATION,
              nextInstruction: "To execute exactly this one validated step, call execute_agent_step again with executionMode='execute' and confirmExecution='EXECUTE_ONE_STEP', then verify afterward.",
            }, null, 2)
          }]
        };
      }

      if (confirmExecution !== EXECUTE_AGENT_STEP_CONFIRMATION) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              objective,
              status: "EXECUTION_NOT_ARMED",
              willExecute: false,
              executed: false,
              context,
              plan,
              package: stepPackage,
              selectedStep,
              validation,
              requiredConfirmation: EXECUTE_AGENT_STEP_CONFIRMATION,
              reason: "executionMode='execute' was requested, but the arming phrase was missing or incorrect.",
            }, null, 2)
          }]
        };
      }

      let baseline: any = null;
      if (baselineBeforeAction !== false) {
        const baselineSnapshot = await getSnapshotForBase(baseURL, true);
        baseline = {
          baseURL,
          capturedAt: Date.now(),
          note: `execute_agent_step:${selectedStep.tool}`,
        };
        actionBaselines.set(baseURL, {
          ...baseline,
          snapshot: baselineSnapshot,
        });
      }

      const actionResult = await executeAgentStepAction(baseURL, selectedStep, targetClient, {
        tickAligned,
        tickTimeoutMs,
      });
      const postActionSnapshot = includePostActionSnapshot === false
        ? undefined
        : await getSnapshotForBase(baseURL, true);
      const postActionSummary = postActionSnapshot
        ? {
          capturedAt: (postActionSnapshot as any).capturedAt,
          ageMs: postActionSnapshot.ageMs,
          tick: (postActionSnapshot as any).tick,
          state: postActionSnapshot.state,
          inventorySlotsUsed: inventorySlotsUsed(postActionSnapshot),
          interfaceSummary: postActionSnapshot.interfaceSummary,
        }
        : undefined;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            objective,
            status: "EXECUTED_ONE_STEP",
            willExecute: true,
            executed: true,
            context,
            plan,
            package: stepPackage,
            selectedStep,
            validation,
            baseline,
            actionResult,
            postActionSummary,
            nextInstruction: stepPackage.verificationStep
              ? `Verify with ${stepPackage.verificationStep.tool} or refresh get_agent_context before the next action.`
              : "Verify with verify_last_action, verify_after_action, or get_agent_context before the next action.",
          }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("executing agent step", e) }] };
    }
  }
);

server.tool(
  "agent_start_goal",
  "Create an in-memory agent goal session. Twin-Brain autonomy should prefer load_policy/reflex_status; this session surface remains for compatibility.",
  {
    goal: z.string().describe("High-level gameplay goal to track"),
    executionMode: z.enum(["dry_run", "execute"]).optional().describe("Default execution mode for this session, default dry_run"),
    instanceId: z.string().optional(),
    playerName: z.string().optional(),
    port: z.number().optional(),
  },
  async ({ goal, executionMode, instanceId, playerName, port }) => {
    await ensureAgentMemoryLoaded();
    const now = Date.now();
    const session: AgentSession = {
      id: makeAgentSessionId(),
      goal,
      status: "created",
      executionMode: executionMode ?? "dry_run",
      createdAt: now,
      updatedAt: now,
      selectedClient: { instanceId, playerName, port },
      stepCount: 0,
      history: [],
    };
    agentSessions.set(session.id, session);
    activeAgentSessionId = session.id;
    recordAgentEvent(session, "session_created", { goal, executionMode: session.executionMode, selectedClient: session.selectedClient });
    return jsonTool({
      status: "SESSION_CREATED",
      willExecute: false,
      executed: false,
      session: publicAgentSession(session),
      stopReason: undefined,
    });
  }
);

server.tool(
  "agent_status",
  "Read the active in-memory agent session status, or a specific session by id.",
  {
    sessionId: z.string().optional(),
  },
  async ({ sessionId }) => {
    await ensureAgentMemoryLoaded();
    const session = getAgentSession(sessionId);
    const memoryStatus = await agentMemory.status();
    return jsonTool({
      status: session ? "SESSION_FOUND" : "NO_SESSION",
      willExecute: false,
      executed: false,
      activeSessionId: activeAgentSessionId,
      session: publicAgentSession(session),
      persistence: memoryStatus,
      stopReason: session ? session.stopReason : "No active agent session exists.",
    });
  }
);

server.tool(
  "agent_stop",
  "Stop the active in-memory agent session. This is the Phase 1 emergency stop/control-plane primitive.",
  {
    sessionId: z.string().optional(),
    reason: z.string().optional(),
  },
  async ({ sessionId, reason }) => {
    await ensureAgentMemoryLoaded();
    const session = getAgentSession(sessionId);
    if (!session) {
      return jsonTool({
        status: "NO_SESSION",
        willExecute: false,
        executed: false,
        stopReason: "No active agent session exists.",
      });
    }
    session.status = "stopped";
    session.stopReason = reason ?? "Stopped by agent_stop.";
    recordAgentEvent(session, "session_stopped", { reason: session.stopReason });
    return jsonTool({
      status: "SESSION_STOPPED",
      willExecute: false,
      executed: false,
      session: publicAgentSession(session),
      stopReason: session.stopReason,
    });
  }
);

server.tool(
  "agent_pause",
  "Pause the active in-memory agent session. This does not affect RuneLite; it gates Phase 1 activity tools through session state.",
  {
    sessionId: z.string().optional(),
    reason: z.string().optional(),
  },
  async ({ sessionId, reason }) => {
    await ensureAgentMemoryLoaded();
    const session = getAgentSession(sessionId);
    if (!session) {
      return jsonTool({ status: "NO_SESSION", willExecute: false, executed: false, stopReason: "No active agent session exists." });
    }
    session.status = "paused";
    session.stopReason = reason ?? "Paused by agent_pause.";
    recordAgentEvent(session, "session_paused", { reason: session.stopReason });
    return jsonTool({ status: "SESSION_PAUSED", willExecute: false, executed: false, session: publicAgentSession(session), stopReason: session.stopReason });
  }
);

server.tool(
  "agent_resume",
  "Resume a paused in-memory agent session. This does not start full-auto execution in Phase 1.",
  {
    sessionId: z.string().optional(),
  },
  async ({ sessionId }) => {
    await ensureAgentMemoryLoaded();
    const session = getAgentSession(sessionId);
    if (!session) {
      return jsonTool({ status: "NO_SESSION", willExecute: false, executed: false, stopReason: "No active agent session exists." });
    }
    session.status = "running";
    session.stopReason = undefined;
    activeAgentSessionId = session.id;
    recordAgentEvent(session, "session_resumed");
    return jsonTool({ status: "SESSION_RESUMED", willExecute: false, executed: false, session: publicAgentSession(session), stopReason: undefined });
  }
);

server.tool(
  "agent_history",
  "Read recent in-memory agent session events.",
  {
    sessionId: z.string().optional(),
    limit: z.number().optional().describe("Maximum events to return, default 50"),
  },
  async ({ sessionId, limit }) => {
    await ensureAgentMemoryLoaded();
    const session = getAgentSession(sessionId);
    const max = Math.max(1, Math.min(500, limit ?? 50));
    const persistentEvents = session ? await agentMemory.getEvents(session.id, max) : [];
    return jsonTool({
      status: session ? "SESSION_FOUND" : "NO_SESSION",
      willExecute: false,
      executed: false,
      session: publicAgentSession(session),
      events: persistentEvents.length
        ? persistentEvents.map((event) => ({ at: event.at, type: event.type, data: event.data, persisted: true }))
        : session ? session.history.slice(-max) : [],
      persistence: await agentMemory.status(),
      stopReason: session ? session.stopReason : "No active agent session exists.",
    });
  }
);

server.tool(
  "agent_memory_status",
  "Inspect the Phase 3 persistent agent memory database status and counts.",
  {},
  async () => {
    await ensureAgentMemoryLoaded();
    return jsonTool({
      ...(await agentMemory.status()),
      willExecute: false,
      executed: false,
      activeSessionId: activeAgentSessionId,
      loadedSessionCount: agentSessions.size,
    });
  }
);

server.tool(
  "agent_memory_sessions",
  "List recent persisted agent sessions from the Phase 3 SQLite memory store.",
  {
    limit: z.number().optional().describe("Maximum sessions to return, default 20"),
    status: z.string().optional().describe("Optional exact status filter such as completed, stopped, paused, blocked"),
    goalContains: z.string().optional().describe("Optional case-insensitive goal text filter"),
  },
  async ({ limit, status, goalContains }) => {
    await ensureAgentMemoryLoaded();
    const sessions = await agentMemory.listSessions({ limit: limit ?? 20, status, goalContains });
    return jsonTool({
      status: "MEMORY_SESSIONS",
      willExecute: false,
      executed: false,
      sessions,
      persistence: await agentMemory.status(),
    });
  }
);

server.registerResource(
  "memory-profile",
  "osrs://memory/profile",
  {
    title: "Persistent OSRS Agent Memory Profile",
    description: "Latest durable account/profile snapshot stored by the Phase 3 memory ledger.",
    mimeType: "application/json",
  },
  async () => {
    const uri = "osrs://memory/profile";
    await ensureAgentMemoryLoaded();
    const profile = await agentMemory.getProfile();
    return resourceText(uri, {
      status: profile ? "PROFILE_FOUND" : "NO_PROFILE",
      profile,
      persistence: await agentMemory.status(),
    });
  }
);

server.registerResource(
  "strategy-cache",
  "osrs://memory/strategy-cache",
  {
    title: "Persistent Strategy Cache",
    description: "Cached System 2 strategy policies and System 1 policy payloads keyed by normalized goals/methods.",
    mimeType: "application/json",
  },
  async () => {
    const uri = "osrs://memory/strategy-cache";
    await ensureAgentMemoryLoaded();
    return resourceText(uri, {
      status: "STRATEGY_CACHE_READY",
      entries: await agentMemory.listStrategyCache({ limit: 25 }),
      persistence: await agentMemory.status(),
    });
  }
);

server.registerResource(
  "knowledge-index",
  "osrs://knowledge/index",
  {
    title: "Curated OSRS Knowledge Index",
    description: "Phase 4 local curated OSRS knowledge summary, counts, scope, and starter query hints.",
    mimeType: "application/json",
  },
  async () => {
    return resourceText("osrs://knowledge/index", {
      status: "KNOWLEDGE_READY",
      ...knowledgeSummary(),
    });
  }
);

server.tool(
  "strategy_cache_get",
  "Lookup a cached strategist policy by key or normalized goal/method before calling Qwen.",
  {
    key: z.string().optional().describe("Exact cache key returned by strategy_cache_put/list"),
    goal: z.string().optional().describe("Goal text used to derive a cache key when key is omitted"),
    method: z.string().optional().describe("Optional method namespace for the cache key"),
  },
  async ({ key, goal, method }) => {
    await ensureAgentMemoryLoaded();
    if (!key && !goal) {
      return jsonTool({
        status: "CACHE_LOOKUP_REJECTED",
        willExecute: false,
        executed: false,
        stopReason: "Provide key or goal.",
      });
    }
    const cacheKey = key ?? strategyCacheKey({ goal: goal as string, method });
    const entry = await agentMemory.getStrategyCache(cacheKey);
    return jsonTool({
      status: entry ? "STRATEGY_CACHE_HIT" : "STRATEGY_CACHE_MISS",
      willExecute: false,
      executed: false,
      key: cacheKey,
      entry,
      persistence: await agentMemory.status(),
    });
  }
);

server.tool(
  "strategy_cache_put",
  "Store or replace a cached strategist policy and concrete System 1 policy payload.",
  {
    key: z.string().optional().describe("Optional exact cache key; defaults to normalized goal/method"),
    goal: z.string().describe("Goal text this strategy satisfies"),
    method: z.string().optional().describe("Optional method namespace, for example woodcutting.logs"),
    source: z.string().optional().describe("Source such as qwen, local_scaffold_no_qwen, or human"),
    status: z.string().optional().describe("Cache status, default READY"),
    policy: z.any().describe("Full strategist policy or cached strategy payload"),
    contextSummary: z.any().optional().describe("Compact context/knowledge summary used to create the policy"),
    metadata: z.any().optional().describe("Additional cache metadata"),
  },
  async ({ key, goal, method, source, status, policy, contextSummary, metadata }) => {
    await ensureAgentMemoryLoaded();
    const entry = await agentMemory.upsertStrategyCache({
      key,
      goal,
      method,
      source,
      status,
      policy,
      contextSummary,
      metadata,
    });
    return jsonTool({
      status: "STRATEGY_CACHED",
      willExecute: false,
      executed: false,
      entry,
      persistence: await agentMemory.status(),
    });
  }
);

server.tool(
  "strategy_cache_list",
  "List cached strategy policies for System 2 reuse and inspection.",
  {
    limit: z.number().optional().describe("Maximum entries, default 25"),
    goalContains: z.string().optional().describe("Optional case-insensitive goal filter"),
    method: z.string().optional().describe("Optional method substring filter"),
    status: z.string().optional().describe("Optional exact status filter"),
  },
  async ({ limit, goalContains, method, status }) => {
    await ensureAgentMemoryLoaded();
    return jsonTool({
      status: "STRATEGY_CACHE_LIST",
      willExecute: false,
      executed: false,
      entries: await agentMemory.listStrategyCache({ limit, goalContains, method, status }),
      persistence: await agentMemory.status(),
    });
  }
);

server.tool(
  "strategy_cache_record_outcome",
  "Record whether a cached strategy succeeded or failed after System 1 execution.",
  {
    key: z.string().optional().describe("Exact cache key returned by strategy_cache_get/list"),
    goal: z.string().optional().describe("Goal text used to derive cache key when key is omitted"),
    method: z.string().optional().describe("Optional method namespace"),
    success: z.boolean().describe("Whether the cached strategy succeeded"),
    metadata: z.any().optional().describe("Outcome metadata, failure lesson, or verification summary"),
  },
  async ({ key, goal, method, success, metadata }) => {
    await ensureAgentMemoryLoaded();
    if (!key && !goal) {
      return jsonTool({
        status: "CACHE_OUTCOME_REJECTED",
        willExecute: false,
        executed: false,
        stopReason: "Provide key or goal.",
      });
    }
    const cacheKey = key ?? strategyCacheKey({ goal: goal as string, method });
    const entry = await agentMemory.recordStrategyCacheOutcome(cacheKey, { success, metadata });
    return jsonTool({
      status: entry ? "STRATEGY_CACHE_OUTCOME_RECORDED" : "STRATEGY_CACHE_ENTRY_NOT_FOUND",
      willExecute: false,
      executed: false,
      key: cacheKey,
      entry,
      persistence: await agentMemory.status(),
    });
  }
);

server.tool(
  "knowledge_query",
  "Search the Phase 4 curated local OSRS knowledge base across methods, locations, quests, monsters, and gear.",
  {
    query: z.string().describe("Search text, for example '50 Magic', 'Lumbridge cows', 'Cook assistant', or 'starter gear'"),
    kind: z.enum(["method", "location", "quest", "monster", "gear"]).optional().describe("Optional knowledge kind filter"),
    members: z.boolean().optional().describe("Optional members/F2P filter"),
    limit: z.number().optional().describe("Maximum results, default 10"),
  },
  async ({ query, kind, members, limit }) => {
    return jsonTool({
      status: "KNOWLEDGE_RESULTS",
      willExecute: false,
      executed: false,
      query,
      kind,
      members,
      summary: knowledgeSummary(),
      results: queryKnowledge({ query, kind, members, limit }),
    });
  }
);

server.tool(
  "knowledge_get_method",
  "Get a curated OSRS training/combat/economy method with requirements, locations, dependency tree, and recommended MCP tools.",
  {
    methodId: z.string().optional().describe("Exact method id such as magic.fire_strike_f2p"),
    skill: z.string().optional().describe("Skill/domain such as woodcutting, magic, mining, fishing, combat, economy"),
    activity: z.string().optional().describe("Activity or goal text, for example '50 Magic', 'oak logs', 'starter gp'"),
    currentLevel: z.number().optional().describe("Current level for the relevant skill, default 1"),
    targetLevel: z.number().optional().describe("Target level when relevant"),
    preference: z.string().optional().describe("Preference such as fastest, cheap, profit, safe, starter"),
  },
  async ({ methodId, skill, activity, currentLevel, targetLevel, preference }) => {
    const result = getMethodKnowledge({ methodId, skill, activity, currentLevel, targetLevel, preference });
    return jsonTool({
      status: result ? "METHOD_FOUND" : "METHOD_NOT_FOUND",
      willExecute: false,
      executed: false,
      query: { methodId, skill, activity, currentLevel, targetLevel, preference },
      result,
      stopReason: result ? undefined : "No curated method matched this query yet.",
    });
  }
);

server.tool(
  "knowledge_get_location",
  "Get curated OSRS location knowledge by id/name, including contained resources, banks, transport, and risks.",
  {
    idOrName: z.string().describe("Location id or name, for example lumbridge_cows or Draynor Village willow trees"),
  },
  async ({ idOrName }) => {
    const record = getKnowledgeRecord("location", idOrName);
    return jsonTool({
      status: record ? "LOCATION_FOUND" : "LOCATION_NOT_FOUND",
      willExecute: false,
      executed: false,
      location: record,
      stopReason: record ? undefined : "No curated location matched this id/name yet.",
    });
  }
);

server.tool(
  "knowledge_get_quest",
  "Get curated OSRS quest knowledge by id/name, including requirements, step outline, rewards, and risks.",
  {
    idOrName: z.string().describe("Quest id or name, for example tutorial_island or Cook's Assistant"),
  },
  async ({ idOrName }) => {
    const record = getKnowledgeRecord("quest", idOrName);
    return jsonTool({
      status: record ? "QUEST_FOUND" : "QUEST_NOT_FOUND",
      willExecute: false,
      executed: false,
      quest: record,
      stopReason: record ? undefined : "No curated quest matched this id/name yet.",
    });
  }
);

server.tool(
  "knowledge_get_monster",
  "Get curated OSRS monster knowledge by id/name, including locations, weaknesses, useful drops, tactics, and risks.",
  {
    idOrName: z.string().describe("Monster id or name, for example chicken, cow, Grizzly bear, or Hill Giant"),
  },
  async ({ idOrName }) => {
    const record = getKnowledgeRecord("monster", idOrName);
    return jsonTool({
      status: record ? "MONSTER_FOUND" : "MONSTER_NOT_FOUND",
      willExecute: false,
      executed: false,
      monster: record,
      stopReason: record ? undefined : "No curated monster matched this id/name yet.",
    });
  }
);

server.tool(
  "knowledge_get_gear",
  "Get curated OSRS gear knowledge by id/name, including requirements, item set, use cases, and upgrade path.",
  {
    idOrName: z.string().describe("Gear id or name, for example starter_magic_f2p or Starter F2P melee gear"),
  },
  async ({ idOrName }) => {
    const record = getKnowledgeRecord("gear", idOrName);
    return jsonTool({
      status: record ? "GEAR_FOUND" : "GEAR_NOT_FOUND",
      willExecute: false,
      executed: false,
      gear: record,
      stopReason: record ? undefined : "No curated gear matched this id/name yet.",
    });
  }
);

server.tool(
  "memory_get_profile",
  "Read the persistent account/profile memory. Optionally refresh it from the live RuneLite snapshot first.",
  {
    forceRefresh: z.boolean().optional().describe("Refresh profile from the live RuneLite snapshot before returning it, default false"),
    ...clientTargetSchema(),
  },
  async ({ forceRefresh, instanceId, playerName, port }) => {
    await ensureAgentMemoryLoaded();
    let refreshError: string | undefined;
    if (forceRefresh) {
      try {
        await refreshMemoryProfile({ instanceId, playerName, port });
      } catch (error: any) {
        refreshError = error?.message ?? String(error);
      }
    }
    const profile = await agentMemory.getProfile();
    return jsonTool({
      status: profile ? "PROFILE_FOUND" : "NO_PROFILE",
      willExecute: false,
      executed: false,
      profile,
      refreshError,
      persistence: await agentMemory.status(),
      resource: "osrs://memory/profile",
    });
  }
);

server.tool(
  "memory_get_goal",
  "Read a persisted goal/session with recent events and journal entries.",
  {
    sessionId: z.string().optional(),
    limit: z.number().optional().describe("Maximum events/journal rows to return, default 50"),
  },
  async ({ sessionId, limit }) => {
    await ensureAgentMemoryLoaded();
    const session = getAgentSession(sessionId);
    const max = Math.max(1, Math.min(500, limit ?? 50));
    const events = session ? await agentMemory.getEvents(session.id, max) : [];
    const journal = session ? await agentMemory.listJournal({ sessionId: session.id, limit: max }) : [];
    return jsonTool({
      status: session ? "GOAL_FOUND" : "NO_GOAL",
      willExecute: false,
      executed: false,
      activeSessionId: activeAgentSessionId,
      session: publicAgentSession(session),
      events,
      journal,
      persistence: await agentMemory.status(),
      stopReason: session ? session.stopReason : "No active or matching persisted goal session exists.",
    });
  }
);

server.tool(
  "memory_search_lessons",
  "Search persisted memory journal for similar lessons, failures, blockers, and strategy notes before planning a risky goal.",
  {
    query: z.string().describe("Goal/task text to search for similar prior lessons"),
    limit: z.number().optional().describe("Maximum lessons to return, default 10"),
    kind: z.enum(["observation", "action"]).optional().describe("Optional journal kind filter"),
    onlyFailures: z.boolean().optional().describe("Return only entries with failure/blocker/lesson signals, default false"),
    minScore: z.number().optional().describe("Minimum lexical score, default 1"),
  },
  async ({ query, limit, kind, onlyFailures, minScore }) => {
    await ensureAgentMemoryLoaded();
    const lessons = await agentMemory.searchLessons({ query, limit, kind, onlyFailures, minScore });
    return jsonTool({
      status: "MEMORY_LESSONS",
      willExecute: false,
      executed: false,
      query,
      lessons,
      persistence: await agentMemory.status(),
      retrieval: {
        mode: "lexical_v1",
        vectorEmbeddings: false,
        note: "Phase 4 V1 retrieves similar journal lessons lexically; vector embeddings can replace this scorer later.",
      },
    });
  }
);

server.tool(
  "memory_record_observation",
  "Record a durable observation/lesson in the Phase 3 memory journal, optionally including the current live snapshot summary.",
  {
    note: z.string().optional(),
    observation: z.any().optional(),
    includeSnapshot: z.boolean().optional().describe("Attach a compact live snapshot/profile observation, default false"),
    sessionId: z.string().optional(),
    ...clientTargetSchema(),
  },
  async ({ note, observation, includeSnapshot, sessionId, instanceId, playerName, port }) => {
    await ensureAgentMemoryLoaded();
    const session = getAgentSession(sessionId);
    let snapshotProfile: any;
    let snapshotError: string | undefined;
    if (includeSnapshot) {
      try {
        const refreshed = await refreshMemoryProfile({ instanceId, playerName, port });
        snapshotProfile = refreshed.data;
      } catch (error: any) {
        snapshotError = error?.message ?? String(error);
      }
    }
    const at = Date.now();
    const data = {
      note,
      observation,
      snapshotProfile,
      snapshotError,
    };
    await agentMemory.appendJournal({
      at,
      kind: "observation",
      sessionId: session?.id,
      goal: session?.goal,
      data,
    });
    recordAgentEvent(session, "memory_observation", data);
    return jsonTool({
      status: "OBSERVATION_RECORDED",
      willExecute: false,
      executed: false,
      at,
      session: publicAgentSession(session),
      data,
      persistence: await agentMemory.status(),
    });
  }
);

server.tool(
  "memory_record_action",
  "Record a durable action result, lesson, or strategy note in the Phase 3 memory journal.",
  {
    goal: z.string().optional(),
    action: z.any().describe("Action/tool/strategy that was attempted or considered"),
    result: z.any().optional(),
    lesson: z.string().optional(),
    sessionId: z.string().optional(),
  },
  async ({ goal, action, result, lesson, sessionId }) => {
    await ensureAgentMemoryLoaded();
    const session = getAgentSession(sessionId);
    const at = Date.now();
    const data = {
      action,
      result,
      lesson,
    };
    await agentMemory.appendJournal({
      at,
      kind: "action",
      sessionId: session?.id,
      goal: goal ?? session?.goal,
      data,
    });
    recordAgentEvent(session, "memory_action", data);
    return jsonTool({
      status: "ACTION_RECORDED",
      willExecute: false,
      executed: false,
      at,
      session: publicAgentSession(session),
      goal: goal ?? session?.goal,
      data,
      persistence: await agentMemory.status(),
    });
  }
);

server.registerResource(
  "semantic-interface",
  "osrs://semantic/interface",
  {
    title: "Semantic OSRS Interface",
    description: "Phase 5 semantic controls inferred from the latest snapshot and visible widgets.",
    mimeType: "application/json",
  },
  async () => {
    const uri = "osrs://semantic/interface";
    try {
      const semantic = await getSemanticInterfaceForTarget({}, { maxWidgets: 150 });
      return resourceText(uri, {
        status: "SEMANTIC_READY",
        baseURL: semantic.baseURL,
        widgetError: semantic.widgetError,
        semantic: semantic.semantic,
      });
    } catch (error: any) {
      return resourceText(uri, {
        status: "SEMANTIC_UNAVAILABLE",
        error: error?.message ?? String(error),
      });
    }
  }
);

server.tool(
  "get_semantic_interface",
  "Read Phase 5 semantic controls inferred from dialogue, inventory/equipment, interface summary, and visible widgets.",
  {
    widgetFilter: z.string().optional().describe("Optional widget text/action/id filter such as continue, quest, bank, spell, prayer"),
    maxWidgets: z.number().optional().describe("Maximum raw widgets to inspect, default 150"),
    includeHidden: z.boolean().optional().describe("Include hidden widgets, default false"),
    forceRefresh: z.boolean().optional().describe("Force a fresh snapshot, default false"),
    ...clientTargetSchema(),
  },
  async ({ widgetFilter, maxWidgets, includeHidden, forceRefresh, instanceId, playerName, port }) => {
    try {
      const result = await getSemanticInterfaceForTarget({ instanceId, playerName, port }, {
        widgetFilter,
        maxWidgets,
        includeHidden,
        forceRefresh,
      });
      return jsonTool({
        status: "SEMANTIC_READY",
        willExecute: false,
        executed: false,
        baseURL: result.baseURL,
        widgetCount: result.widgets.length,
        widgetError: result.widgetError,
        semantic: result.semantic,
        resource: "osrs://semantic/interface",
      });
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("building semantic interface", e) }] };
    }
  }
);

server.tool(
  "semantic_find_control",
  "Find named semantic controls by type/text/role without executing anything.",
  {
    type: z.string().optional().describe("Control type, for example dialogue_continue, dialogue_option, bank_action, spell, prayer, quest_widget"),
    text: z.string().optional().describe("Case-insensitive label/text substring"),
    role: z.string().optional().describe("Role substring such as continue, deposit, withdraw, quest"),
    limit: z.number().optional().describe("Maximum controls, default 20"),
    widgetFilter: z.string().optional().describe("Optional raw widget filter before semantic classification"),
    ...clientTargetSchema(),
  },
  async ({ type, text, role, limit, widgetFilter, instanceId, playerName, port }) => {
    try {
      const result = await getSemanticInterfaceForTarget({ instanceId, playerName, port }, { widgetFilter, forceRefresh: true });
      const controls = findSemanticControls(result.semantic, { type, text, role, limit });
      return jsonTool({
        status: "SEMANTIC_CONTROLS_FOUND",
        willExecute: false,
        executed: false,
        query: { type, text, role, limit, widgetFilter },
        controls,
        semanticSummary: {
          dialogue: result.semantic.dialogue,
          groups: result.semantic.groups,
          recommendedNext: result.semantic.recommendedNext,
        },
      });
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("finding semantic controls", e) }] };
    }
  }
);

server.tool(
  "semantic_invoke_control",
  `Validate or execute one semantic control. Defaults to dry-run; real execution requires confirmExecution='${EXECUTE_SEMANTIC_CONTROL_CONFIRMATION}' and uses only keyboard dialogue or in-client widget action paths.`,
  {
    controlId: z.string().optional().describe("Semantic control id from get_semantic_interface/semantic_find_control"),
    type: z.string().optional().describe("Control type to select when controlId is omitted"),
    text: z.string().optional().describe("Text substring to select when controlId is omitted"),
    executionMode: z.enum(["dry_run", "execute"]).optional(),
    confirmExecution: z.string().optional().describe(`Required for executionMode=execute: ${EXECUTE_SEMANTIC_CONTROL_CONFIRMATION}`),
    widgetFilter: z.string().optional(),
    tickAligned: z.boolean().optional(),
    tickTimeoutMs: z.number().optional(),
    ...clientTargetSchema(),
  },
  async ({ controlId, type, text, executionMode, confirmExecution, widgetFilter, tickAligned, tickTimeoutMs, instanceId, playerName, port }) => {
    try {
      const wantsExecution = executionMode === "execute";
      const semanticResult = await getSemanticInterfaceForTarget({ instanceId, playerName, port }, { widgetFilter, forceRefresh: true });
      const control = controlId
        ? semanticResult.semantic.controls.find((candidate) => candidate.id === controlId)
        : findSemanticControls(semanticResult.semantic, { type, text, limit: 1 })[0];
      if (!control) {
        return jsonTool({
          status: "SEMANTIC_CONTROL_NOT_FOUND",
          willExecute: false,
          executed: false,
          selectedControl: null,
          stopReason: "No semantic control matched the requested id/type/text.",
          semanticSummary: { dialogue: semanticResult.semantic.dialogue, groups: semanticResult.semantic.groups },
        });
      }
      if (!wantsExecution) {
        return jsonTool({
          status: "SEMANTIC_DRY_RUN_READY",
          willExecute: false,
          executed: false,
          selectedControl: control,
          action: control.action,
          armingRequired: EXECUTE_SEMANTIC_CONTROL_CONFIRMATION,
        });
      }
      if (confirmExecution !== EXECUTE_SEMANTIC_CONTROL_CONFIRMATION) {
        return jsonTool({
          status: "SEMANTIC_NOT_ARMED",
          willExecute: false,
          executed: false,
          selectedControl: control,
          requiredConfirmation: EXECUTE_SEMANTIC_CONTROL_CONFIRMATION,
          stopReason: "executionMode='execute' was requested, but the semantic-control arming phrase was missing or incorrect.",
        });
      }

      let actionResult: any;
      if (control.type === "dialogue_continue") {
        await typeHardwareInput(Key.Space, "Semantic dialogue continue requested hardware Space.");
        actionResult = { success: true, method: "keyboard_space" };
      } else if (control.type === "dialogue_option") {
        const match = control.id.match(/dialogue\.option\.(\d+)/);
        const optionNumber = match ? Number(match[1]) : undefined;
        if (!optionNumber || optionNumber < 1 || optionNumber > 9) {
          return jsonTool({
            status: "SEMANTIC_EXECUTION_BLOCKED",
            willExecute: false,
            executed: false,
            selectedControl: control,
            stopReason: "Dialogue option execution supports number-key options 1-9 only in Phase 5 V1.",
          });
        }
        await typeHardwareInput(String(optionNumber), `Semantic dialogue option requested hardware key ${optionNumber}.`);
        actionResult = { success: true, method: "keyboard_dialogue_option", optionNumber };
      } else if (control.widget?.packedId || (control.widget?.groupId !== undefined && control.widget?.childId !== undefined)) {
        actionResult = await invokeWidgetAction(semanticResult.baseURL, {
          packedId: control.widget.packedId,
          groupId: control.widget.groupId,
          childId: control.widget.childId,
          itemId: control.widget.itemId,
          option: control.widget.actions?.[0] ?? control.action?.arguments?.option ?? "Select",
          dryRun: false,
          tickAligned,
          tickTimeoutMs,
        });
      } else {
        return jsonTool({
          status: "SEMANTIC_EXECUTION_BLOCKED",
          willExecute: false,
          executed: false,
          selectedControl: control,
          stopReason: "This semantic control has no supported keyboard or in-client widget action path.",
        });
      }

      const after = await getSnapshotForBase(semanticResult.baseURL, true);
      return jsonTool({
        status: "SEMANTIC_EXECUTED",
        willExecute: true,
        executed: true,
        selectedControl: control,
        actionResult,
        verification: {
          postDialogueType: after.interfaceSummary?.dialogueType ?? after.dialogue?.type,
          postDialogueText: after.dialogue?.text,
          postInterfaceSummary: after.interfaceSummary,
        },
      });
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("invoking semantic control", e) }] };
    }
  }
);

server.tool(
  "quest_plan_next_step",
  "Plan the next safe quest/dialogue step using Phase 5 semantic interface controls and curated quest knowledge. This tool never executes.",
  {
    questName: z.string().describe("Quest name, for example Tutorial Island or Cook's Assistant"),
    widgetFilter: z.string().optional().describe("Optional widget filter, default quest/dialogue relevant widgets"),
    ...clientTargetSchema(),
  },
  async ({ questName, widgetFilter, instanceId, playerName, port }) => {
    try {
      const semanticResult = await getSemanticInterfaceForTarget({ instanceId, playerName, port }, {
        widgetFilter: widgetFilter ?? "quest continue option cook guide",
        forceRefresh: true,
        maxWidgets: 200,
      });
      const questKnowledge = getKnowledgeRecord("quest", questName);
      const plan = planQuestStep({
        questName,
        snapshot: semanticResult.snapshot,
        semanticInterface: semanticResult.semantic,
        questKnowledge,
      });
      return jsonTool({
        status: plan.status,
        willExecute: false,
        executed: false,
        questName,
        questKnowledge,
        semanticSummary: {
          dialogue: semanticResult.semantic.dialogue,
          groups: semanticResult.semantic.groups,
          recommendedNext: semanticResult.semantic.recommendedNext,
        },
        plan,
        executionRule: "quest_plan_next_step never executes. Use semantic_invoke_control, handle_dialogue, or existing activity tools for one verified action at a time.",
      });
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("planning quest step", e) }] };
    }
  }
);

server.tool(
  "complete_quest",
  "Phase 5 V1 quest engine entry point. Plans Tutorial Island/Cook's Assistant next steps with semantic controls; execution is one-step and explicitly armed.",
  {
    questName: z.string().describe("Quest name, for example Tutorial Island or Cook's Assistant"),
    executionMode: z.enum(["dry_run", "execute"]).optional(),
    confirmExecution: z.string().optional().describe(`Required only for the limited one-step semantic execution path: ${EXECUTE_SEMANTIC_CONTROL_CONFIRMATION}`),
    maxSteps: z.number().optional().describe("Maximum quest steps for this call. Phase 5 V1 executes at most 1; dry-run previews one step."),
    ...clientTargetSchema(),
  },
  async ({ questName, executionMode, confirmExecution, maxSteps, instanceId, playerName, port }) => {
    try {
      const semanticResult = await getSemanticInterfaceForTarget({ instanceId, playerName, port }, {
        widgetFilter: "quest continue option cook guide",
        forceRefresh: true,
        maxWidgets: 200,
      });
      const questKnowledge = getKnowledgeRecord("quest", questName);
      const plan = planQuestStep({
        questName,
        snapshot: semanticResult.snapshot,
        semanticInterface: semanticResult.semantic,
        questKnowledge,
      });
      const wantsExecution = executionMode === "execute";
      const executableDialogue = plan.selectedStep?.tool === "handle_dialogue" && semanticResult.semantic.controls.some((control) => control.type === "dialogue_continue" || control.type === "dialogue_option");
      if (!wantsExecution) {
        return jsonTool({
          status: "QUEST_DRY_RUN_READY",
          willExecute: false,
          executed: false,
          questName,
          maxSteps: Math.min(1, maxSteps ?? 1),
          plan,
          semanticControls: semanticResult.semantic.controls.slice(0, 20),
          questKnowledge,
          armingRequired: EXECUTE_SEMANTIC_CONTROL_CONFIRMATION,
        });
      }
      if (confirmExecution !== EXECUTE_SEMANTIC_CONTROL_CONFIRMATION) {
        return jsonTool({
          status: "QUEST_NOT_ARMED",
          willExecute: false,
          executed: false,
          questName,
          plan,
          requiredConfirmation: EXECUTE_SEMANTIC_CONTROL_CONFIRMATION,
          stopReason: "Quest execution requires explicit arming and runs at most one semantic/dialogue step in Phase 5 V1.",
        });
      }
      if (!executableDialogue) {
        return jsonTool({
          status: "QUEST_EXECUTION_BLOCKED",
          willExecute: false,
          executed: false,
          questName,
          plan,
          stopReason: "Phase 5 V1 can execute only an already-open dialogue continue/option step. Use the planned existing tool manually for other phases.",
        });
      }

      const dialogueControl = semanticResult.semantic.controls.find((control) => control.type === "dialogue_option")
        ?? semanticResult.semantic.controls.find((control) => control.type === "dialogue_continue");
      if (!dialogueControl) {
        return jsonTool({
          status: "QUEST_EXECUTION_BLOCKED",
          willExecute: false,
          executed: false,
          questName,
          plan,
          stopReason: "No executable dialogue semantic control is visible.",
        });
      }
      if (dialogueControl.type === "dialogue_option") {
        const optionNumber = Number(dialogueControl.id.match(/dialogue\.option\.(\d+)/)?.[1]);
        await typeHardwareInput(String(optionNumber), `Quest dialogue option requested hardware key ${optionNumber}.`);
      } else {
        await typeHardwareInput(Key.Space, "Quest dialogue continue requested hardware Space.");
      }
      const after = await getSnapshotForBase(semanticResult.baseURL, true);
      return jsonTool({
        status: "QUEST_EXECUTED_ONE_STEP",
        willExecute: true,
        executed: true,
        questName,
        selectedControl: dialogueControl,
        plan,
        verification: {
          postDialogueType: after.interfaceSummary?.dialogueType ?? after.dialogue?.type,
          postDialogueText: after.dialogue?.text,
          postInterfaceSummary: after.interfaceSummary,
        },
        stopReason: "Phase 5 V1 executed one dialogue step only; re-plan before continuing.",
      });
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("running quest engine", e) }] };
    }
  }
);

/**
 * @deprecated Old LLM-in-the-loop goal runner. Keep for compatibility only.
 * System 2 must issue policies to the ReflexEngine instead.
 */
server.tool(
  "agent_run_goal",
  `Run a bounded Phase 2 observe-plan-execute-verify loop for an agent goal. Defaults to dry-run; real execution requires confirmExecution='${RUN_AUTONOMY_CONFIRMATION}'.`,
  {
    goal: z.string().optional().describe("High-level gameplay goal. Required unless sessionId points to an existing session."),
    sessionId: z.string().optional(),
    executionMode: z.enum(["dry_run", "execute"]).optional().describe("dry_run validates/previews only. execute performs bounded real actions when armed."),
    confirmExecution: z.string().optional().describe(`Required arming phrase for executionMode=execute: ${RUN_AUTONOMY_CONFIRMATION}`),
    maxSteps: z.number().optional().describe("Maximum loop iterations. Defaults to 1 for dry-run and 3 for execute; capped at 25."),
    maxMinutes: z.number().optional().describe("Maximum wall-clock runtime for this call. Defaults to 2; capped at 15."),
    stepChoice: z.enum(["firstAction", "nextStep"]).optional().describe("Which prepared step to select each iteration. Defaults to firstAction when available."),
    includeDiagnostics: z.boolean().optional().describe("Run runtime endpoint/feature diagnostics before each planning iteration, default true"),
    includeNearbyLimit: z.number().optional().describe("Maximum nearby entries to include in context, default 8"),
    includeInventoryLimit: z.number().optional().describe("Maximum inventory entries to include, default 28"),
    maxPreviewSteps: z.number().optional().describe("Maximum plan preview steps to include, default 5"),
    maxAgeMs: z.number().optional().describe("Maximum target age accepted by snapshot target validators, default 1200"),
    tickAligned: z.boolean().optional().describe("For raw invoke_* actions, wait for the next OSRS game tick before real execution"),
    tickTimeoutMs: z.number().optional().describe("Maximum wait for tickAligned raw actions in milliseconds, default 1800"),
    ...clientTargetSchema(),
  },
  async ({
    goal,
    sessionId,
    executionMode,
    confirmExecution,
    maxSteps,
    maxMinutes,
    stepChoice,
    includeDiagnostics,
    includeNearbyLimit,
    includeInventoryLimit,
    maxPreviewSteps,
    maxAgeMs,
    tickAligned,
    tickTimeoutMs,
    instanceId,
    playerName,
    port,
  }) => {
    try {
      await ensureAgentMemoryLoaded();
      let session = getAgentSession(sessionId);
      const goalText = goal ?? session?.goal;
      if (!goalText) {
        return jsonTool({
          status: "NO_GOAL",
          willExecute: false,
          executed: false,
          selectedStep: null,
          verification: { verified: false },
          stopReason: "Pass goal or sessionId for an existing agent session.",
          session: publicAgentSession(session),
        });
      }

      const mode = executionMode ?? session?.executionMode ?? "dry_run";
      const wantsExecution = mode === "execute";
      if (wantsExecution && confirmExecution !== RUN_AUTONOMY_CONFIRMATION) {
        return jsonTool({
          status: "AUTONOMY_NOT_ARMED",
          willExecute: false,
          executed: false,
          selectedStep: null,
          verification: { verified: false },
          requiredConfirmation: RUN_AUTONOMY_CONFIRMATION,
          stopReason: "executionMode='execute' was requested, but the full-autonomy arming phrase was missing or incorrect.",
          session: publicAgentSession(session),
        });
      }

      const selectedClient = {
        instanceId: instanceId ?? session?.selectedClient?.instanceId,
        playerName: playerName ?? session?.selectedClient?.playerName,
        port: port ?? session?.selectedClient?.port,
      };
      if (!session) {
        const now = Date.now();
        session = {
          id: makeAgentSessionId(),
          goal: goalText,
          status: "created",
          executionMode: mode,
          createdAt: now,
          updatedAt: now,
          selectedClient,
          stepCount: 0,
          history: [],
        };
        agentSessions.set(session.id, session);
        activeAgentSessionId = session.id;
        recordAgentEvent(session, "session_created", { goal: goalText, executionMode: mode, selectedClient });
      }

      if (session.status === "stopped" || session.status === "paused") {
        return jsonTool({
          status: "SESSION_NOT_RUNNING",
          willExecute: false,
          executed: false,
          selectedStep: null,
          verification: { verified: false },
          stopReason: session.stopReason ?? `Session is ${session.status}.`,
          session: publicAgentSession(session),
        });
      }

      session.goal = goalText;
      session.executionMode = mode;
      session.selectedClient = selectedClient;
      session.status = "running";
      session.stopReason = undefined;
      recordAgentEvent(session, "autonomy_started", { goal: goalText, executionMode: mode, selectedClient });

      const stepLimit = Math.max(1, Math.min(25, Math.floor(maxSteps ?? (wantsExecution ? 3 : 1))));
      const timeLimitMs = Math.max(1, Math.min(15, maxMinutes ?? 2)) * 60_000;
      const startedAt = Date.now();
      const iterations: any[] = [];
      let stopReason: string | undefined = wantsExecution ? "MAX_STEPS_REACHED" : "DRY_RUN_ONLY";
      let selectedStep: any = null;
      let verification: any = { verified: false };
      let finalContext: any;
      let finalProgress: any;

      for (let index = 0; index < stepLimit; index += 1) {
        if (Date.now() - startedAt > timeLimitMs) {
          stopReason = "MAX_TIME_REACHED";
          break;
        }
        const currentStatus = session.status as AgentSessionStatus;
        if (currentStatus === "stopped" || currentStatus === "paused") {
          stopReason = session.stopReason ?? `Session is ${session.status}.`;
          break;
        }

        const prepared = await prepareAutonomyStep({
          goal: goalText,
          target: session.selectedClient ?? {},
          includeDiagnostics,
          includeNearbyLimit,
          includeInventoryLimit,
          maxPreviewSteps,
          stepChoice,
        });

        if (prepared.status !== "READY") {
          selectedStep = prepared.selectedStep;
          verification = { verified: false, reason: prepared.reason ?? "RuneLite client is not ready." };
          stopReason = prepared.reason ?? "RuneLite client is not ready.";
          session.status = "blocked";
          session.stopReason = stopReason;
          recordAgentEvent(session, "autonomy_blocked", prepared);
          iterations.push({
            index,
            status: prepared.status,
            willExecute: false,
            executed: false,
            plan: prepared.plan,
            package: prepared.package,
            selectedStep,
            verification,
            stopReason,
          });
          break;
        }

        session.selectedClient = prepared.targetClient;
        const preparedSnapshot = prepared.snapshot as RuneLiteSnapshot;
        initializeSessionGoalState(session, preparedSnapshot);
        const preProgress = evaluateSessionGoal(session, preparedSnapshot);
        finalContext = prepared.context;
        finalProgress = preProgress;
        if (preProgress.complete) {
          stopReason = undefined;
          verification = { verified: true, progress: preProgress };
          session.status = "completed";
          session.stopReason = undefined;
          iterations.push({
            index,
            status: "GOAL_ALREADY_COMPLETE",
            willExecute: false,
            executed: false,
            context: prepared.context,
            plan: prepared.plan,
            package: prepared.package,
            selectedStep: null,
            verification,
            stopReason: undefined,
          });
          break;
        }

        selectedStep = prepared.selectedStep;
        if (!selectedStep) {
          stopReason = "No step was selected by the planner.";
          verification = { verified: false, reason: stopReason };
          session.status = "blocked";
          session.stopReason = stopReason;
          iterations.push({
            index,
            status: "AUTONOMY_BLOCKED",
            willExecute: false,
            executed: false,
            context: prepared.context,
            plan: prepared.plan,
            package: prepared.package,
            selectedStep: null,
            verification,
            stopReason,
          });
          break;
        }

        if (!EXECUTABLE_AGENT_TOOLS.has(selectedStep.tool)) {
          stopReason = `agent_run_goal can execute only supported safe action tools. ${selectedStep.tool} is not currently supported.`;
          verification = { verified: false, reason: stopReason };
          session.status = "blocked";
          session.stopReason = stopReason;
          iterations.push({
            index,
            status: "AUTONOMY_BLOCKED",
            willExecute: false,
            executed: false,
            context: prepared.context,
            plan: prepared.plan,
            package: prepared.package,
            selectedStep,
            verification,
            stopReason,
            supportedTools: Array.from(EXECUTABLE_AGENT_TOOLS),
          });
          break;
        }

        const result = await runActivityStep({
          label: "agent_run_goal",
          step: selectedStep,
          executionMode: mode,
          session,
          target: session.selectedClient,
          verification: inferVerificationForStep(selectedStep, preparedSnapshot),
          maxAgeMs,
          tickAligned,
          tickTimeoutMs,
        });
        verification = result.verification;
        session.lastSelectedStep = selectedStep;
        session.lastVerification = verification;
        session.lastResult = result;
        iterations.push({
          index,
          context: prepared.context,
          plan: prepared.plan,
          package: prepared.package,
          progressBefore: preProgress,
          ...result,
        });

        if (!wantsExecution) {
          stopReason = "DRY_RUN_ONLY";
          break;
        }
        if (result.stopReason) {
          stopReason = result.stopReason;
          session.status = "blocked";
          session.stopReason = stopReason;
          break;
        }

        const afterSnapshot = await getSnapshotForBase(prepared.baseURL as string, true);
        const postProgress = evaluateSessionGoal(session, afterSnapshot);
        finalProgress = postProgress;
        if (postProgress.complete) {
          stopReason = undefined;
          verification = { verified: true, progress: postProgress };
          session.status = "completed";
          session.stopReason = undefined;
          recordAgentEvent(session, "autonomy_completed", { progress: postProgress });
          break;
        }
      }

      if (session.status === "running" && wantsExecution && stopReason === "MAX_STEPS_REACHED") {
        session.stopReason = stopReason;
      }
      if (!wantsExecution && session.status === "running") {
        session.stopReason = undefined;
      }

      const executed = iterations.some((iteration) => iteration.executed);
      const responseStatus = session.status === "completed"
        ? "AUTONOMY_COMPLETED"
        : stopReason === "DRY_RUN_ONLY"
          ? "AUTONOMY_DRY_RUN_READY"
          : session.status === "blocked"
            ? "AUTONOMY_BLOCKED"
            : "AUTONOMY_RAN";
      recordAgentEvent(session, "autonomy_finished", {
        status: responseStatus,
        executed,
        iterationCount: iterations.length,
        stopReason,
        finalProgress,
      });

      return jsonTool({
        status: responseStatus,
        willExecute: wantsExecution,
        executed,
        goal: goalText,
        selectedStep,
        verification,
        stopReason,
        iterations,
        iterationCount: iterations.length,
        maxSteps: stepLimit,
        elapsedMs: Date.now() - startedAt,
        finalProgress,
        finalContext,
        session: publicAgentSession(session),
        armingRequired: wantsExecution ? undefined : RUN_AUTONOMY_CONFIRMATION,
      });
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("running autonomous agent goal", e) }] };
    }
  }
);

server.tool(
  "skill_interact",
  "Universal one-step interaction with a visible NPC, object, player, or ground item through the safe agent step primitive.",
  {
    entityType: z.enum(["npc", "object", "ground_item", "player"]),
    option: z.string().describe("Menu option, for example Chop down, Attack, Talk-to, Take, Open"),
    name: z.string().optional(),
    id: z.number().optional(),
    nearestToPlayer: z.boolean().optional(),
    executionMode: z.enum(["dry_run", "execute"]).optional(),
    sessionId: z.string().optional(),
    maxAgeMs: z.number().optional(),
    ...clientTargetSchema(),
  },
  async ({ entityType, option, name, id, nearestToPlayer, executionMode, sessionId, maxAgeMs, instanceId, playerName, port }) => {
    try {
      await ensureAgentMemoryLoaded();
      const session = sessionId ? getAgentSession(sessionId) : undefined;
      if (session?.status === "stopped" || session?.status === "paused") {
        return jsonTool({ status: "SESSION_NOT_RUNNING", willExecute: false, executed: false, selectedStep: null, verification: { verified: false }, stopReason: session.stopReason ?? `Session is ${session.status}.`, session: publicAgentSession(session) });
      }
      const selectedStep = {
        tool: "interact_with",
        arguments: { entityType, option, name, id, nearestToPlayer: nearestToPlayer ?? true },
      };
      const result = await runActivityStep({
        label: "skill_interact",
        step: selectedStep,
        executionMode: executionMode ?? session?.executionMode ?? "dry_run",
        session,
        target: { instanceId, playerName, port },
        maxAgeMs,
      });
      return jsonTool({ ...result, session: publicAgentSession(session) });
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("running skill_interact", e) }] };
    }
  }
);

server.tool(
  "skill_acquire",
  "Acquire an item through a bounded universal activity. Phase 1 supports woodcutting logs and mining ores.",
  {
    itemName: z.string().describe("Item to acquire, for example Logs, Oak logs, Tin ore, Copper ore, Iron ore"),
    quantity: z.number().describe("Quantity to acquire in this call"),
    method: z.string().optional().describe("Acquisition method, for example woodcutting, gathering, or mining"),
    maxSteps: z.number().optional().describe("Maximum interactions, default quantity*4 capped at 20"),
    executionMode: z.enum(["dry_run", "execute"]).optional(),
    sessionId: z.string().optional(),
    ...clientTargetSchema(),
  },
  async ({ itemName, quantity, method, maxSteps, executionMode, sessionId, instanceId, playerName, port }) => {
    try {
      await ensureAgentMemoryLoaded();
      const session = sessionId ? getAgentSession(sessionId) : undefined;
      if (session?.status === "stopped" || session?.status === "paused") {
        return jsonTool({ status: "SESSION_NOT_RUNNING", willExecute: false, executed: false, selectedStep: null, verification: { verified: false }, stopReason: session.stopReason ?? `Session is ${session.status}.`, session: publicAgentSession(session) });
      }
      const acquisition = resolveAcquisitionPlan(itemName, method);
      if (!acquisition.supported) {
        return jsonTool({
          status: "UNSUPPORTED_ACTIVITY",
          willExecute: false,
          executed: false,
          selectedStep: null,
          verification: { verified: false },
          stopReason: acquisition.unsupportedReason,
          session: publicAgentSession(session),
        });
      }
      const item = acquisition.itemName;

      const resolved = await resolveActivityClient({ instanceId, playerName, port });
      if (resolved.status !== "READY") {
        return jsonTool({ status: resolved.status, willExecute: false, executed: false, selectedStep: null, verification: { verified: false, reason: resolved.reason }, stopReason: resolved.reason, clients: resolved.clients, session: publicAgentSession(session) });
      }
      const baseURL = resolved.baseURL as string;
      const startedSnapshot = await getSnapshotForBase(baseURL, true);
      const startQuantity = inventoryQuantity(startedSnapshot, item);
      const targetQuantity = startQuantity + Math.max(1, quantity);
      const mode = executionMode ?? session?.executionMode ?? "dry_run";
      const limit = mode === "execute" ? Math.max(1, Math.min(20, maxSteps ?? Math.max(1, quantity * 4))) : 1;
      const attempts: any[] = [];
      let finalQuantity = startQuantity;
      let stopReason: string | undefined;

      for (let attempt = 0; attempt < limit; attempt += 1) {
        const currentSnapshot = await getSnapshotForBase(baseURL, true);
        const currentQuantity = inventoryQuantity(currentSnapshot, item);
        finalQuantity = currentQuantity;
        if (currentQuantity >= targetQuantity) {
          break;
        }
        const selectedStep = {
          tool: "perform_until",
          arguments: {
            actionEntityType: acquisition.actionEntityType,
            actionName: acquisition.actionName,
            actionOption: acquisition.actionOption,
            nearestToPlayer: true,
            condition: "inventory_quantity_at_least",
            inventoryItemName: item,
            inventoryQuantityAtLeast: targetQuantity,
          },
        };
        const result = await runActivityStep({
          label: "skill_acquire",
          step: selectedStep,
          executionMode: mode,
          session,
          target: { instanceId, playerName, port },
          verification: {
            startedAt: Date.now(),
            inventoryItemName: item,
            inventoryQuantityAtLeast: Math.min(targetQuantity, currentQuantity + 1),
            timeoutMs: 14000,
            pollMs: 700,
          },
        });
        attempts.push(result);
        if (mode !== "execute") {
          stopReason = "DRY_RUN_ONLY";
          break;
        }
        if (result.stopReason) {
          stopReason = result.stopReason;
          break;
        }
        finalQuantity = inventoryQuantity(await getSnapshotForBase(baseURL, true), item);
      }

      const completed = finalQuantity >= targetQuantity;
      return jsonTool({
        status: completed ? "ACTIVITY_COMPLETED" : mode === "execute" ? "ACTIVITY_INCOMPLETE" : "DRY_RUN_READY",
        willExecute: mode === "execute",
        executed: attempts.some((attempt) => attempt.executed),
        itemName: item,
        method: acquisition.method,
        actionTarget: {
          entityType: acquisition.actionEntityType,
          name: acquisition.actionName,
          option: acquisition.actionOption,
        },
        quantityRequested: quantity,
        startQuantity,
        targetQuantity,
        finalQuantity,
        attempts,
        selectedStep: attempts.at(-1)?.selectedStep ?? null,
        verification: attempts.at(-1)?.verification ?? { verified: completed },
        stopReason: completed ? undefined : stopReason ?? "Target quantity was not reached within maxSteps.",
        session: publicAgentSession(session),
      });
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("running skill_acquire", e) }] };
    }
  }
);

server.tool(
  "skill_train",
  "Train a skill through a bounded universal activity. Phase 1 supports woodcutting via log acquisition.",
  {
    skill: z.string().describe("Skill name, for example woodcutting"),
    targetLevel: z.number().optional(),
    targetXp: z.number().optional(),
    method: z.string().optional(),
    maxSteps: z.number().optional(),
    executionMode: z.enum(["dry_run", "execute"]).optional(),
    sessionId: z.string().optional(),
    ...clientTargetSchema(),
  },
  async ({ skill, targetLevel, targetXp, method, maxSteps, executionMode, sessionId, instanceId, playerName, port }) => {
    try {
      await ensureAgentMemoryLoaded();
      const normalizedSkill = skill.toLowerCase();
      const session = sessionId ? getAgentSession(sessionId) : undefined;
      if (normalizedSkill !== "woodcutting") {
        return jsonTool({ status: "UNSUPPORTED_ACTIVITY", willExecute: false, executed: false, selectedStep: null, verification: { verified: false }, stopReason: "Phase 1 skill_train supports woodcutting first.", session: publicAgentSession(session) });
      }
      const resolved = await resolveActivityClient({ instanceId, playerName, port });
      if (resolved.status !== "READY") {
        return jsonTool({ status: resolved.status, willExecute: false, executed: false, selectedStep: null, verification: { verified: false, reason: resolved.reason }, stopReason: resolved.reason, clients: resolved.clients, session: publicAgentSession(session) });
      }
      const snapshot = await getSnapshotForBase(resolved.baseURL as string, true);
      const currentLevel = skillLevel(snapshot, normalizedSkill);
      if (targetLevel !== undefined && currentLevel !== undefined && currentLevel >= targetLevel) {
        return jsonTool({ status: "ACTIVITY_COMPLETED", willExecute: false, executed: false, currentLevel, targetLevel, selectedStep: null, verification: { verified: true, reason: "Target level is already reached." }, stopReason: undefined, session: publicAgentSession(session) });
      }
      const result = await runActivityStep({
        label: "skill_train",
        step: {
          tool: "perform_until",
          arguments: {
            actionEntityType: "object",
            actionName: treeNameForItem(undefined, method),
            actionOption: "Chop down",
            nearestToPlayer: true,
            condition: "inventory_full",
          },
        },
        executionMode: executionMode ?? session?.executionMode ?? "dry_run",
        session,
        target: { instanceId, playerName, port },
        verification: {
          startedAt: Date.now(),
          inventoryItemName: logsItemName(method),
          inventoryQuantityAtLeast: inventoryQuantity(snapshot, logsItemName(method)) + 1,
          timeoutMs: 14000,
          pollMs: 700,
        },
      });
      return jsonTool({ ...result, skill: normalizedSkill, currentLevel, targetLevel, targetXp, session: publicAgentSession(session) });
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("running skill_train", e) }] };
    }
  }
);

server.tool(
  "skill_travel",
  "Travel through safe System 1 primitives. Named destinations use the transport graph and execute at most one bounded movement step.",
  {
    destinationName: z.string().optional(),
    from: z.string().optional().describe("Optional named transport start node for destinationName planning, for example Lumbridge Castle"),
    worldX: z.number().optional(),
    worldY: z.number().optional(),
    plane: z.number().optional(),
    maxStepTiles: z.number().optional(),
    waypointRadius: z.number().optional(),
    executionMode: z.enum(["dry_run", "execute"]).optional(),
    confirmExecution: z.string().optional().describe(`Required for named destination execution: ${NAVIGATE_EXECUTE_CONFIRMATION}`),
    sessionId: z.string().optional(),
    ...clientTargetSchema(),
  },
  async ({ destinationName, from, worldX, worldY, plane, maxStepTiles, waypointRadius, executionMode, confirmExecution, sessionId, instanceId, playerName, port }) => {
    try {
      await ensureAgentMemoryLoaded();
      const session = sessionId ? getAgentSession(sessionId) : undefined;
      const mode = executionMode ?? session?.executionMode ?? "dry_run";
      if (destinationName) {
        const navigation = await navigateToDestinationAction({
          destination: destinationName,
          from,
          executionMode: mode,
          confirmExecution,
          maxStepTiles,
          waypointRadius,
          targetClient: { instanceId, playerName, port },
        });
        const selectedStep = {
          tool: "navigate_to",
          arguments: {
            destination: destinationName,
            from,
            executionMode: mode,
            maxStepTiles,
            waypointRadius,
          },
        };
        const result = {
          status: navigation.executed
            ? "EXECUTED"
            : navigation.status === "ROUTE_PLANNED" && navigation.willExecute === false && mode === "execute"
              ? "EXECUTION_BLOCKED"
              : navigation.status === "ROUTE_PLANNED" && mode !== "execute"
                ? "DRY_RUN_READY"
                : navigation.status,
          willExecute: navigation.willExecute,
          executed: navigation.executed,
          selectedStep,
          verification: {
            verified: navigation.executed === true || mode !== "execute",
            dryRun: mode !== "execute",
            routeStatus: navigation.status,
          },
          stopReason: navigation.stopReason,
          navigation,
          destinationName,
          session: publicAgentSession(session),
        };
        if (session && navigation.executed) {
          session.stepCount += 1;
        }
        recordAgentEvent(session, navigation.executed ? "skill_travel:execute" : "skill_travel:dry_run", result);
        return jsonTool(result);
      }
      if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) {
        return jsonTool({ status: "UNSUPPORTED_ACTIVITY", willExecute: false, executed: false, selectedStep: null, verification: { verified: false }, stopReason: "skill_travel requires either destinationName or worldX/worldY.", destinationName, session: publicAgentSession(session) });
      }
      const result = await runActivityStep({
        label: "skill_travel",
        step: { tool: "invoke_walk_action", arguments: { worldX, worldY, plane } },
        executionMode: mode,
        session,
        target: { instanceId, playerName, port },
        verification: { startedAt: Date.now(), expectedWorldX: worldX, expectedWorldY: worldY, expectedPlane: plane, locationRadius: 1, timeoutMs: 10000, pollMs: 500 },
      });
      return jsonTool({ ...result, destinationName, session: publicAgentSession(session) });
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("running skill_travel", e) }] };
    }
  }
);

server.tool(
  "skill_manage_inventory",
  "Inventory abstraction for bounded item drop/deposit/withdraw steps through safe System 1 primitives.",
  {
    action: z.enum(["deposit_all", "deposit", "withdraw", "keep_only", "use_on_target", "eat_when_low", "drop"]),
    itemName: z.string().optional(),
    itemId: z.number().optional(),
    slot: z.number().optional(),
    quantity: z.number().optional(),
    bankQuantity: z.union([z.string(), z.number()]).optional().describe("Bank action quantity, for example All, 1, 5, 10, or X"),
    executionMode: z.enum(["dry_run", "execute"]).optional(),
    sessionId: z.string().optional(),
    ...clientTargetSchema(),
  },
  async ({ action, itemName, itemId, slot, quantity, bankQuantity, executionMode, sessionId, instanceId, playerName, port }) => {
    try {
      await ensureAgentMemoryLoaded();
      const session = sessionId ? getAgentSession(sessionId) : undefined;
      if (session?.status === "stopped" || session?.status === "paused") {
        return jsonTool({ status: "SESSION_NOT_RUNNING", willExecute: false, executed: false, selectedStep: null, verification: { verified: false }, stopReason: session.stopReason ?? `Session is ${session.status}.`, session: publicAgentSession(session) });
      }

      const isBankAction = action === "deposit_all" || action === "deposit" || action === "withdraw";
      if (action !== "drop" && !isBankAction) {
        return jsonTool({
          status: "UNSUPPORTED_ACTIVITY",
          willExecute: executionMode === "execute",
          executed: false,
          selectedStep: null,
          verification: { verified: false },
          action,
          itemName,
          itemId,
          quantity,
          stopReason: "skill_manage_inventory currently supports drop, deposit, deposit_all for a named item, and withdraw. Eat/use policies are exposed through other System 1 tools until hardened here.",
          session: publicAgentSession(session),
        });
      }

      if (action === "drop" && !itemName && !Number.isFinite(itemId) && !Number.isFinite(slot)) {
        return jsonTool({
          status: "EXECUTION_BLOCKED",
          willExecute: false,
          executed: false,
          selectedStep: null,
          verification: { verified: false, reason: "Drop requires itemName, itemId, or slot." },
          action,
          stopReason: "Drop requires itemName, itemId, or slot.",
          session: publicAgentSession(session),
        });
      }

      if (isBankAction && !itemName && !Number.isFinite(itemId)) {
        return jsonTool({
          status: "EXECUTION_BLOCKED",
          willExecute: false,
          executed: false,
          selectedStep: null,
          verification: { verified: false, reason: "Bank inventory management requires itemName or itemId." },
          action,
          stopReason: "Bank inventory management requires itemName or itemId.",
          session: publicAgentSession(session),
        });
      }

      const resolved = await resolveActivityClient({ instanceId, playerName, port });
      if (resolved.status !== "READY") {
        return jsonTool({ status: resolved.status, willExecute: false, executed: false, selectedStep: null, verification: { verified: false, reason: resolved.reason }, stopReason: resolved.reason, clients: resolved.clients, session: publicAgentSession(session) });
      }
      const snapshot = await getSnapshotForBase(resolved.baseURL as string, true);
      const currentQuantity = inventoryQuantity(snapshot, itemName, itemId);
      const selectedStep = isBankAction
        ? {
            tool: action === "withdraw" ? "withdraw_bank_item" : "deposit_inventory_item",
            arguments: {
              itemName,
              itemId,
              quantity: String(action === "deposit_all" ? "All" : bankQuantity ?? quantity ?? (action === "withdraw" ? 1 : "All")),
            },
          }
        : {
            tool: "drop_inventory_item",
            arguments: { name: itemName, id: itemId, slot },
          };
      const result = await runActivityStep({
        label: "skill_manage_inventory",
        step: selectedStep,
        executionMode: executionMode ?? session?.executionMode ?? "dry_run",
        session,
        target: { instanceId, playerName, port },
        verification: {
          startedAt: Date.now(),
          inventoryItemName: itemName,
          inventoryItemId: itemId,
          inventoryQuantityChangedFrom: currentQuantity,
          timeoutMs: 6000,
          pollMs: 500,
        },
      });
      return jsonTool({
        ...result,
        action,
        itemName,
        itemId,
        slot,
        quantityRequested: quantity,
        startQuantity: currentQuantity,
        session: publicAgentSession(session),
      });
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("running skill_manage_inventory", e) }] };
    }
  }
);

server.tool(
  "skill_earn_gp",
  "Phase 1 GP abstraction placeholder. It can suggest log acquisition but GE/shop selling arrives in the economy phase.",
  {
    amount: z.number().describe("GP amount to earn"),
    allowedMethods: z.array(z.string()).optional(),
    executionMode: z.enum(["dry_run", "execute"]).optional(),
    sessionId: z.string().optional(),
  },
  async ({ amount, allowedMethods, executionMode, sessionId }) => {
    await ensureAgentMemoryLoaded();
    const session = sessionId ? getAgentSession(sessionId) : undefined;
    return jsonTool({
      status: "PLANNED_ONLY",
      willExecute: false,
      executed: false,
      selectedStep: {
        tool: "skill_acquire",
        arguments: { itemName: "Logs", quantity: 28, method: "woodcutting", executionMode: "dry_run" },
      },
      verification: { verified: false, reason: "GE/shop selling is not implemented in Phase 1." },
      amount,
      allowedMethods,
      requestedExecutionMode: executionMode,
      stopReason: "Phase 1 can gather starter resources, but earning verified GP requires the Phase 7 economy/trading module.",
      session: publicAgentSession(session),
    });
  }
);

server.tool(
  "skill_combat",
  "Fight a visible NPC through bounded Attack interactions with HP-aware verification. Looting is best-effort for nearby ground items.",
  {
    target: z.string().describe("NPC target name, for example Chicken or Cow"),
    killCount: z.number().optional().describe("Target number of attack cycles/kills, default 1"),
    style: z.string().optional(),
    eatThreshold: z.number().optional().describe("Stop if HP is at or below this value before the next attack"),
    loot: z.boolean().optional(),
    lootName: z.string().optional().describe("Ground item to take after combat, default Bones when loot=true"),
    maxSteps: z.number().optional(),
    executionMode: z.enum(["dry_run", "execute"]).optional(),
    sessionId: z.string().optional(),
    ...clientTargetSchema(),
  },
  async ({ target, killCount, style, eatThreshold, loot, lootName, maxSteps, executionMode, sessionId, instanceId, playerName, port }) => {
    try {
      await ensureAgentMemoryLoaded();
      const session = sessionId ? getAgentSession(sessionId) : undefined;
      const mode = executionMode ?? session?.executionMode ?? "dry_run";
      const resolved = await resolveActivityClient({ instanceId, playerName, port });
      if (resolved.status !== "READY") {
        return jsonTool({ status: resolved.status, willExecute: false, executed: false, selectedStep: null, verification: { verified: false, reason: resolved.reason }, stopReason: resolved.reason, clients: resolved.clients, session: publicAgentSession(session) });
      }
      const limit = mode === "execute" ? Math.max(1, Math.min(20, maxSteps ?? killCount ?? 1)) : 1;
      const attempts: any[] = [];
      let stopReason: string | undefined;
      for (let attempt = 0; attempt < limit; attempt += 1) {
        const snapshot = await getSnapshotForBase(resolved.baseURL as string, true);
        const hp = Number(snapshot.state?.health);
        if (eatThreshold !== undefined && Number.isFinite(hp) && hp <= eatThreshold) {
          stopReason = `HP ${hp} is at or below eatThreshold ${eatThreshold}.`;
          break;
        }
        const attack = await runActivityStep({
          label: "skill_combat",
          step: { tool: "interact_with", arguments: { entityType: "npc", name: target, option: "Attack", nearestToPlayer: true } },
          executionMode: mode,
          session,
          target: { instanceId, playerName, port },
          verification: { startedAt: Date.now(), expectIdle: true, timeoutMs: 25000, pollMs: 800 },
        });
        attempts.push({ type: "attack", ...attack });
        if (mode !== "execute") {
          stopReason = "DRY_RUN_ONLY";
          break;
        }
        if (attack.stopReason) {
          stopReason = attack.stopReason;
          break;
        }
        if (loot) {
          const lootResult = await runActivityStep({
            label: "skill_combat_loot",
            step: { tool: "interact_with", arguments: { entityType: "ground_item", name: lootName ?? "Bones", option: "Take", nearestToPlayer: true } },
            executionMode: mode,
            session,
            target: { instanceId, playerName, port },
            verification: { startedAt: Date.now(), inventoryItemName: lootName ?? "Bones", inventoryQuantityAtLeast: 1, timeoutMs: 5000, pollMs: 500 },
            maxAgeMs: 1500,
          });
          attempts.push({ type: "loot", ...lootResult });
        }
      }
      return jsonTool({
        status: stopReason && stopReason !== "DRY_RUN_ONLY" ? "ACTIVITY_INCOMPLETE" : mode === "execute" ? "ACTIVITY_COMPLETED_OR_IN_PROGRESS" : "DRY_RUN_READY",
        willExecute: mode === "execute",
        executed: attempts.some((attempt) => attempt.executed),
        target,
        style,
        killCount: killCount ?? 1,
        lootIntent: loot ? {
          enabled: true,
          itemName: lootName ?? "Bones",
          selectedStep: { tool: "interact_with", arguments: { entityType: "ground_item", name: lootName ?? "Bones", option: "Take", nearestToPlayer: true } },
        } : { enabled: false },
        attempts,
        selectedStep: attempts.at(-1)?.selectedStep ?? null,
        verification: attempts.at(-1)?.verification ?? { verified: false },
        stopReason,
        session: publicAgentSession(session),
      });
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("running skill_combat", e) }] };
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
  "get_pathfinding_status",
  "Report current pathfinding capability: loaded-scene collision-map A*, global routing availability, and Shortest Path bridge readiness.",
  {
    ...clientTargetSchema(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const status = await getPathfindingStatusForTarget({ instanceId, playerName, port });
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching pathfinding status", e) }] };
    }
  }
);

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
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "SCREENSHOT_CAPTURE_FAILED",
            imageIncluded: false,
            mimeType: "image/png",
            error: e?.message ?? String(e),
          }, null, 2)
        }]
      };
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
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "SCREENSHOT_CAPTURE_FAILED",
            imageIncluded: false,
            mimeType: "image/png",
            error: e?.message ?? String(e),
          }, null, 2)
        }]
      };
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
  "get_current_location",
  "Alias for get_player_location. Get the current player name, world location, health, run energy, tick, capturedAt, and ageMs.",
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
      return { content: [{ type: "text", text: errorText("fetching current location", e) }] };
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
  "transport_graph_status",
  "Inspect the curated System 1 global transport graph used for named-location navigation.",
  {},
  async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "TRANSPORT_GRAPH_READY",
        provider: "graphology_transport_graph",
        callsLlm: false,
        ...transportGraphSummary(),
        resource: "osrs://transport/graph",
      }, null, 2)
    }]
  })
);

server.tool(
  "plan_route",
  "Plan a global named-location route over the System 1 transport graph without clicking or walking.",
  {
    from: z.string().optional().describe("Optional start node/name/tag, for example Lumbridge Castle. If omitted, uses current player location when a client is available."),
    to: z.string().describe("Destination node/name/tag, for example Varrock West Bank or Draynor Willows"),
    ...clientTargetSchema(),
  },
  async ({ from, to, instanceId, playerName, port }) => {
    try {
      let currentLocation: any;
      let clientStatus = "not_needed";
      if (!from) {
        try {
          const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port }, true);
          currentLocation = snapshot.state?.location;
          clientStatus = "used_current_location";
        } catch (e: any) {
          clientStatus = `current_location_unavailable:${e?.message ?? String(e)}`;
        }
      }
      const route = planTransportRoute({ from, to, currentLocation });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...route,
            willExecute: false,
            executed: false,
            clientStatus,
            executionRule: "plan_route is read-only. Use navigate_to with explicit arming to move one bounded step.",
          }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("planning transport route", e) }] };
    }
  }
);

server.tool(
  "navigate_to",
  `Plan a System 1 route to a named destination and optionally execute one bounded movement step. Execution requires confirmExecution='${NAVIGATE_EXECUTE_CONFIRMATION}'.`,
  {
    destination: z.string().describe("Destination node/name/tag, for example Varrock West Bank, Draynor Bank, or Lumbridge Cows"),
    from: z.string().optional().describe("Optional start node/name/tag. If omitted, uses current player location."),
    executionMode: z.enum(["dry_run", "execute"]).optional().describe("dry_run plans only; execute performs at most one bounded movement step"),
    confirmExecution: z.string().optional().describe(`Required for executionMode=execute: ${NAVIGATE_EXECUTE_CONFIRMATION}`),
    maxStepTiles: z.number().optional().describe("Maximum tiles for the one movement step, default 18"),
    waypointRadius: z.number().optional().describe("Consider a transport waypoint reached when within this many tiles, default 8"),
    ...clientTargetSchema(),
  },
  async ({ destination, from, executionMode, confirmExecution, maxStepTiles, waypointRadius, instanceId, playerName, port }) => {
    try {
      const result = await navigateToDestinationAction({
        destination,
        from,
        executionMode,
        confirmExecution,
        maxStepTiles,
        waypointRadius,
        targetClient: { instanceId, playerName, port },
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("navigating to destination", e) }] };
    }
  }
);

server.tool(
  "perceive_minimap",
  "Read compact minimap/camera context for System 1 active perception. Optionally projects one destination tile.",
  {
    worldX: z.number().optional(),
    worldY: z.number().optional(),
    plane: z.number().optional(),
    maxEntities: z.number().optional().describe("Maximum semantic minimap icons/POIs to return, default 80"),
    ...clientTargetSchema(),
  },
  async ({ worldX, worldY, plane, maxEntities, instanceId, playerName, port }) => {
    try {
      const api = await apiForTarget({ instanceId, playerName, port });
      const params = worldX !== undefined && worldY !== undefined ? { worldX, worldY, plane } : undefined;
      const [minimap, icons, camera] = await Promise.all([
        api.get("/minimap", { params }),
        api.get("/minimap/icons", { params: { maxEntities: maxEntities ?? 80 } }),
        api.get("/camera"),
      ]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "PERCEIVED_MINIMAP",
            willExecute: false,
            executed: false,
            minimap: minimap.data,
            semanticIcons: icons.data,
            camera: camera.data,
          }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("perceiving minimap", e) }] };
    }
  }
);

server.tool(
  "perceive_chat",
  "Read compact recent chat/game messages for System 1 active perception.",
  {
    limit: z.number().optional().describe("Maximum chat messages, default 20"),
    type: z.string().optional().describe("Optional chat type filter"),
    contains: z.string().optional().describe("Optional case-insensitive message substring filter"),
    ...clientTargetSchema(),
  },
  async ({ limit, type, contains, instanceId, playerName, port }) => {
    try {
      const res = await (await apiForTarget({ instanceId, playerName, port })).get("/chat", { params: { limit: limit ?? 20 } });
      const messages = Array.isArray(res.data?.messages) ? res.data.messages : [];
      const needle = String(contains ?? "").toLowerCase();
      const filtered = messages.filter((message: any) =>
        (!type || String(message.type ?? "") === type) &&
        (!needle || String(message.message ?? "").toLowerCase().includes(needle))
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "PERCEIVED_CHAT",
            willExecute: false,
            executed: false,
            count: filtered.length,
            messages: filtered,
          }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("perceiving chat", e) }] };
    }
  }
);

server.tool(
  "perceive_ui_region",
  "Read compact UI/interface perception with semantic controls and optional bounded widget filtering.",
  {
    widgetFilter: z.string().optional().describe("Optional widget text/action/id filter"),
    maxWidgets: z.number().optional().describe("Maximum raw widgets to inspect, default 80"),
    includeHidden: z.boolean().optional().describe("Include hidden widgets, default false"),
    ...clientTargetSchema(),
  },
  async ({ widgetFilter, maxWidgets, includeHidden, instanceId, playerName, port }) => {
    try {
      const result = await getSemanticInterfaceForTarget({ instanceId, playerName, port }, {
        widgetFilter,
        maxWidgets: maxWidgets ?? 80,
        includeHidden: includeHidden ?? false,
        forceRefresh: true,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "PERCEIVED_UI_REGION",
            willExecute: false,
            executed: false,
            baseURL: result.baseURL,
            widgetError: result.widgetError,
            dialogue: result.semantic.dialogue,
            groups: result.semantic.groups,
            recommendedNext: result.semantic.recommendedNext,
            controls: result.semantic.controls.slice(0, 40),
          }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("perceiving UI region", e) }] };
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
    includeIcons: z.boolean().optional().describe("Include semantic minimap icons/POIs from /api/minimap/icons"),
    maxEntities: z.number().optional().describe("Maximum semantic minimap icons/POIs when includeIcons is true, default 80"),
    ...clientTargetSchema(),
  },
  async ({ worldX, worldY, plane, includeIcons, maxEntities, instanceId, playerName, port }) => {
    try {
      const params = worldX !== undefined && worldY !== undefined ? { worldX, worldY, plane } : undefined;
      const api = await apiForTarget({ instanceId, playerName, port });
      const res = await api.get("/minimap", { params });
      if (!includeIcons) {
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
      }
      const icons = await api.get("/minimap/icons", { params: { maxEntities: maxEntities ?? 80 } });
      return { content: [{ type: "text", text: JSON.stringify({ ...res.data, semanticIcons: icons.data }, null, 2) }] };
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
  "Walk one bounded step toward a target world tile using local collision-aware in-client walking only. Does not use hardware mouse or minimap fallback.",
  {
    worldX: z.number().describe("Target world X tile"),
    worldY: z.number().describe("Target world Y tile"),
    plane: z.number().optional().describe("Target plane, defaults to the player's current plane"),
    maxStepTiles: z.number().optional().describe("Maximum local in-client step length in tiles, default 18"),
    maxNodes: z.number().optional().describe("Maximum local collision-map nodes to search, default 4096"),
    ...clientTargetSchema(),
  },
  async ({ worldX, worldY, plane, maxStepTiles, maxNodes, instanceId, playerName, port }) => {
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

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            mode: "in_client_only",
            status: "NAVIGATION_BLOCKED",
            executed: false,
            stopReason: "COLLISION_LOCAL_PATH_UNAVAILABLE",
            path: collisionPath,
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
    maxAgeMs: z.number().optional().describe("Maximum accepted minimap projection age only when deprecated allowMinimapFallback=true, default 1000"),
    allowMinimapFallback: z.boolean().optional().describe("Deprecated safety switch. Defaults false; normal navigation never uses hardware mouse/minimap fallback."),
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
    const useFallback = allowMinimapFallback === true;
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
      const result = await dropInventoryItemAction({ name, id, instanceId, playerName, port });
      return { content: [{ type: "text", text: `Dropped inventory item ${result.item.name ?? result.item.id} from slot ${result.item.slot}.` }] };
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
            await typeHardwareInput(Key.Space, "Dialogue continue requested hardware Space.");
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
            await typeHardwareInput([Key.Num1, Key.Num2, Key.Num3, Key.Num4, Key.Num5, Key.Num6, Key.Num7, Key.Num8, Key.Num9][selectedIndex], `Dialogue option requested hardware number key ${selectedIndex + 1}.`);
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
  "request_os_control",
  "Request temporary permission to use the hardware mouse/keyboard. Standard gameplay tools should prefer in-client RuneLite actions and call this only for unmapped UI emergencies.",
  {
    reason: z.string().describe("Why OS-level mouse/keyboard control is needed"),
    timeoutMs: z.number().optional().describe("Approval timeout in milliseconds, default 60000"),
  },
  async ({ reason, timeoutMs }) => {
    const safeTimeout = Math.max(1000, Math.min(timeoutMs ?? 60000, 120000));
    const policyPaused = reflexEngine.pause("OS_CONTROL_REQUESTED");
    const request = {
      reason,
      timestamp: Date.now(),
      policy_paused: policyPaused,
      approvalCommand: "npm run approve-os-control",
      requestFile: osControlRequestPath,
      timeoutMs: safeTimeout,
    };

    try {
      await mkdir(workDir, { recursive: true });
      await writeFile(osControlRequestPath, JSON.stringify(request, null, 2), "utf8");
      await notifyOsControlRequest(reason);
      const approval = await waitForOsControlApproval(safeTimeout);
      if (!approval.approved) {
        reflexEngine.stop("OS_CONTROL_REQUEST_TIMEOUT");
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "OS_CONTROL_TIMEOUT",
              executed: false,
              willExecute: false,
              request,
              approval,
              stopReason: "OS_CONTROL_REQUEST_TIMEOUT",
              next: "System 2 should re-plan using in-client tools or ask the user before trying OS control again.",
            }, null, 2)
          }]
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "OS_CONTROL_APPROVED",
            executed: false,
            willExecute: true,
            request,
            approval,
            approvedForMs: safeTimeout,
            expiresAt: osControlApprovedUntil,
          }, null, 2)
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error requesting OS control: ${e.message}` }] };
    }
  }
);

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
        osControlRequestPath,
        osControlPending: await fileExists(osControlRequestPath),
        osControlApprovedUntil,
        osControlApproved: Date.now() < osControlApprovedUntil,
        note: "Hardware input is blocked by default for gameplay. Use request_os_control, then approve with npm run approve-os-control, before OS mouse/keyboard tools can run.",
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
      await requireOsControl(`Hardware mouse click requested at ${Math.round(x)}, ${Math.round(y)}.`);
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
      await typeHardwareInput(text, "Hardware keyboard text input requested.");
      if (pressEnter) {
        await typeHardwareInput(Key.Enter, "Hardware Enter key requested after text input.");
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
      await typeHardwareInput(k, `Hardware key press requested: ${keyName}.`);
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

