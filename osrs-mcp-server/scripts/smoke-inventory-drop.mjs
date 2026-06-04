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

function compactDrop(result) {
  return {
    status: result.status,
    willExecute: result.willExecute,
    executed: result.executed,
    action: result.action,
    itemName: result.itemName,
    startQuantity: result.startQuantity,
    selectedTool: result.selectedStep?.tool,
    validationValid: result.validation?.valid,
    validationMode: result.validation?.validationMode,
    verificationVerified: result.verification?.verified,
    actionMode: result.actionResult?.actionMode,
    selected: result.actionResult?.selected
      ? {
          option: result.actionResult.selected.option,
          actionMode: result.actionResult.selected.actionMode,
          type: result.actionResult.selected.type,
        }
      : undefined,
    stopReason: result.stopReason,
  };
}

const args = parseArgs(process.argv);
const port = Number(args.get("port") ?? 8081);
const itemName = args.get("item") ?? "Oak logs";
const execute = args.get("execute") === "true";
const serverPath = args.get("server") ?? fileURLToPath(new URL("../build/index.js", import.meta.url));
const serverCwd = fileURLToPath(new URL("..", import.meta.url));
const requestTimeoutMs = Number(args.get("timeout-ms") ?? 20000);
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

const client = new Client({ name: "osrs-inventory-drop-smoke", version: "1.0.0" });

try {
  const identity = await fetchJson(`${baseApi}/identity`, 2500, "identity");
  const beforeInventory = await fetchJson(`${baseApi}/inventory`, 2500, "before inventory");
  const beforeQuantity = inventoryQuantity(beforeInventory, itemName);
  if (beforeQuantity <= 0) {
    throw new Error(`No ${itemName} found in inventory before drop smoke.`);
  }

  await withTimeout(client.connect(transport), requestTimeoutMs, "MCP connect");
  await delay(100);

  const dryRun = parseJsonToolResult(await withTimeout(
    client.callTool({
      name: "skill_manage_inventory",
      arguments: {
        port,
        action: "drop",
        itemName,
        executionMode: "dry_run",
      },
    }),
    requestTimeoutMs,
    "skill_manage_inventory dry run",
  ), "skill_manage_inventory");
  if (dryRun.status !== "DRY_RUN_READY" || dryRun.executed !== false || dryRun.selectedStep?.tool !== "drop_inventory_item") {
    throw new Error(`Drop dry-run failed: ${JSON.stringify(compactDrop(dryRun), null, 2)}`);
  }

  let executeResult;
  let afterInventory = beforeInventory;
  if (execute) {
    executeResult = parseJsonToolResult(await withTimeout(
      client.callTool({
        name: "skill_manage_inventory",
        arguments: {
          port,
          action: "drop",
          itemName,
          executionMode: "execute",
        },
      }),
      requestTimeoutMs,
      "skill_manage_inventory execute",
    ), "skill_manage_inventory");
    if (executeResult.status !== "EXECUTED" || executeResult.executed !== true || executeResult.verification?.verified !== true) {
      throw new Error(`Drop execute failed: ${JSON.stringify(compactDrop(executeResult), null, 2)}`);
    }
    afterInventory = await fetchJson(`${baseApi}/inventory`, 2500, "after inventory");
    const afterQuantity = inventoryQuantity(afterInventory, itemName);
    if (afterQuantity >= beforeQuantity) {
      throw new Error(`Drop execute did not reduce ${itemName}: before=${beforeQuantity}, after=${afterQuantity}`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    port,
    playerName: identity.playerName,
    itemName,
    execute,
    beforeQuantity,
    afterQuantity: inventoryQuantity(afterInventory, itemName),
    beforeSlots: inventorySlotsUsed(beforeInventory),
    afterSlots: inventorySlotsUsed(afterInventory),
    dryRun: compactDrop(dryRun),
    executeResult: executeResult ? compactDrop(executeResult) : undefined,
    startupLineSeen: /OSRS MCP Server running on stdio/i.test(stderr),
  }, null, 2));
} finally {
  await client.close();
}
