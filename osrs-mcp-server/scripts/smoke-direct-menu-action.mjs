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

function inventoryQuantity(inventory, name) {
  const needle = name.toLowerCase();
  return (Array.isArray(inventory) ? inventory : [])
    .filter((item) => String(item?.name ?? "").toLowerCase() === needle)
    .reduce((total, item) => total + (Number.isFinite(item?.quantity) ? Number(item.quantity) : 1), 0);
}

function inventorySlotsUsed(inventory) {
  return (Array.isArray(inventory) ? inventory : []).filter((item) => item && item.id && item.id !== -1).length;
}

function compactActionResult(result) {
  return {
    status: result.status,
    willExecute: result.willExecute,
    executed: result.executed,
    selectedTool: result.selectedStep?.tool,
    validationValid: result.validation?.valid,
    validationMode: result.validation?.validationMode,
    target: result.validation?.target
      ? {
          name: result.validation.target.name,
          id: result.validation.target.id,
          menuAction: result.validation.target.menuAction,
          option: result.validation.target.option,
          coordinateSource: result.validation.target.coordinateSource,
          screenX: result.validation.target.screenX,
          screenY: result.validation.target.screenY,
        }
      : undefined,
    actionMode: result.actionResult?.actionMode,
    nestedActionMode: result.actionResult?.action?.actionMode,
    nestedSelected: result.actionResult?.action?.selected,
    reason: result.reason ?? result.stopReason ?? result.validation?.reason ?? result.actionResult?.reason,
  };
}

const args = parseArgs(process.argv);
const port = Number(args.get("port") ?? 8081);
const serverPath = args.get("server") ?? fileURLToPath(new URL("../build/index.js", import.meta.url));
const serverCwd = fileURLToPath(new URL("..", import.meta.url));
const requestTimeoutMs = Number(args.get("timeout-ms") ?? 20000);
const pollTimeoutMs = Number(args.get("poll-timeout-ms") ?? 25000);
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

const client = new Client({ name: "osrs-direct-menu-smoke", version: "1.0.0" });

try {
  const identity = await fetchJson(`${baseApi}/identity`, 2500, "identity");
  if (identity.apiVersion !== 4 || identity.supportsDirectMenuActions !== true) {
    throw new Error(`RuneLite plugin is not current enough for direct menu smoke: ${JSON.stringify({
      apiVersion: identity.apiVersion,
      supportsDirectMenuActions: identity.supportsDirectMenuActions,
    })}`);
  }

  const initialInventory = await fetchJson(`${baseApi}/inventory`, 2500, "initial inventory");
  const initialTinOre = inventoryQuantity(initialInventory, "Tin ore");
  const initialSlots = inventorySlotsUsed(initialInventory);
  if (initialSlots >= 28) {
    throw new Error(`Inventory is full before smoke: slots=${initialSlots}`);
  }

  await withTimeout(client.connect(transport), requestTimeoutMs, "MCP connect");
  await delay(100);

  const step = {
    tool: "perform_until",
    arguments: {
      actionEntityType: "object",
      actionName: "Tin rocks",
      actionOption: "Mine",
      nearestToPlayer: true,
      condition: "inventory_quantity_at_least",
      inventoryItemName: "Tin ore",
      inventoryQuantityAtLeast: initialTinOre + 1,
    },
  };

  const dryRun = parseJsonToolResult(await withTimeout(
    client.callTool({
      name: "execute_agent_step",
      arguments: {
        port,
        objective: "mine exactly one tin ore through direct menu action smoke",
        executionMode: "dry_run",
        includeDiagnostics: false,
        maxAgeMs: 1200,
        step,
      },
    }),
    requestTimeoutMs,
    "execute_agent_step dry run",
  ), "execute_agent_step");

  if (dryRun.status !== "DRY_RUN_READY" || dryRun.willExecute !== false || dryRun.executed !== false || dryRun.validation?.valid !== true) {
    throw new Error(`Dry run did not validate: ${JSON.stringify(compactActionResult(dryRun), null, 2)}`);
  }
  if (dryRun.validation?.target?.menuAction !== "GAME_OBJECT_FIRST_OPTION") {
    throw new Error(`Dry run target is missing direct object menu action: ${JSON.stringify(compactActionResult(dryRun), null, 2)}`);
  }

  const executed = parseJsonToolResult(await withTimeout(
    client.callTool({
      name: "execute_agent_step",
      arguments: {
        port,
        objective: "mine exactly one tin ore through direct menu action smoke",
        executionMode: "execute",
        confirmExecution: "EXECUTE_ONE_STEP",
        includeDiagnostics: false,
        includePostActionSnapshot: true,
        maxAgeMs: 1200,
        step,
      },
    }),
    requestTimeoutMs,
    "execute_agent_step execute",
  ), "execute_agent_step");

  if (executed.status !== "EXECUTED_ONE_STEP" || executed.willExecute !== true || executed.executed !== true) {
    throw new Error(`Execute did not perform exactly one step: ${JSON.stringify(compactActionResult(executed), null, 2)}`);
  }
  if (executed.actionResult?.actionMode !== "perform_until_one_iteration") {
    throw new Error(`Execute did not use one perform_until iteration: ${JSON.stringify(compactActionResult(executed), null, 2)}`);
  }
  if (executed.actionResult?.action?.actionMode !== "direct_menu_action") {
    throw new Error(`Execute did not use direct menu action: ${JSON.stringify(compactActionResult(executed), null, 2)}`);
  }

  const startedPollingAt = Date.now();
  let finalInventory = initialInventory;
  let finalTinOre = initialTinOre;
  while (Date.now() - startedPollingAt <= pollTimeoutMs) {
    await delay(750);
    finalInventory = await fetchJson(`${baseApi}/inventory`, 2500, "poll inventory");
    finalTinOre = inventoryQuantity(finalInventory, "Tin ore");
    if (finalTinOre >= initialTinOre + 1) {
      break;
    }
  }

  if (finalTinOre < initialTinOre + 1) {
    const state = await fetchJson(`${baseApi}/state`, 2500, "final state");
    throw new Error(`Direct menu action executed but Tin ore did not increase before timeout: ${JSON.stringify({
      initialTinOre,
      finalTinOre,
      pollTimeoutMs,
      state: {
        status: state.status,
        animation: state.animation,
        isIdle: state.isIdle,
        interactingWith: state.interactingWith,
        location: state.location,
      },
      action: compactActionResult(executed),
    }, null, 2)}`);
  }

  const finalState = await fetchJson(`${baseApi}/state`, 2500, "final state");
  console.log(JSON.stringify({
    ok: true,
    port,
    playerName: identity.playerName,
    apiVersion: identity.apiVersion,
    supportsDirectMenuActions: identity.supportsDirectMenuActions,
    initialTinOre,
    finalTinOre,
    gainedTinOre: finalTinOre - initialTinOre,
    initialSlots,
    finalSlots: inventorySlotsUsed(finalInventory),
    dryRun: compactActionResult(dryRun),
    execute: compactActionResult(executed),
    finalState: {
      status: finalState.status,
      location: finalState.location,
      animation: finalState.animation,
      isIdle: finalState.isIdle,
      interactingWith: finalState.interactingWith,
    },
    startupLineSeen: /OSRS MCP Server running on stdio/i.test(stderr),
  }, null, 2));
} finally {
  await client.close();
}
