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

function compactStatus(status) {
  return {
    running: status.running,
    activePolicy: status.activePolicy
      ? {
          id: status.activePolicy.id,
          task: status.activePolicy.task,
          status: status.activePolicy.status,
          executionMode: status.activePolicy.executionMode,
          itemName: status.activePolicy.itemName,
          quantity: status.activePolicy.quantity,
          quantityMode: status.activePolicy.quantityMode,
          startQuantity: status.activePolicy.startQuantity,
          targetQuantity: status.activePolicy.targetQuantity,
          tickCount: status.activePolicy.tickCount,
          stopReason: status.activePolicy.stopReason,
        }
      : null,
    lastEvents: status.lastEvents?.slice(-4)?.map((event) => ({
      type: event.type,
      data: event.data?.result
        ? {
            status: event.data.result.status,
            executed: event.data.result.executed,
            step: event.data.result.step,
            actionMode: event.data.result.actionResult?.actionMode,
            nestedActionMode: event.data.result.actionResult?.action?.actionMode,
            nestedSelected: event.data.result.actionResult?.action?.selected,
            reason: event.data.result.reason,
          }
        : event.data,
    })),
  };
}

class PreconditionBlocked extends Error {
  constructor(report) {
    super(report.stopReason);
    this.report = report;
  }
}

const args = parseArgs(process.argv);
const port = Number(args.get("port") ?? 8081);
const serverPath = args.get("server") ?? fileURLToPath(new URL("../build/index.js", import.meta.url));
const serverCwd = fileURLToPath(new URL("..", import.meta.url));
const requestTimeoutMs = Number(args.get("timeout-ms") ?? 30000);
const pollTimeoutMs = Number(args.get("poll-timeout-ms") ?? 35000);
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

const client = new Client({ name: "osrs-load-policy-mining-smoke", version: "1.0.0" });

try {
  const identity = await fetchJson(`${baseApi}/identity`, 2500, "identity");
  if (identity.apiVersion !== 4 || identity.supportsDirectMenuActions !== true) {
    throw new Error(`RuneLite plugin is not current enough for load_policy mining smoke: ${JSON.stringify({
      apiVersion: identity.apiVersion,
      supportsDirectMenuActions: identity.supportsDirectMenuActions,
    })}`);
  }
  const initialInventory = await fetchJson(`${baseApi}/inventory`, 2500, "initial inventory");
  const initialTinOre = inventoryQuantity(initialInventory, "Tin ore");
  if (inventorySlotsUsed(initialInventory) >= 28) {
    throw new PreconditionBlocked({
      ok: true,
      status: "PRECONDITION_BLOCKED",
      stopReason: "Inventory is full before load_policy mining smoke.",
      port,
      playerName: identity.playerName,
      initialTinOre,
      initialSlots: inventorySlotsUsed(initialInventory),
    });
  }

  const objects = await fetchJson(`${baseApi}/objects`, 3000, "objects");
  const tinRock = (Array.isArray(objects) ? objects : []).find((object) =>
    object?.name === "Tin rocks" &&
    Array.isArray(object.menuActions) &&
    object.menuActions.some((action) => action?.option === "Mine") &&
    Number.isFinite(object.screenX) &&
    Number.isFinite(object.screenY)
  );
  if (!tinRock) {
    const state = await fetchJson(`${baseApi}/state`, 2500, "state");
    throw new PreconditionBlocked({
      ok: true,
      status: "PRECONDITION_BLOCKED",
      stopReason: "No visible click-ready Tin rocks with a Mine action are available near the player.",
      port,
      playerName: identity.playerName,
      location: state.location,
      initialTinOre,
      initialSlots: inventorySlotsUsed(initialInventory),
    });
  }

  await withTimeout(client.connect(transport), requestTimeoutMs, "MCP connect");
  await delay(100);

  const loaded = parseJsonToolResult(await withTimeout(
    client.callTool({
      name: "load_policy",
      arguments: {
        port,
        task: "mine_tin",
        objective: "Gain exactly one tin ore through System 1 Reflex Engine policy.",
        itemName: "Tin ore",
        quantity: 1,
        quantityMode: "gain",
        method: "mining",
        executionMode: "execute",
        confirmExecution: "LOAD_POLICY_EXECUTE",
        tickMs: 600,
        maxTicks: 8,
        start: true,
      },
    }),
    requestTimeoutMs,
    "load_policy execute",
  ), "load_policy");

  if (loaded.status !== "POLICY_LOADED" || loaded.willExecute !== true || loaded.tickLoop?.callsLlm !== false) {
    throw new Error(`load_policy did not arm a local execute policy: ${JSON.stringify(loaded, null, 2)}`);
  }

  let finalStatus = loaded.engine;
  const startedPollingAt = Date.now();
  while (Date.now() - startedPollingAt <= pollTimeoutMs) {
    await delay(700);
    finalStatus = parseJsonToolResult(await withTimeout(
      client.callTool({ name: "reflex_status", arguments: {} }),
      requestTimeoutMs,
      "reflex_status",
    ), "reflex_status");
    const state = finalStatus.activePolicy?.status;
    if (["completed", "blocked", "stopped"].includes(state)) {
      break;
    }
  }

  const finalInventory = await fetchJson(`${baseApi}/inventory`, 2500, "final inventory");
  const finalTinOre = inventoryQuantity(finalInventory, "Tin ore");
  const compactFinal = compactStatus(finalStatus);

  if (finalStatus.activePolicy?.status !== "completed") {
    throw new Error(`Reflex policy did not complete: ${JSON.stringify(compactFinal, null, 2)}`);
  }
  if (finalTinOre < initialTinOre + 1) {
    throw new Error(`Reflex policy completed but tin ore did not increase: ${JSON.stringify({
      initialTinOre,
      finalTinOre,
      status: compactFinal,
    }, null, 2)}`);
  }
  const directMenuEvent = finalStatus.lastEvents?.find((event) =>
    event?.type === "step_result" &&
    event?.data?.result?.actionResult?.actionMode === "direct_menu_action"
  );
  if (!directMenuEvent) {
    throw new Error(`No direct_menu_action step_result found in Reflex history: ${JSON.stringify(compactFinal, null, 2)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    port,
    playerName: identity.playerName,
    apiVersion: identity.apiVersion,
    supportsDirectMenuActions: identity.supportsDirectMenuActions,
    initialTinOre,
    finalTinOre,
    gainedTinOre: finalTinOre - initialTinOre,
    loaded: {
      status: loaded.status,
      architecture: loaded.architecture,
      willExecute: loaded.willExecute,
      tickLoop: loaded.tickLoop,
    },
    finalStatus: compactFinal,
    directMenuStep: {
      step: directMenuEvent.data.result.step,
      actionResult: directMenuEvent.data.result.actionResult,
    },
    startupLineSeen: /OSRS MCP Server running on stdio/i.test(stderr),
  }, null, 2));
} catch (error) {
  if (error instanceof PreconditionBlocked) {
    console.log(JSON.stringify(error.report, null, 2));
  } else {
    throw error;
  }
} finally {
  await client.close();
}
