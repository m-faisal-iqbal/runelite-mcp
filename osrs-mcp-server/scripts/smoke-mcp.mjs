#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const requiredTools = [
  "get_agent_context",
  "plan_next_action",
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
  "capture_canvas_screenshot",
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
    planStatus: plan.status,
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
