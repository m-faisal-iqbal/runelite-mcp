#!/usr/bin/env node
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

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

async function callJsonTool(client, name, args = {}) {
  return parseJsonToolResult(await client.callTool({ name, arguments: args }), name);
}

const serverPath = fileURLToPath(new URL("../build/index.js", import.meta.url));
const serverCwd = fileURLToPath(new URL("..", import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: serverCwd,
  stderr: "pipe",
  env: {
    ...process.env,
    OSRS_API_TIMEOUT_MS: process.env.OSRS_API_TIMEOUT_MS ?? "1500",
    OSRS_SNAPSHOT_CACHE_TTL_MS: process.env.OSRS_SNAPSHOT_CACHE_TTL_MS ?? "1500",
  },
});

transport.stderr?.on("data", () => undefined);
const client = new Client({ name: "osrs-live-reflex-dry-run-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const context = await callJsonTool(client, "get_agent_context", {
    objective: "live Reflex dry-run policy smoke",
    includeDiagnostics: true,
    includeNearbyLimit: 5,
    includeInventoryLimit: 12,
  });
  const risks = context.readiness?.risks ?? [];
  const onlyStaleRuntime = context.status === "ATTENTION_NEEDED" &&
    risks.length === 1 &&
    risks[0] === "runtime_not_current" &&
    context.readiness?.loggedIn === true;
  assert(
    context.status === "READY" || onlyStaleRuntime,
    `Expected live client READY or only runtime_not_current, got ${JSON.stringify({
      status: context.status,
      readiness: context.readiness,
      runtime: context.runtime,
    })}`,
  );

  const loaded = await callJsonTool(client, "load_policy", {
    policy: {
      task: "chop_logs",
      objective: "Dry-run one bounded local woodcutting policy step without executing gameplay actions.",
      itemName: "Logs",
      quantity: 1,
      quantityMode: "gain",
      method: "woodcutting",
      targetName: "Tree",
      targetType: "object",
      actionOption: "Chop down",
      stopOnVisiblePlayers: false,
      stopOnMinimapPlayerThreat: true,
      tickMs: 600,
      tickPollMs: 100,
      tickStallMs: 2000,
      maxTicks: 2,
    },
    executionMode: "dry_run",
    start: true,
  });
  assert.equal(loaded.status, "POLICY_LOADED", `Expected POLICY_LOADED, got ${JSON.stringify(loaded)}`);
  assert.equal(loaded.willExecute, false, "Dry-run policy must not be armed for execution.");

  await delay(2600);

  const status = await callJsonTool(client, "reflex_status");
  const history = await callJsonTool(client, "reflex_history", { limit: 50 });
  const events = history.events ?? [];
  const stepResults = events.filter((event) => event.type === "step_result");
  const executedResults = stepResults.filter((event) => event.data?.result?.executed === true);
  const observedTicks = events.filter((event) => event.type === "tick_observed").length;
  const terminalEvents = events.filter((event) => ["policy_completed", "policy_blocked", "policy_paused"].includes(event.type));

  assert.equal(executedResults.length, 0, `Dry-run Reflex policy executed a real action: ${JSON.stringify(executedResults)}`);
  assert(observedTicks > 0 || terminalEvents.length > 0, `Expected at least one tick or terminal event, got ${JSON.stringify(events)}`);

  const stopped = await callJsonTool(client, "reflex_stop", { reason: "LIVE_REFLEX_DRY_RUN_SMOKE_DONE" });

  console.log(JSON.stringify({
    ok: true,
    contextStatus: context.status,
    contextRisks: risks,
    loadedStatus: loaded.status,
    activePolicyStatus: status.activePolicy?.status,
    activePolicyStopReason: status.activePolicy?.stopReason,
    observedTicks,
    stepResultCount: stepResults.length,
    executedResultCount: executedResults.length,
    terminalEvents: terminalEvents.map((event) => ({
      type: event.type,
      reason: event.data?.reason,
    })),
    stoppedStatus: stopped.activePolicy?.status,
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
}
