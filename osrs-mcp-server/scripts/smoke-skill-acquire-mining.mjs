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
  const text = textContent(result);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Tool ${toolName} did not return JSON text: ${error.message}; text=${text.slice(0, 500)}`);
  }
}

function compactAcquire(result) {
  const lastAttempt = Array.isArray(result.attempts) ? result.attempts.at(-1) : undefined;
  return {
    status: result.status,
    willExecute: result.willExecute,
    executed: result.executed,
    itemName: result.itemName,
    method: result.method,
    actionTarget: result.actionTarget,
    quantityRequested: result.quantityRequested,
    startQuantity: result.startQuantity,
    targetQuantity: result.targetQuantity,
    finalQuantity: result.finalQuantity,
    selectedTool: result.selectedStep?.tool,
    verificationVerified: result.verification?.verified,
    attemptCount: result.attempts?.length ?? 0,
    lastAttempt: lastAttempt
      ? {
          status: lastAttempt.status,
          executed: lastAttempt.executed,
          validationValid: lastAttempt.validation?.valid,
          validationTarget: lastAttempt.validation?.target
            ? {
                name: lastAttempt.validation.target.name,
                option: lastAttempt.validation.target.option,
                menuAction: lastAttempt.validation.target.menuAction,
                coordinateSource: lastAttempt.validation.target.coordinateSource,
              }
            : undefined,
          actionMode: lastAttempt.actionResult?.actionMode,
          nestedActionMode: lastAttempt.actionResult?.action?.actionMode,
          nestedSelected: lastAttempt.actionResult?.action?.selected,
          stopReason: lastAttempt.stopReason,
        }
      : undefined,
    stopReason: result.stopReason,
  };
}

async function fetchJson(url, timeoutMs, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${label} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function inventorySlotsUsed(inventory) {
  return (Array.isArray(inventory) ? inventory : []).filter((item) => item && item.id && item.id !== -1).length;
}

const args = parseArgs(process.argv);
const port = Number(args.get("port") ?? 8081);
const serverPath = args.get("server") ?? fileURLToPath(new URL("../build/index.js", import.meta.url));
const serverCwd = fileURLToPath(new URL("..", import.meta.url));
const requestTimeoutMs = Number(args.get("timeout-ms") ?? 25000);
const baseApi = `http://127.0.0.1:${port}/api`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: serverCwd,
  stderr: "pipe",
  env: {
    ...process.env,
    OSRS_API_TIMEOUT_MS: process.env.OSRS_API_TIMEOUT_MS ?? "2500",
    OSRS_SNAPSHOT_CACHE_TTL_MS: "0",
  },
});

let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

const client = new Client({ name: "osrs-skill-acquire-mining-smoke", version: "1.0.0" });

try {
  const identity = await fetchJson(`${baseApi}/identity`, 2500, "identity");
  if (Number(identity.apiVersion) < 4 || identity.supportsDirectMenuActions !== true) {
    throw new Error(`RuneLite plugin is not current enough for skill_acquire mining smoke: ${JSON.stringify({
      apiVersion: identity.apiVersion,
      supportsDirectMenuActions: identity.supportsDirectMenuActions,
    })}`);
  }
  const inventory = await fetchJson(`${baseApi}/inventory`, 2500, "inventory");
  if (inventorySlotsUsed(inventory) >= 28) {
    throw new Error("Inventory is full before skill_acquire mining smoke.");
  }

  await withTimeout(client.connect(transport), requestTimeoutMs, "MCP connect");
  await delay(100);

  const dryRun = parseJsonToolResult(await withTimeout(
    client.callTool({
      name: "skill_acquire",
      arguments: {
        port,
        itemName: "Tin ore",
        quantity: 1,
        method: "mining",
        executionMode: "dry_run",
      },
    }),
    requestTimeoutMs,
    "skill_acquire dry run",
  ), "skill_acquire");

  if (dryRun.status !== "DRY_RUN_READY" || dryRun.willExecute !== false || dryRun.executed !== false) {
    throw new Error(`skill_acquire dry-run failed: ${JSON.stringify(compactAcquire(dryRun), null, 2)}`);
  }
  if (dryRun.itemName !== "Tin ore" || dryRun.actionTarget?.name !== "Tin rocks" || dryRun.actionTarget?.option !== "Mine") {
    throw new Error(`skill_acquire did not resolve Tin ore mining correctly: ${JSON.stringify(compactAcquire(dryRun), null, 2)}`);
  }

  const executed = parseJsonToolResult(await withTimeout(
    client.callTool({
      name: "skill_acquire",
      arguments: {
        port,
        itemName: "Tin ore",
        quantity: 1,
        method: "mining",
        maxSteps: 4,
        executionMode: "execute",
      },
    }),
    requestTimeoutMs,
    "skill_acquire execute",
  ), "skill_acquire");

  const compactExecuted = compactAcquire(executed);
  if (executed.status !== "ACTIVITY_COMPLETED" || executed.willExecute !== true || executed.executed !== true) {
    throw new Error(`skill_acquire execute did not complete: ${JSON.stringify(compactExecuted, null, 2)}`);
  }
  if (executed.finalQuantity < executed.targetQuantity) {
    throw new Error(`skill_acquire reported completion without target quantity: ${JSON.stringify(compactExecuted, null, 2)}`);
  }
  if (compactExecuted.lastAttempt?.nestedActionMode !== "direct_menu_action") {
    throw new Error(`skill_acquire did not use direct menu action: ${JSON.stringify(compactExecuted, null, 2)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    port,
    playerName: identity.playerName,
    apiVersion: identity.apiVersion,
    supportsDirectMenuActions: identity.supportsDirectMenuActions,
    dryRun: compactAcquire(dryRun),
    execute: compactExecuted,
    startupLineSeen: /OSRS MCP Server running on stdio/i.test(stderr),
  }, null, 2));
} finally {
  await client.close();
}
