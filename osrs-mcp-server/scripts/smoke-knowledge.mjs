#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../build/index.js", import.meta.url));
const serverCwd = fileURLToPath(new URL("..", import.meta.url));
const requestTimeoutMs = 10000;

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

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: serverCwd,
  stderr: "pipe",
  env: {
    ...process.env,
    OSRS_API_TIMEOUT_MS: "300",
    OSRS_SNAPSHOT_CACHE_TTL_MS: "0",
  },
});

const client = new Client({ name: "osrs-knowledge-smoke", version: "1.0.0" });
let report;
try {
  await withTimeout(client.connect(transport), requestTimeoutMs, "MCP connect");

  const resources = await withTimeout(client.listResources(), requestTimeoutMs, "listResources");
  if (!resources.resources.some((resource) => resource.uri === "osrs://knowledge/index")) {
    throw new Error("Missing osrs://knowledge/index resource");
  }

  const query = parseJsonToolResult(await withTimeout(
    client.callTool({ name: "knowledge_query", arguments: { query: "50 Magic", limit: 5 } }),
    requestTimeoutMs,
    "knowledge_query",
  ), "knowledge_query");
  if (query.status !== "KNOWLEDGE_RESULTS" || !query.results?.some((result) => result.kind === "method" && String(result.id).includes("magic"))) {
    throw new Error(`knowledge_query did not return Magic method knowledge: ${JSON.stringify(query)}`);
  }

  const method = parseJsonToolResult(await withTimeout(
    client.callTool({ name: "knowledge_get_method", arguments: { skill: "magic", targetLevel: 50, currentLevel: 1, preference: "safe" } }),
    requestTimeoutMs,
    "knowledge_get_method",
  ), "knowledge_get_method");
  if (method.status !== "METHOD_FOUND" || !method.result?.dependencyTree?.length || !method.result?.milestones?.some((step) => step.methodId === "magic.fire_strike_f2p")) {
    throw new Error(`knowledge_get_method missing Magic dependency tree: ${JSON.stringify(method)}`);
  }

  const location = parseJsonToolResult(await withTimeout(
    client.callTool({ name: "knowledge_get_location", arguments: { idOrName: "lumbridge_cows" } }),
    requestTimeoutMs,
    "knowledge_get_location",
  ), "knowledge_get_location");
  if (location.status !== "LOCATION_FOUND" || !location.location?.contains?.includes("Cow")) {
    throw new Error(`knowledge_get_location failed: ${JSON.stringify(location)}`);
  }

  const quest = parseJsonToolResult(await withTimeout(
    client.callTool({ name: "knowledge_get_quest", arguments: { idOrName: "Cook's Assistant" } }),
    requestTimeoutMs,
    "knowledge_get_quest",
  ), "knowledge_get_quest");
  if (quest.status !== "QUEST_FOUND" || !quest.quest?.steps?.length) {
    throw new Error(`knowledge_get_quest failed: ${JSON.stringify(quest)}`);
  }

  const monster = parseJsonToolResult(await withTimeout(
    client.callTool({ name: "knowledge_get_monster", arguments: { idOrName: "cow" } }),
    requestTimeoutMs,
    "knowledge_get_monster",
  ), "knowledge_get_monster");
  if (monster.status !== "MONSTER_FOUND" || !monster.monster?.usefulDrops?.includes("Cowhide")) {
    throw new Error(`knowledge_get_monster failed: ${JSON.stringify(monster)}`);
  }

  const gear = parseJsonToolResult(await withTimeout(
    client.callTool({ name: "knowledge_get_gear", arguments: { idOrName: "starter_magic_f2p" } }),
    requestTimeoutMs,
    "knowledge_get_gear",
  ), "knowledge_get_gear");
  if (gear.status !== "GEAR_FOUND" || !gear.gear?.items?.includes("Mind rune")) {
    throw new Error(`knowledge_get_gear failed: ${JSON.stringify(gear)}`);
  }

  report = {
    ok: true,
    queryResultCount: query.results.length,
    magicMethod: method.result.method.id,
    magicMilestoneCount: method.result.milestones.length,
    location: location.location.id,
    quest: quest.quest.id,
    monster: monster.monster.id,
    gear: gear.gear.id,
  };
} finally {
  await client.close();
}

console.log(JSON.stringify(report, null, 2));
