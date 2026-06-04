#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const requiredTools = [
  "get_agent_context",
  "observe_game",
  "plan_next_action",
  "prepare_agent_step",
  "validate_prepared_step",
  "run_agent_cycle",
  "execute_agent_step",
  "load_policy",
  "reflex_status",
  "reflex_pause",
  "reflex_resume",
  "reflex_stop",
  "reflex_tick_once",
  "reflex_history",
  "agent_start_goal",
  "agent_status",
  "agent_stop",
  "agent_pause",
  "agent_resume",
  "agent_history",
  "agent_run_goal",
  "agent_memory_status",
  "agent_memory_sessions",
  "strategy_cache_get",
  "strategy_cache_put",
  "strategy_cache_list",
  "strategy_cache_record_outcome",
  "memory_get_profile",
  "memory_get_goal",
  "memory_search_lessons",
  "memory_record_observation",
  "memory_record_action",
  "knowledge_query",
  "knowledge_get_method",
  "knowledge_get_location",
  "knowledge_get_quest",
  "knowledge_get_monster",
  "knowledge_get_gear",
  "get_semantic_interface",
  "semantic_find_control",
  "semantic_invoke_control",
  "quest_plan_next_step",
  "complete_quest",
  "skill_interact",
  "skill_acquire",
  "skill_train",
  "skill_manage_inventory",
  "skill_travel",
  "skill_earn_gp",
  "skill_combat",
  "diagnose_runtime",
  "list_clients",
  "select_client",
  "get_game_state",
  "get_inventory",
  "get_game_objects",
  "get_npcs",
  "get_dialogue",
  "get_widgets",
  "mark_action_baseline",
  "verify_last_action",
  "interact_with",
  "invoke_menu_action",
  "invoke_walk_action",
  "invoke_widget_action",
  "calculate_path_to",
  "walk_route_to",
  "transport_graph_status",
  "plan_route",
  "navigate_to",
  "perceive_minimap",
  "perceive_chat",
  "perceive_ui_region",
  "get_pathfinding_status",
  "capture_canvas_screenshot",
  "get_screenshot",
  "verify_after_action",
  "perform_until",
];

const requiredResources = [
  "osrs://snapshot/latest",
  "osrs://events/recent",
  "osrs://client/identity",
  "osrs://memory/profile",
  "osrs://memory/strategy-cache",
  "osrs://knowledge/index",
  "osrs://semantic/interface",
  "osrs://reflex/status",
  "osrs://transport/graph",
];

const requiredPrompts = [
  "experienced-player-loop",
  "woodcut-and-bank",
  "complete-dialogue",
  "withdraw-and-equip",
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

async function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timer]);
  } finally {
    clearTimeout(timeout);
  }
}

