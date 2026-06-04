#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../build/index.js", import.meta.url));
const serverCwd = fileURLToPath(new URL("..", import.meta.url));
const dbPath = path.join(os.tmpdir(), `osrs-agent-memory-smoke-${process.pid}-${Date.now()}.sqlite`);
const requestTimeoutMs = 10000;
const goal = `phase 3 memory smoke ${Date.now()}`;

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

async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: serverCwd,
    stderr: "pipe",
    env: {
      ...process.env,
      OSRS_AGENT_DB_PATH: dbPath,
      OSRS_API_TIMEOUT_MS: "300",
      OSRS_SNAPSHOT_CACHE_TTL_MS: "0",
    },
  });
  const client = new Client({ name: "osrs-agent-memory-smoke", version: "1.0.0" });
  await withTimeout(client.connect(transport), requestTimeoutMs, "MCP connect");
  try {
    return await fn(client, transport.pid);
  } finally {
    await client.close();
  }
}

let createdSessionId;
let firstPid;
let secondPid;
try {
  const first = await withClient(async (client, pid) => {
    firstPid = pid;
    const started = parseJsonToolResult(await withTimeout(
      client.callTool({ name: "agent_start_goal", arguments: { goal, executionMode: "dry_run" } }),
      requestTimeoutMs,
      "agent_start_goal",
    ), "agent_start_goal");
    createdSessionId = started.session?.id;
    if (!createdSessionId || started.status !== "SESSION_CREATED") {
      throw new Error(`Unexpected start result: ${JSON.stringify(started)}`);
    }

    const run = parseJsonToolResult(await withTimeout(
      client.callTool({ name: "agent_run_goal", arguments: { sessionId: createdSessionId, executionMode: "dry_run", maxSteps: 1, port: 65535 } }),
      requestTimeoutMs,
      "agent_run_goal",
    ), "agent_run_goal");
    if (!["NO_CLIENT", "NEEDS_CLIENT_SELECTION", "AUTONOMY_DRY_RUN_READY", "AUTONOMY_BLOCKED", "AUTONOMY_COMPLETED"].includes(run.status)) {
      throw new Error(`Unexpected run result: ${JSON.stringify(run)}`);
    }
    if (run.executed !== false) {
      throw new Error(`Dry-run autonomy must not execute: ${JSON.stringify(run)}`);
    }

    const stopped = parseJsonToolResult(await withTimeout(
      client.callTool({ name: "agent_stop", arguments: { sessionId: createdSessionId, reason: "phase 3 memory smoke complete" } }),
      requestTimeoutMs,
      "agent_stop",
    ), "agent_stop");
    if (stopped.status !== "SESSION_STOPPED") {
      throw new Error(`Unexpected stop result: ${JSON.stringify(stopped)}`);
    }

    const observation = parseJsonToolResult(await withTimeout(
      client.callTool({ name: "memory_record_observation", arguments: { sessionId: createdSessionId, note: "phase 3 profile observation", observation: { smoke: true } } }),
      requestTimeoutMs,
      "memory_record_observation",
    ), "memory_record_observation");
    if (observation.status !== "OBSERVATION_RECORDED") {
      throw new Error(`Unexpected observation result: ${JSON.stringify(observation)}`);
    }

    const action = parseJsonToolResult(await withTimeout(
      client.callTool({ name: "memory_record_action", arguments: { sessionId: createdSessionId, action: { tool: "smoke-agent-memory", target: "dragon" }, result: { ok: false, status: "blocked_without_antifire" }, lesson: "Need anti-fire potion before fighting dragons; avoid repeating unsafe dragon combat." } }),
      requestTimeoutMs,
      "memory_record_action",
    ), "memory_record_action");
    if (action.status !== "ACTION_RECORDED") {
      throw new Error(`Unexpected action result: ${JSON.stringify(action)}`);
    }

    const profile = parseJsonToolResult(await withTimeout(
      client.callTool({ name: "memory_get_profile", arguments: { forceRefresh: false } }),
      requestTimeoutMs,
      "memory_get_profile",
    ), "memory_get_profile");
    if (!["PROFILE_FOUND", "NO_PROFILE"].includes(profile.status)) {
      throw new Error(`Unexpected profile result: ${JSON.stringify(profile)}`);
    }

    const memory = parseJsonToolResult(await withTimeout(
      client.callTool({ name: "agent_memory_status", arguments: {} }),
      requestTimeoutMs,
      "agent_memory_status",
    ), "agent_memory_status");
    if (memory.status !== "READY" || memory.sessionCount < 1 || memory.eventCount < 2 || memory.journalCount < 2) {
      throw new Error(`Unexpected first memory status: ${JSON.stringify(memory)}`);
    }

    const lessons = parseJsonToolResult(await withTimeout(
      client.callTool({ name: "memory_search_lessons", arguments: { query: "fight dragon safely", onlyFailures: true, limit: 5 } }),
      requestTimeoutMs,
      "memory_search_lessons",
    ), "memory_search_lessons");
    if (lessons.status !== "MEMORY_LESSONS" || !lessons.lessons?.some((entry) => String(entry.data?.lesson ?? "").includes("anti-fire"))) {
      throw new Error(`Expected anti-fire lesson retrieval: ${JSON.stringify(lessons)}`);
    }

    const cached = parseJsonToolResult(await withTimeout(
      client.callTool({
        name: "strategy_cache_put",
        arguments: {
          goal,
          method: "smoke",
          source: "smoke-agent-memory",
          policy: {
            kind: "osrs.strategist_policy.v1",
            system1Policy: { task: "smoke", executionMode: "dry_run" },
          },
          contextSummary: { smoke: true },
        },
      }),
      requestTimeoutMs,
      "strategy_cache_put",
    ), "strategy_cache_put");
    if (cached.status !== "STRATEGY_CACHED" || !cached.entry?.key) {
      throw new Error(`Unexpected strategy cache put result: ${JSON.stringify(cached)}`);
    }
    const memoryAfterCache = parseJsonToolResult(await withTimeout(
      client.callTool({ name: "agent_memory_status", arguments: {} }),
      requestTimeoutMs,
      "agent_memory_status after strategy cache",
    ), "agent_memory_status after strategy cache");
    return { ...memoryAfterCache, cachedStrategyKey: cached.entry.key };
  });

  const second = await withClient(async (client, pid) => {
    secondPid = pid;
    const status = parseJsonToolResult(await withTimeout(
      client.callTool({ name: "agent_status", arguments: { sessionId: createdSessionId } }),
      requestTimeoutMs,
      "agent_status after restart",
    ), "agent_status after restart");
    if (status.status !== "SESSION_FOUND" || status.session?.id !== createdSessionId) {
      throw new Error(`Persisted session was not restored: ${JSON.stringify(status)}`);
    }

    const sessions = parseJsonToolResult(await withTimeout(
      client.callTool({ name: "agent_memory_sessions", arguments: { goalContains: goal, limit: 5 } }),
      requestTimeoutMs,
      "agent_memory_sessions",
    ), "agent_memory_sessions");
    if (!sessions.sessions?.some((session) => session.id === createdSessionId)) {
      throw new Error(`Persisted session was not listed: ${JSON.stringify(sessions)}`);
    }

    const history = parseJsonToolResult(await withTimeout(
      client.callTool({ name: "agent_history", arguments: { sessionId: createdSessionId, limit: 20 } }),
      requestTimeoutMs,
      "agent_history after restart",
    ), "agent_history after restart");
    if (!history.events?.some((event) => event.persisted === true && event.type === "session_created")) {
      throw new Error(`Persisted events were not returned: ${JSON.stringify(history)}`);
    }

    const goalMemory = parseJsonToolResult(await withTimeout(
      client.callTool({ name: "memory_get_goal", arguments: { sessionId: createdSessionId, limit: 20 } }),
      requestTimeoutMs,
      "memory_get_goal after restart",
    ), "memory_get_goal after restart");
    if (!goalMemory.journal?.some((entry) => entry.kind === "action")) {
      throw new Error(`Persisted journal entries were not returned: ${JSON.stringify(goalMemory)}`);
    }

    const cacheHit = parseJsonToolResult(await withTimeout(
      client.callTool({ name: "strategy_cache_get", arguments: { goal, method: "smoke" } }),
      requestTimeoutMs,
      "strategy_cache_get after restart",
    ), "strategy_cache_get after restart");
    if (cacheHit.status !== "STRATEGY_CACHE_HIT" || cacheHit.entry?.goal !== goal) {
      throw new Error(`Persisted strategy cache was not returned: ${JSON.stringify(cacheHit)}`);
    }

    const outcome = parseJsonToolResult(await withTimeout(
      client.callTool({ name: "strategy_cache_record_outcome", arguments: { goal, method: "smoke", success: true, metadata: { smoke: "outcome" } } }),
      requestTimeoutMs,
      "strategy_cache_record_outcome",
    ), "strategy_cache_record_outcome");
    if (outcome.status !== "STRATEGY_CACHE_OUTCOME_RECORDED" || outcome.entry?.successCount < 1) {
      throw new Error(`Strategy cache outcome was not recorded: ${JSON.stringify(outcome)}`);
    }
    return { status, sessions, history, goalMemory };
  });

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    firstPid,
    secondPid,
    createdSessionId,
    firstMemoryStatus: first.status,
    firstSessionCount: first.sessionCount,
    firstEventCount: first.eventCount,
    firstJournalCount: first.journalCount,
    firstStrategyCacheCount: first.strategyCacheCount,
    cachedStrategyKey: first.cachedStrategyKey,
    restoredSessionStatus: second.status.session.status,
    restoredEventCount: second.history.events.length,
    restoredJournalCount: second.goalMemory.journal.length,
  }, null, 2));
} finally {
  await rm(dbPath, { force: true });
}
