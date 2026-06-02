#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { buildSemanticInterface, findSemanticControls, planQuestStep } from "../build/semantic-interface.js";
import { getKnowledgeRecord } from "../build/knowledge-base.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

const syntheticSnapshot = {
  state: { status: "LOGGED_IN", name: "tester", location: { x: 3200, y: 3200, plane: 0 } },
  dialogue: {
    type: "OPTIONS",
    text: "What would you like to say?",
    options: [
      { text: "Can you help me?", screenX: 100, screenY: 200 },
      { text: "No thanks.", screenX: 100, screenY: 230 },
    ],
  },
  interfaceSummary: { dialogueType: "OPTIONS", contextMenuOpen: false, bankContainerAvailable: false },
  inventory: [
    { id: 1944, name: "Egg", slot: 0, slotScreenX: 600, slotScreenY: 700 },
    { id: 1927, name: "Bucket of milk", slot: 1, slotScreenX: 640, slotScreenY: 700 },
  ],
};

const widgets = [
  { packedId: 123, text: "Click here to continue", actions: ["Continue"], screenX: 400, screenY: 500 },
  { packedId: 456, name: "Quest Journal", text: "Cook's Assistant", actions: ["Select"], screenX: 420, screenY: 520 },
  { packedId: 789, name: "Bank item", text: "Logs", actions: ["Deposit-All"], screenX: 450, screenY: 550 },
];

const semantic = buildSemanticInterface(syntheticSnapshot, widgets);
assert(semantic.status === "READY", "semantic interface should be ready");
assert(semantic.groups.dialogue_option === 2, "should classify two dialogue options");
assert(semantic.groups.inventory_item === 2, "should classify two inventory items");
assert(semantic.groups.quest_widget >= 1, "should classify quest widget");
assert(findSemanticControls(semantic, { type: "bank_action", text: "Logs" }).length === 1, "should find bank Logs control");

const cookPlan = planQuestStep({
  questName: "Cook's Assistant",
  snapshot: syntheticSnapshot,
  semanticInterface: semantic,
  questKnowledge: getKnowledgeRecord("quest", "Cook's Assistant"),
});
assert(cookPlan.status === "QUEST_STEP_READY", "open dialogue should be the next quest step");
assert(cookPlan.selectedStep?.tool === "handle_dialogue", "quest plan should route dialogue through handle_dialogue");

const noDialogueSnapshot = {
  ...syntheticSnapshot,
  dialogue: { type: "NONE", options: [] },
  interfaceSummary: { dialogueType: "NONE", contextMenuOpen: false, bankContainerAvailable: false },
};
const noDialogueSemantic = buildSemanticInterface(noDialogueSnapshot, []);
const missingItemsPlan = planQuestStep({
  questName: "Cook's Assistant",
  snapshot: noDialogueSnapshot,
  semanticInterface: noDialogueSemantic,
  questKnowledge: getKnowledgeRecord("quest", "Cook's Assistant"),
});
assert(missingItemsPlan.status === "QUEST_NEEDS_ITEMS", "Cook's Assistant should detect missing flour");
assert(missingItemsPlan.missingItems.includes("Pot of flour"), "missing item list should include flour");

const serverPath = fileURLToPath(new URL("../build/index.js", import.meta.url));
const serverCwd = fileURLToPath(new URL("..", import.meta.url));
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

const client = new Client({ name: "osrs-semantic-smoke", version: "1.0.0" });
let mcpToolCount;
let mcpResourceCount;
try {
  await withTimeout(client.connect(transport), 10000, "MCP connect");
  const tools = await withTimeout(client.listTools(), 10000, "listTools");
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  for (const name of ["get_semantic_interface", "semantic_find_control", "semantic_invoke_control", "quest_plan_next_step", "complete_quest"]) {
    assert(toolNames.has(name), `missing tool ${name}`);
  }
  const resources = await withTimeout(client.listResources(), 10000, "listResources");
  assert(resources.resources.some((resource) => resource.uri === "osrs://semantic/interface"), "missing semantic resource");
  mcpToolCount = tools.tools.length;
  mcpResourceCount = resources.resources.length;

} finally {
  await client.close();
}

console.log(JSON.stringify({
  ok: true,
  syntheticControlGroups: semantic.groups,
  cookPlanStatus: cookPlan.status,
  missingItems: missingItemsPlan.missingItems,
  mcpToolCount,
  mcpResourceCount,
}, null, 2));
