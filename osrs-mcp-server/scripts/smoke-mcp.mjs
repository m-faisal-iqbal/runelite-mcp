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
  "agent_start_goal",
  "agent_status",
  "agent_stop",
  "agent_pause",
  "agent_resume",
  "agent_history",
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

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: serverCwd,
  stderr: "pipe",
  env: {
    ...process.env,
    OSRS_API_TIMEOUT_MS: process.env.OSRS_API_TIMEOUT_MS ?? "300",
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

  const contextResult = await withTimeout(
    client.callTool({
      name: "get_agent_context",
      arguments: { includeDiagnostics: false },
    }),
    requestTimeoutMs,
    "get_agent_context",
  );
  const context = parseJsonToolResult(contextResult, "get_agent_context");
  if (!["NO_CLIENT", "READY", "ATTENTION_NEEDED"].includes(context.status)) {
    throw new Error(`Unexpected get_agent_context status: ${context.status}`);
  }
  if (context.status !== "NO_CLIENT" && context.navigation?.pathfinding?.supportsLocalPathfinding !== true) {
    throw new Error(`get_agent_context missing pathfinding status: ${JSON.stringify(context.navigation?.pathfinding)}`);
  }
  if (live && context.status === "NO_CLIENT") {
    throw new Error("Live smoke requested, but no RuneLite MCP plugin client was discovered");
  }

  const observeResult = await withTimeout(
    client.callTool({
      name: "observe_game",
      arguments: { objective: "chop 5 normal trees", includeDiagnostics: false, includePlan: true },
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
      arguments: { objective: "chop 5 normal trees", includeDiagnostics: false },
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
      arguments: { objective: "chop 5 normal trees", includeDiagnostics: false },
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
      arguments: { objective: "chop 5 normal trees", includeDiagnostics: false },
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
    if (context.status !== "NO_CLIENT") {
      throw new Error(`validate_prepared_step unexpectedly found no client: ${JSON.stringify(validated)}`);
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
    if (context.status !== "NO_CLIENT") {
      throw new Error(`execute_agent_step unexpectedly found no client: ${JSON.stringify(executeDryRun)}`);
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

  const skillAcquireResult = await withTimeout(
    client.callTool({
      name: "skill_acquire",
      arguments: {
        itemName: "Logs",
        quantity: 1,
        method: "woodcutting",
        executionMode: "dry_run",
        sessionId: startedGoal.session.id,
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

  let screenshotChecked = false;
  let observeScreenshotChecked = false;
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
    if (screenshot.imageIncluded !== false || screenshot.mimeType !== "image/png" || !screenshot.filePath) {
      throw new Error(`Unexpected get_screenshot metadata: ${screenshotText}`);
    }
    screenshotChecked = true;

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
    if (liveObservation.screenshot?.imageIncluded !== false || liveObservation.screenshot?.mimeType !== "image/png") {
      throw new Error(`Unexpected observe_game screenshot metadata: ${JSON.stringify(liveObservation.screenshot)}`);
    }
    if (liveObservation.package?.willExecute !== false) {
      throw new Error("live observe_game package must return willExecute false");
    }
    observeScreenshotChecked = true;
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
    skillAcquireStatus: skillAcquire.status,
    skillCombatStatus: skillCombat.status,
    planStatus: plan.status,
    prepareStatus: prepared.status,
    validateStatus: validated.status,
    screenshotChecked,
    observeScreenshotChecked,
    pathfindingStatusChecked,
    diagnosedClients: diagnose.checkedClients,
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
