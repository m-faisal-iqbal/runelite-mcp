#!/usr/bin/env node
import axios from "axios";

const requiredEndpoints = [
  "/api/action/menu",
  "/api/action/walk",
  "/api/action/widget",
  "/api/state",
  "/api/snapshot",
  "/api/stream",
  "/api/events",
  "/api/path",
  "/api/widgets",
  "/api/minimap/icons",
  "/api/identity",
  "/api/debug/coordinates",
];

const requiredFlags = [
  "supportsConcurrentStreams",
  "supportsEventBuffer",
  "supportsInClientActions",
  "supportsLocalPathfinding",
  "supportsWidgetInspector",
  "supportsRuntimeDiagnostics",
];

const currentRequiredFlags = [
  ...requiredFlags,
  "supportsDirectMenuActions",
];

const readOnlyEndpoints = [
  "/identity",
  "/state",
  "/snapshot",
  "/minimap/icons",
  "/events?limit=5",
  "/debug/coordinates",
];

const optionalReadOnlyEndpoints = [
  "/path/status",
];

const dryRunActionChecks = [
  {
    name: "menu",
    endpoint: "/action/menu",
    body: {
      param0: 0,
      param1: 0,
      menuAction: "WALK",
      identifier: 0,
      itemId: -1,
      option: "Walk here",
      target: "",
      dryRun: true,
    },
  },
  {
    name: "widget",
    endpoint: "/action/widget",
    body: {
      groupId: 548,
      childId: 0,
      actionIndex: 1,
      option: "Dry-run",
      target: "",
      dryRun: true,
    },
  },
];

function parseArgs(argv) {
  const args = new Map();
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, "true");
    } else {
      args.set(key, next);
      i += 1;
    }
  }
  return args;
}

function endpointPath(endpoint) {
  return String(endpoint.path ?? "").split("?")[0];
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const args = parseArgs(process.argv);
const port = Number(args.get("port") ?? process.env.OSRS_VERIFY_PORT ?? 8080);
const baseUrl = String(args.get("api") ?? `http://127.0.0.1:${port}/api`).replace(/\/$/, "");
const timeout = Number(args.get("timeout-ms") ?? 5000);
const skipActionDryRuns = args.get("skip-action-dry-runs") === "true";
const expectedApiVersion = Number(args.get("expected-api-version") ?? 5);
const requireCurrent = args.get("require-current") === "true";
const api = axios.create({ baseURL: baseUrl, timeout });

const apiIndex = (await api.get("/")).data;
assert(Array.isArray(apiIndex.endpoints), "API index is missing endpoints[]");
const endpointPaths = new Set(apiIndex.endpoints.map(endpointPath));
const missingEndpoints = requiredEndpoints.filter((endpoint) => !endpointPaths.has(endpoint));
assert(missingEndpoints.length === 0, `Missing endpoints: ${missingEndpoints.join(", ")}`);

const identity = (await api.get("/identity")).data;
const missingFlags = requiredFlags.filter((flag) => identity[flag] !== true);
assert(missingFlags.length === 0, `Missing/false identity flags: ${missingFlags.join(", ")}`);
assert(Number(identity.apiVersion) >= 3, `Expected apiVersion >= 3, got ${identity.apiVersion}`);
const missingCurrentFlags = currentRequiredFlags.filter((flag) => identity[flag] !== true);
const reloadRequired = Number(identity.apiVersion) < expectedApiVersion || missingCurrentFlags.length > 0;
if (requireCurrent) {
  assert(Number(identity.apiVersion) >= expectedApiVersion, `Expected apiVersion >= ${expectedApiVersion}, got ${identity.apiVersion}`);
  assert(missingCurrentFlags.length === 0, `Missing/false current identity flags: ${missingCurrentFlags.join(", ")}`);
}

const reads = {};
for (const endpoint of readOnlyEndpoints) {
  const response = await api.get(endpoint);
  reads[endpoint] = {
    status: response.status,
    topLevelKeys: response.data && typeof response.data === "object" ? Object.keys(response.data).slice(0, 12) : [],
  };
}

for (const endpoint of optionalReadOnlyEndpoints) {
  if (!endpointPaths.has(`/api${endpoint.split("?")[0]}`)) {
    continue;
  }
  const response = await api.get(endpoint);
  reads[endpoint] = {
    status: response.status,
    topLevelKeys: response.data && typeof response.data === "object" ? Object.keys(response.data).slice(0, 12) : [],
  };
}

const state = (await api.get("/state")).data;
const allowedStatuses = new Set(["LOGGED_IN", "LOGIN_SCREEN", "NOT_LOGGED_IN", "HOPPING", "LOADING"]);
assert(allowedStatuses.has(state.status), `Unexpected game status: ${state.status}`);

const actionDryRuns = {};
if (!skipActionDryRuns) {
  for (const check of dryRunActionChecks) {
    const response = await api.post(check.endpoint, check.body);
    assert(response.data?.success === true, `${check.name} dry-run did not return success`);
    assert(response.data?.dryRun === true, `${check.name} dry-run did not echo dryRun true`);
    actionDryRuns[check.name] = {
      status: response.status,
      menuAction: response.data.menuAction,
      dryRun: response.data.dryRun,
      param0: response.data.param0,
      param1: response.data.param1,
    };
  }

  if (state.status === "LOGGED_IN" && state.location && Number.isFinite(state.location.x) && Number.isFinite(state.location.y)) {
    const response = await api.post("/action/walk", {
      worldX: state.location.x,
      worldY: state.location.y,
      plane: state.location.plane ?? 0,
      dryRun: true,
    });
    assert(response.data?.success === true, "walk dry-run did not return success");
    assert(response.data?.dryRun === true, "walk dry-run did not echo dryRun true");
    actionDryRuns.walk = {
      status: response.status,
      menuAction: response.data.menuAction,
      dryRun: response.data.dryRun,
      worldX: response.data.worldX,
      worldY: response.data.worldY,
      plane: response.data.plane,
      param0: response.data.param0,
      param1: response.data.param1,
    };
  } else {
    actionDryRuns.walk = {
      skipped: true,
      reason: "Client is not logged in or current world location is unavailable.",
    };
  }
}

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  endpointCount: endpointPaths.size,
  apiVersion: identity.apiVersion,
  expectedApiVersion,
  reloadRequired,
  missingCurrentFlags,
  directMenuActionsReady: identity.supportsDirectMenuActions === true,
  playerName: identity.playerName,
  status: state.status,
  canvasShowing: identity.canvasShowing,
  windowActive: identity.windowActive,
  actionDryRuns,
  reads,
}, null, 2));