function assertHasNames(kind, actualNames, expectedNames) {
  const missing = expectedNames.filter((name) => !actualNames.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing ${kind}: ${missing.join(", ")}`);
  }
}

function textContent(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") {
    throw new Error(`Expected text content, got ${JSON.stringify(result)}`);
  }
  return text;
}

function parseJsonToolResult(result, toolName) {
  try {
    return JSON.parse(textContent(result));
  } catch (error) {
    throw new Error(`Tool ${toolName} did not return JSON text: ${error.message}`);
  }
}

const args = parseArgs(process.argv);
const serverPath = args.get("server") ?? fileURLToPath(new URL("../build/index.js", import.meta.url));
const serverCwd = fileURLToPath(new URL("..", import.meta.url));
const requestTimeoutMs = Number(args.get("timeout-ms") ?? 10000);
const live = args.get("live") === "true";
const nonLiveTarget = live ? {} : { port: 65535 };

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: serverCwd,
  stderr: "pipe",
  env: {
    ...process.env,
    OSRS_API_TIMEOUT_MS: process.env.OSRS_API_TIMEOUT_MS ?? (live ? "1500" : "300"),
    OSRS_SNAPSHOT_CACHE_TTL_MS: process.env.OSRS_SNAPSHOT_CACHE_TTL_MS ?? "0",
  },
});

let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

const client = new Client({ name: "osrs-mcp-smoke", version: "1.0.0" });
let report;
let childPid;

try {
  await withTimeout(client.connect(transport), requestTimeoutMs, "MCP connect");
  childPid = transport.pid;
  await delay(100);

  const tools = await withTimeout(client.listTools(), requestTimeoutMs, "listTools");
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  assertHasNames("tools", toolNames, requiredTools);

  const resources = await withTimeout(client.listResources(), requestTimeoutMs, "listResources");
  const resourceUris = new Set(resources.resources.map((resource) => resource.uri));
  assertHasNames("resources", resourceUris, requiredResources);

  const prompts = await withTimeout(client.listPrompts(), requestTimeoutMs, "listPrompts");
  const promptNames = new Set(prompts.prompts.map((prompt) => prompt.name));
  assertHasNames("prompts", promptNames, requiredPrompts);

  const transportStatusResult = await withTimeout(
    client.callTool({ name: "transport_graph_status", arguments: {} }),
    requestTimeoutMs,
    "transport_graph_status",
  );
  const transportStatus = parseJsonToolResult(transportStatusResult, "transport_graph_status");
  if (transportStatus.status !== "TRANSPORT_GRAPH_READY" || transportStatus.provider !== "graphology_transport_graph") {
    throw new Error(`Unexpected transport_graph_status result: ${JSON.stringify(transportStatus)}`);
  }

  const planRouteResult = await withTimeout(
    client.callTool({
      name: "plan_route",
      arguments: { from: "Lumbridge Castle", to: "Varrock West Bank" },
    }),
    requestTimeoutMs,
    "plan_route",
  );
  const plannedRoute = parseJsonToolResult(planRouteResult, "plan_route");
  if (plannedRoute.status !== "ROUTE_PLANNED" || plannedRoute.willExecute !== false || plannedRoute.executed !== false) {
    throw new Error(`Unexpected plan_route result: ${JSON.stringify(plannedRoute)}`);
  }

  const navigateResult = await withTimeout(
    client.callTool({
      name: "navigate_to",
      arguments: { from: "Lumbridge Castle", destination: "Draynor Bank", executionMode: "dry_run" },
    }),
    requestTimeoutMs,
    "navigate_to",
  );
  const navigation = parseJsonToolResult(navigateResult, "navigate_to");
  if (navigation.status !== "ROUTE_PLANNED" || navigation.willExecute !== false || navigation.executed !== false) {
    throw new Error(`Unexpected navigate_to dry-run result: ${JSON.stringify(navigation)}`);
  }

  const loadPolicyResult = await withTimeout(
    client.callTool({
      name: "load_policy",
      arguments: {
        task: "chop_logs",
        objective: "Smoke-test a dry-run System 1 woodcutting policy",
        itemName: "Logs",
        quantity: 5,
        method: "woodcutting",
        executionMode: "dry_run",
        start: false,
        ...nonLiveTarget,
      },
    }),
    requestTimeoutMs,
    "load_policy",
  );
  const loadedPolicy = parseJsonToolResult(loadPolicyResult, "load_policy");
  if (loadedPolicy.status !== "POLICY_LOADED" || loadedPolicy.tickLoop?.callsLlm !== false) {
    throw new Error(`Unexpected load_policy result: ${JSON.stringify(loadedPolicy)}`);
  }

  const reflexStatusResult = await withTimeout(
    client.callTool({ name: "reflex_status", arguments: {} }),
    requestTimeoutMs,
    "reflex_status",
  );
  const reflexStatus = parseJsonToolResult(reflexStatusResult, "reflex_status");
  if (reflexStatus.activePolicy?.status !== "loaded") {
    throw new Error(`Unexpected reflex_status after load_policy start:false: ${JSON.stringify(reflexStatus)}`);
  }

  const reflexStopResult = await withTimeout(
    client.callTool({ name: "reflex_stop", arguments: { reason: "SMOKE_DONE" } }),
    requestTimeoutMs,
    "reflex_stop",
  );
  const reflexStop = parseJsonToolResult(reflexStopResult, "reflex_stop");
  if (reflexStop.activePolicy?.status !== "stopped") {
    throw new Error(`Unexpected reflex_stop result: ${JSON.stringify(reflexStop)}`);
  }

  const contextResult = await withTimeout(
    client.callTool({
      name: "get_agent_context",
      arguments: { includeDiagnostics: false, ...nonLiveTarget },
    }),
    requestTimeoutMs,
    "get_agent_context",
  );
  const context = parseJsonToolResult(contextResult, "get_agent_context");
  if (!["NO_CLIENT", "NEEDS_CLIENT_SELECTION", "READY", "ATTENTION_NEEDED"].includes(context.status)) {
    throw new Error(`Unexpected get_agent_context status: ${context.status}`);
  }
  if (["READY", "ATTENTION_NEEDED"].includes(context.status) && context.navigation?.pathfinding?.supportsLocalPathfinding !== true) {
    throw new Error(`get_agent_context missing pathfinding status: ${JSON.stringify(context.navigation?.pathfinding)}`);
  }
  if (live && context.status === "NO_CLIENT") {
    throw new Error("Live smoke requested, but no RuneLite MCP plugin client was discovered");
  }

  const observeResult = await withTimeout(
    client.callTool({
      name: "observe_game",
      arguments: { objective: "chop 5 normal trees", includeDiagnostics: false, includePlan: true, ...nonLiveTarget },
    }),
    requestTimeoutMs,
    "observe_game",
  );
  const observation = parseJsonToolResult(observeResult, "observe_game");
  if (!["NO_CLIENT", "NEEDS_CLIENT_SELECTION", "OBSERVED"].includes(observation.status)) {
    throw new Error(`Unexpected observe_game status: ${observation.status}`);
  }
  if (observation.willExecute !== false) {
    throw new Error("observe_game must return willExecute false");
  }
  if (observation.package && observation.package.willExecute !== false) {
    throw new Error("observe_game package must return willExecute false");
  }

  const cycleResult = await withTimeout(
    client.callTool({
      name: "run_agent_cycle",
      arguments: { objective: "chop 5 normal trees", includeDiagnostics: false, ...nonLiveTarget },
    }),
    requestTimeoutMs,
    "run_agent_cycle",
  );
  const cycle = parseJsonToolResult(cycleResult, "run_agent_cycle");
  if (!["NO_CLIENT", "NEEDS_CLIENT_SELECTION", "CYCLE_READY", "CYCLE_BLOCKED"].includes(cycle.status)) {
    throw new Error(`Unexpected run_agent_cycle status: ${cycle.status}`);
  }
  if (cycle.willExecute !== false || cycle.validation?.willExecute !== false) {
    throw new Error("run_agent_cycle must never execute actions");
  }

  const diagnoseResult = await withTimeout(
    client.callTool({ name: "diagnose_runtime", arguments: {} }),
    requestTimeoutMs,
    "diagnose_runtime",
  );
  const diagnose = parseJsonToolResult(diagnoseResult, "diagnose_runtime");
  if (!Array.isArray(diagnose.reports) || typeof diagnose.checkedClients !== "number") {
    throw new Error("diagnose_runtime result is missing reports[] or checkedClients");
  }

  const planResult = await withTimeout(
    client.callTool({
      name: "plan_next_action",
      arguments: { objective: "chop 5 normal trees", includeDiagnostics: false, ...nonLiveTarget },
    }),
    requestTimeoutMs,
    "plan_next_action",
  );
  const plan = parseJsonToolResult(planResult, "plan_next_action");
  if (!["NO_CLIENT", "NEEDS_CLIENT_SELECTION", "PLANNED"].includes(plan.status)) {
    throw new Error(`Unexpected plan_next_action status: ${plan.status}`);
  }

  const prepareResult = await withTimeout(
    client.callTool({
      name: "prepare_agent_step",
      arguments: { objective: "chop 5 normal trees", includeDiagnostics: false, ...nonLiveTarget },
    }),
    requestTimeoutMs,
    "prepare_agent_step",
  );
  const prepared = parseJsonToolResult(prepareResult, "prepare_agent_step");
  if (!["NO_CLIENT", "NEEDS_CLIENT_SELECTION", "PREPARED"].includes(prepared.status)) {
    throw new Error(`Unexpected prepare_agent_step status: ${prepared.status}`);
  }
  if (prepared.package?.willExecute !== false) {
    throw new Error("prepare_agent_step must return package.willExecute false");
  }

  const validateResult = await withTimeout(
    client.callTool({
      name: "validate_prepared_step",
      arguments: {
        objective: "chop 5 normal trees",
        includeDiagnostics: false,
        ...nonLiveTarget,
        step: {
          tool: "invoke_menu_action",
          arguments: {
            param0: 0,
            param1: 0,
            menuAction: "WALK",
            identifier: 0,
            itemId: -1,
            option: "Walk here",
            target: "",
          },
        },
      },
    }),
    requestTimeoutMs,
    "validate_prepared_step",
  );
  const validated = parseJsonToolResult(validateResult, "validate_prepared_step");
  if (validated.status === "NO_CLIENT") {
    if (live && context.status !== "NO_CLIENT") {
      throw new Error(`validate_prepared_step unexpectedly found no client: ${JSON.stringify(validated)}`);
    }
  } else if (validated.status === "NEEDS_CLIENT_SELECTION") {
    if (live) {
      throw new Error(`validate_prepared_step needs client selection during live smoke: ${JSON.stringify(validated)}`);
    }
  } else if (validated.status !== "VALIDATED" || validated.validation?.willExecute !== false) {
    throw new Error(`Unexpected validate_prepared_step result: ${JSON.stringify(validated)}`);
  } else if (validated.validation?.validationMode !== "client_thread_dry_run") {
    throw new Error(`validate_prepared_step should dry-run raw invoke action, got ${validated.validation?.validationMode}`);
  }

  const executeDryRunResult = await withTimeout(
    client.callTool({
      name: "execute_agent_step",
      arguments: {
        objective: "chop 5 normal trees",
        includeDiagnostics: false,
        executionMode: "dry_run",
        ...nonLiveTarget,
        step: {
          tool: "invoke_menu_action",
          arguments: {
            param0: 0,
            param1: 0,
            menuAction: "WALK",
            identifier: 0,
            itemId: -1,
            option: "Walk here",
            target: "",
          },
        },
      },
    }),
    requestTimeoutMs,
    "execute_agent_step dry_run",
  );
  const executeDryRun = parseJsonToolResult(executeDryRunResult, "execute_agent_step dry_run");
  if (executeDryRun.status === "NO_CLIENT") {
    if (live && context.status !== "NO_CLIENT") {
      throw new Error(`execute_agent_step unexpectedly found no client: ${JSON.stringify(executeDryRun)}`);
    }
  } else if (executeDryRun.status === "NEEDS_CLIENT_SELECTION") {
    if (live) {
      throw new Error(`execute_agent_step needs client selection during live smoke: ${JSON.stringify(executeDryRun)}`);
    }
  } else if (executeDryRun.status !== "DRY_RUN_READY" || executeDryRun.willExecute !== false || executeDryRun.executed !== false) {
    throw new Error(`execute_agent_step dry_run must not execute: ${JSON.stringify(executeDryRun)}`);
  } else if (executeDryRun.actionResult?.dryRun !== true) {
    throw new Error(`execute_agent_step dry_run should use plugin dryRun for raw invoke actions: ${JSON.stringify(executeDryRun.actionResult)}`);
  }

  const startGoalResult = await withTimeout(
    client.callTool({
      name: "agent_start_goal",
      arguments: { goal: "smoke test gateway session", executionMode: "dry_run" },
    }),
    requestTimeoutMs,
    "agent_start_goal",
  );
  const startedGoal = parseJsonToolResult(startGoalResult, "agent_start_goal");
  if (startedGoal.status !== "SESSION_CREATED" || !startedGoal.session?.id || startedGoal.willExecute !== false) {
    throw new Error(`Unexpected agent_start_goal result: ${JSON.stringify(startedGoal)}`);
  }

  const statusResult = await withTimeout(
    client.callTool({ name: "agent_status", arguments: { sessionId: startedGoal.session.id } }),
    requestTimeoutMs,
    "agent_status",
  );
  const agentStatus = parseJsonToolResult(statusResult, "agent_status");
  if (agentStatus.status !== "SESSION_FOUND" || agentStatus.session?.id !== startedGoal.session.id) {
    throw new Error(`Unexpected agent_status result: ${JSON.stringify(agentStatus)}`);
  }

  const runGoalResult = await withTimeout(
    client.callTool({
      name: "agent_run_goal",
      arguments: {
        goal: "chop 1 normal tree",
        executionMode: "dry_run",
        maxSteps: 1,
        sessionId: startedGoal.session.id,
        ...nonLiveTarget,
      },
    }),
    requestTimeoutMs,
    "agent_run_goal dry_run",
  );
  const runGoal = parseJsonToolResult(runGoalResult, "agent_run_goal dry_run");
  if (!["NO_CLIENT", "NEEDS_CLIENT_SELECTION", "AUTONOMY_DRY_RUN_READY", "AUTONOMY_BLOCKED", "AUTONOMY_COMPLETED"].includes(runGoal.status)) {
    throw new Error(`Unexpected agent_run_goal dry_run result: ${JSON.stringify(runGoal)}`);
  }
  if (runGoal.willExecute !== false || runGoal.executed !== false) {
    throw new Error(`agent_run_goal dry_run must not execute: ${JSON.stringify(runGoal)}`);
  }

  const skillAcquireResult = await withTimeout(
    client.callTool({
      name: "skill_acquire",
      arguments: {
        itemName: "Logs",
        quantity: 1,
        method: "woodcutting",
        executionMode: "dry_run",
        sessionId: startedGoal.session.id,
        ...nonLiveTarget,
      },
    }),
    requestTimeoutMs,
    "skill_acquire dry_run",
  );
  const skillAcquire = parseJsonToolResult(skillAcquireResult, "skill_acquire dry_run");
  if (!["NO_CLIENT", "NEEDS_CLIENT_SELECTION", "DRY_RUN_READY", "ACTIVITY_COMPLETED"].includes(skillAcquire.status)) {
    throw new Error(`Unexpected skill_acquire dry_run result: ${JSON.stringify(skillAcquire)}`);
  }
  if (skillAcquire.willExecute !== false || skillAcquire.executed !== false) {
    throw new Error(`skill_acquire dry_run must not execute: ${JSON.stringify(skillAcquire)}`);
  }

  const skillCombatResult = await withTimeout(
    client.callTool({
      name: "skill_combat",
      arguments: {
        target: "Chicken",
        killCount: 1,
        executionMode: "dry_run",
        sessionId: startedGoal.session.id,
        ...nonLiveTarget,
      },
    }),
    requestTimeoutMs,
    "skill_combat dry_run",
  );
  const skillCombat = parseJsonToolResult(skillCombatResult, "skill_combat dry_run");
  if (!["NO_CLIENT", "NEEDS_CLIENT_SELECTION", "DRY_RUN_READY", "ACTIVITY_COMPLETED_OR_IN_PROGRESS", "ACTIVITY_INCOMPLETE"].includes(skillCombat.status)) {
    throw new Error(`Unexpected skill_combat dry_run result: ${JSON.stringify(skillCombat)}`);
  }
  if (skillCombat.willExecute !== false || skillCombat.executed !== false) {
    throw new Error(`skill_combat dry_run must not execute: ${JSON.stringify(skillCombat)}`);
  }

  const stopGoalResult = await withTimeout(
    client.callTool({ name: "agent_stop", arguments: { sessionId: startedGoal.session.id, reason: "smoke complete" } }),
    requestTimeoutMs,
    "agent_stop",
  );
  const stoppedGoal = parseJsonToolResult(stopGoalResult, "agent_stop");
  if (stoppedGoal.status !== "SESSION_STOPPED" || stoppedGoal.session?.status !== "stopped") {
    throw new Error(`Unexpected agent_stop result: ${JSON.stringify(stoppedGoal)}`);
  }

  const memoryStatusResult = await withTimeout(
    client.callTool({ name: "agent_memory_status", arguments: {} }),
    requestTimeoutMs,
    "agent_memory_status",
  );
  const memoryStatus = parseJsonToolResult(memoryStatusResult, "agent_memory_status");
  if (memoryStatus.status !== "READY" || memoryStatus.sessionCount < 1 || memoryStatus.eventCount < 1) {
    throw new Error(`Unexpected agent_memory_status result: ${JSON.stringify(memoryStatus)}`);
  }

  const memorySessionsResult = await withTimeout(
    client.callTool({ name: "agent_memory_sessions", arguments: { limit: 10 } }),
    requestTimeoutMs,
    "agent_memory_sessions",
  );
  const memorySessions = parseJsonToolResult(memorySessionsResult, "agent_memory_sessions");
  if (!memorySessions.sessions?.some((session) => session.id === startedGoal.session.id)) {
    throw new Error(`agent_memory_sessions did not include smoke session: ${JSON.stringify(memorySessions)}`);
  }

  const memoryObservationResult = await withTimeout(
    client.callTool({ name: "memory_record_observation", arguments: { sessionId: startedGoal.session.id, note: "smoke observation", observation: { ok: true } } }),
    requestTimeoutMs,
    "memory_record_observation",
  );
  const memoryObservation = parseJsonToolResult(memoryObservationResult, "memory_record_observation");
  if (memoryObservation.status !== "OBSERVATION_RECORDED" || memoryObservation.executed !== false) {
    throw new Error(`Unexpected memory_record_observation result: ${JSON.stringify(memoryObservation)}`);
  }

  const memoryActionResult = await withTimeout(
    client.callTool({ name: "memory_record_action", arguments: { sessionId: startedGoal.session.id, action: { tool: "smoke" }, result: { ok: true }, lesson: "memory smoke action" } }),
    requestTimeoutMs,
    "memory_record_action",
  );
  const memoryAction = parseJsonToolResult(memoryActionResult, "memory_record_action");
  if (memoryAction.status !== "ACTION_RECORDED" || memoryAction.executed !== false) {
    throw new Error(`Unexpected memory_record_action result: ${JSON.stringify(memoryAction)}`);
  }

  const memoryGoalResult = await withTimeout(
    client.callTool({ name: "memory_get_goal", arguments: { sessionId: startedGoal.session.id, limit: 20 } }),
    requestTimeoutMs,
    "memory_get_goal",
  );
  const memoryGoal = parseJsonToolResult(memoryGoalResult, "memory_get_goal");
  if (memoryGoal.status !== "GOAL_FOUND" || !memoryGoal.journal?.some((entry) => entry.kind === "action")) {
    throw new Error(`Unexpected memory_get_goal result: ${JSON.stringify(memoryGoal)}`);
  }

  const memoryProfileResult = await withTimeout(
    client.callTool({ name: "memory_get_profile", arguments: { forceRefresh: false } }),
    requestTimeoutMs,
    "memory_get_profile",
  );
  const memoryProfile = parseJsonToolResult(memoryProfileResult, "memory_get_profile");
  if (!["PROFILE_FOUND", "NO_PROFILE"].includes(memoryProfile.status) || memoryProfile.executed !== false) {
    throw new Error(`Unexpected memory_get_profile result: ${JSON.stringify(memoryProfile)}`);
  }

  const knowledgeMethodResult = await withTimeout(
    client.callTool({ name: "knowledge_get_method", arguments: { skill: "magic", targetLevel: 50, currentLevel: 1, preference: "safe" } }),
    requestTimeoutMs,
    "knowledge_get_method",
  );
  const knowledgeMethod = parseJsonToolResult(knowledgeMethodResult, "knowledge_get_method");
  if (knowledgeMethod.status !== "METHOD_FOUND" || !knowledgeMethod.result?.dependencyTree?.length) {
    throw new Error(`Unexpected knowledge_get_method result: ${JSON.stringify(knowledgeMethod)}`);
  }

  let screenshotChecked = false;
  let screenshotCaptureStatus = "not_checked";
  let screenshotCaptureError;
  let observeScreenshotChecked = false;
  let observeScreenshotStatus = "not_checked";
  let observeScreenshotError;
  let pathfindingStatusChecked = false;
  if (live) {
    const pathfindingStatusResult = await withTimeout(
      client.callTool({
        name: "get_pathfinding_status",
        arguments: {},
      }),
      requestTimeoutMs,
      "get_pathfinding_status",
    );
    const pathfindingStatus = parseJsonToolResult(pathfindingStatusResult, "get_pathfinding_status");
    if (pathfindingStatus.supportsLocalPathfinding !== true || !pathfindingStatus.provider) {
      throw new Error(`Unexpected get_pathfinding_status result: ${JSON.stringify(pathfindingStatus)}`);
    }
    pathfindingStatusChecked = true;

    const screenshotResult = await withTimeout(
      client.callTool({
        name: "get_screenshot",
        arguments: { includeImage: false, width: 120, height: 90 },
      }),
      requestTimeoutMs,
      "get_screenshot",
    );
    const screenshotText = textContent(screenshotResult);
    const screenshot = JSON.parse(screenshotText);
    if (["SCREENSHOT_CAPTURE_FAILED", "SCREENSHOT_FAILED"].includes(screenshot.status)) {
      screenshotCaptureStatus = "failed";
      screenshotCaptureError = screenshot.error;
    } else if (screenshot.imageIncluded !== false || screenshot.mimeType !== "image/png" || !screenshot.filePath) {
      throw new Error(`Unexpected get_screenshot metadata: ${screenshotText}`);
    } else {
      screenshotCaptureStatus = "ok";
      screenshotChecked = true;
    }

    const observeLiveResult = await withTimeout(
      client.callTool({
        name: "observe_game",
        arguments: {
          objective: "chop 5 normal trees",
          includeDiagnostics: true,
          includePlan: true,
          includeScreenshot: true,
          includeImage: false,
          width: 120,
          height: 90,
        },
      }),
      requestTimeoutMs,
      "live observe_game",
    );
    const liveObservation = parseJsonToolResult(observeLiveResult, "live observe_game");
    if (liveObservation.status !== "OBSERVED" || liveObservation.willExecute !== false) {
      throw new Error(`Unexpected live observe_game result: ${JSON.stringify(liveObservation)}`);
    }
    if (["SCREENSHOT_CAPTURE_FAILED", "SCREENSHOT_FAILED"].includes(liveObservation.screenshot?.status)) {
      observeScreenshotStatus = "failed";
      observeScreenshotError = liveObservation.screenshot.error;
    } else if (liveObservation.screenshot?.imageIncluded !== false || liveObservation.screenshot?.mimeType !== "image/png") {
      throw new Error(`Unexpected observe_game screenshot metadata: ${JSON.stringify(liveObservation.screenshot)}`);
    } else {
      observeScreenshotStatus = "ok";
      observeScreenshotChecked = true;
    }
    if (liveObservation.package?.willExecute !== false) {
      throw new Error("live observe_game package must return willExecute false");
    }
  }

  if (live) {
    const liveContextResult = await withTimeout(
      client.callTool({
        name: "get_agent_context",
        arguments: { includeDiagnostics: true, forceRefresh: true },
      }),
      requestTimeoutMs,
      "live get_agent_context",
    );
    const liveContext = parseJsonToolResult(liveContextResult, "get_agent_context");
    if (liveContext.status === "NO_CLIENT") {
      throw new Error("Live smoke requested, but no RuneLite MCP plugin client was discovered");
    }
  }

  const startupLineSeen = /OSRS MCP Server running on stdio/i.test(stderr);
  report = {
    ok: true,
    serverPath,
    pid: childPid,
    startupLineSeen,
    toolCount: tools.tools.length,
    resourceCount: resources.resources.length,
    promptCount: prompts.prompts.length,
    agentContextStatus: context.status,
    observeStatus: observation.status,
    cycleStatus: cycle.status,
    executeDryRunStatus: executeDryRun.status,
    agentSessionStatus: agentStatus.session.status,
    agentRunGoalStatus: runGoal.status,
    memoryStatus: memoryStatus.status,
    memorySessionCount: memoryStatus.sessionCount,
    memoryEventCount: memoryStatus.eventCount,
    memoryJournalCount: memoryAction.persistence?.journalCount,
    knowledgeMagicMethod: knowledgeMethod.result?.method?.id,
    skillAcquireStatus: skillAcquire.status,
    skillCombatStatus: skillCombat.status,
    planStatus: plan.status,
    prepareStatus: prepared.status,
    validateStatus: validated.status,
    screenshotChecked,
    screenshotCaptureStatus,
    screenshotCaptureError,
    observeScreenshotChecked,
    observeScreenshotStatus,
    observeScreenshotError,
    pathfindingStatusChecked,
    diagnosedClients: diagnose.checkedClients,
    diagnoseAllOk: diagnose.allOk,
    diagnoseStatuses: (diagnose.reports ?? []).map((report) => ({
      port: report.port,
      apiVersion: report.apiVersion,
      expectedApiVersion: report.expectedApiVersion,
      status: report.status,
      staleRuntime: report.staleRuntime,
      missingIdentityFlags: report.missingIdentityFlags,
      warningCount: report.warnings?.length ?? 0,
    })),
  };
} finally {
  await client.close();
}

if (report) {
  await delay(150);
  let childStillRunning = false;
  if (childPid) {
    try {
      process.kill(childPid, 0);
      childStillRunning = true;
    } catch {
      childStillRunning = false;
    }
  }
  if (childStillRunning) {
    throw new Error(`MCP child process ${childPid} is still running after client.close()`);
  }
  console.log(JSON.stringify({ ...report, childClosed: true }, null, 2));
}
