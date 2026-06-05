#!/usr/bin/env node
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

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

const destination = process.env.OSRS_NAV_SMOKE_DESTINATION ?? "Draynor Bank";
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
const client = new Client({ name: "osrs-live-navigation-dry-run-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const context = await callJsonTool(client, "get_agent_context", {
    objective: "live bounded navigation dry-run smoke",
    includeDiagnostics: true,
    includeNearbyLimit: 3,
    includeInventoryLimit: 8,
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

  const planned = await callJsonTool(client, "plan_route", { to: destination });
  assert.equal(planned.status, "ROUTE_PLANNED", `Expected ROUTE_PLANNED for ${destination}, got ${JSON.stringify(planned)}`);
  assert(Array.isArray(planned.steps) && planned.steps.length >= 2, `Expected a multi-node route, got ${JSON.stringify(planned)}`);

  const dryRun = await callJsonTool(client, "navigate_to", {
    destination,
    executionMode: "dry_run",
    maxStepTiles: 18,
    waypointRadius: 8,
  });
  assert.equal(dryRun.status, "ROUTE_PLANNED", `Expected dry-run ROUTE_PLANNED, got ${JSON.stringify(dryRun)}`);
  assert.equal(dryRun.willExecute, false, "Dry-run navigation must not be armed for execution.");
  assert.equal(dryRun.executed, false, "Dry-run navigation must not move the player.");
  assert.equal(dryRun.oneStepOnly, true, "navigate_to must remain bounded to one step.");
  assert(dryRun.nextWaypoint, `Expected nextWaypoint in dry-run result, got ${JSON.stringify(dryRun)}`);
  assert.match(String(dryRun.nextInstruction ?? ""), /confirmExecution=/, "Dry-run result should explain the execution arming contract.");

  const unarmedExecute = await callJsonTool(client, "navigate_to", {
    destination,
    executionMode: "execute",
    maxStepTiles: 18,
    waypointRadius: 8,
  });
  assert.equal(unarmedExecute.executed, false, `Unarmed execute must not move the player: ${JSON.stringify(unarmedExecute)}`);
  assert.equal(unarmedExecute.willExecute, false, `Unarmed execute must be disarmed: ${JSON.stringify(unarmedExecute)}`);
  assert.equal(unarmedExecute.stopReason, "Navigation execution was requested but not armed.");

  const unknown = await callJsonTool(client, "navigate_to", {
    destination: "Moon Base Bank",
    executionMode: "dry_run",
  });
  assert.equal(unknown.status, "ROUTE_NOT_FOUND", `Expected unknown route to fail safely, got ${JSON.stringify(unknown)}`);
  assert.equal(unknown.executed, false, "Unknown destination must not execute.");

  console.log(JSON.stringify({
    ok: true,
    contextStatus: context.status,
    contextRisks: risks,
    destination,
    plannedSteps: planned.steps.length,
    totalCost: planned.totalCost,
    currentLocation: context.snapshot?.state?.location ?? context.state?.location,
    nextWaypoint: dryRun.nextWaypoint,
    dryRun: {
      status: dryRun.status,
      willExecute: dryRun.willExecute,
      executed: dryRun.executed,
      oneStepOnly: dryRun.oneStepOnly,
    },
    unarmedExecute: {
      status: unarmedExecute.status,
      willExecute: unarmedExecute.willExecute,
      executed: unarmedExecute.executed,
      stopReason: unarmedExecute.stopReason,
    },
    unknownRouteStatus: unknown.status,
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
}
