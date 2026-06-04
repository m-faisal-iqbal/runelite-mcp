#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

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

function compactStepResult(result) {
  return {
    status: result.status,
    willExecute: result.willExecute,
    executed: result.executed,
    selectedTool: result.selectedStep?.tool,
    validationValid: result.validation?.valid,
    validationMode: result.validation?.validationMode,
    actionDryRun: result.actionResult?.dryRun,
    actionMenuAction: result.actionResult?.menuAction,
    actionStatus: result.actionResult?.status,
    verificationVerified: result.verification?.verified,
    stopReason: result.stopReason ?? result.reason ?? result.validation?.reason,
  };
}

const args = parseArgs(process.argv);
const serverPath = args.get("server") ?? fileURLToPath(new URL("../build/index.js", import.meta.url));
const serverCwd = fileURLToPath(new URL("..", import.meta.url));
const requestTimeoutMs = Number(args.get("timeout-ms") ?? 15000);
const port = Number(args.get("port") ?? 8080);
const dryRunCount = Number(args.get("dry-runs") ?? 10);
const executeCount = Number(args.get("executes") ?? 3);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: serverCwd,
  stderr: "pipe",
  env: {
    ...process.env,
    OSRS_API_TIMEOUT_MS: process.env.OSRS_API_TIMEOUT_MS ?? "2000",
    OSRS_SNAPSHOT_CACHE_TTL_MS: "0",
  },
});

let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

const client = new Client({ name: "osrs-live-action-smoke", version: "1.0.0" });

const safeWidgetStep = {
  tool: "invoke_widget_action",
  arguments: {
    groupId: 161,
    childId: 59,
    menuAction: "WIDGET_FIRST_OPTION",
    option: "Combat Options",
    target: "",
    tickAligned: false,
  },
};

try {
  await withTimeout(client.connect(transport), requestTimeoutMs, "MCP connect");
  await delay(100);

  const context = parseJsonToolResult(await withTimeout(
    client.callTool({
      name: "get_agent_context",
      arguments: { port, includeDiagnostics: true, forceRefresh: true },
    }),
    requestTimeoutMs,
    "get_agent_context",
  ), "get_agent_context");

  if (context.status !== "READY") {
    throw new Error(`Expected READY context before live action smoke, got ${JSON.stringify(context)}`);
  }

  const dryRuns = [];
  for (let index = 0; index < dryRunCount; index += 1) {
    const result = parseJsonToolResult(await withTimeout(
      client.callTool({
        name: "execute_agent_step",
        arguments: {
          port,
          objective: `live validation dry-run ${index + 1}`,
          executionMode: "dry_run",
          includeDiagnostics: false,
          step: safeWidgetStep,
        },
      }),
      requestTimeoutMs,
      `execute_agent_step dry-run ${index + 1}`,
    ), "execute_agent_step");
    dryRuns.push(compactStepResult(result));
    if (result.status !== "DRY_RUN_READY" || result.willExecute !== false || result.executed !== false || result.actionResult?.dryRun !== true) {
      throw new Error(`Dry-run ${index + 1} failed validation: ${JSON.stringify(result)}`);
    }
  }

  const executes = [];
  for (let index = 0; index < executeCount; index += 1) {
    const result = parseJsonToolResult(await withTimeout(
      client.callTool({
        name: "execute_agent_step",
        arguments: {
          port,
          objective: `live safe UI action ${index + 1}`,
          executionMode: "execute",
          confirmExecution: "EXECUTE_ONE_STEP",
          includeDiagnostics: false,
          includePostActionSnapshot: true,
          step: safeWidgetStep,
        },
      }),
      requestTimeoutMs,
      `execute_agent_step execute ${index + 1}`,
    ), "execute_agent_step");
    executes.push(compactStepResult(result));
    if (!["EXECUTED", "EXECUTED_ONE_STEP"].includes(result.status) || result.willExecute !== true || result.executed !== true) {
      throw new Error(`Execute ${index + 1} failed: ${JSON.stringify(result)}`);
    }
    await delay(350);
  }

  const finalContext = parseJsonToolResult(await withTimeout(
    client.callTool({
      name: "get_agent_context",
      arguments: { port, includeDiagnostics: true, forceRefresh: true },
    }),
    requestTimeoutMs,
    "final get_agent_context",
  ), "get_agent_context");

  console.log(JSON.stringify({
    ok: true,
    port,
    playerName: context.player?.name ?? context.identity?.playerName,
    initialStatus: context.status,
    finalStatus: finalContext.status,
    dryRunCount: dryRuns.length,
    executeCount: executes.length,
    dryRuns,
    executes,
    stopReason: "COMPLETED_SAFE_UI_ACTION_SMOKE",
    startupLineSeen: /OSRS MCP Server running on stdio/i.test(stderr),
  }, null, 2));
} finally {
  await client.close();
}
