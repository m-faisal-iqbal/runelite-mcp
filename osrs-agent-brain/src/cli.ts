import readline from "node:readline";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { BrainConfig } from "./config.js";
import { getBrainConfig, readEnvVar, repoRoot } from "./config.js";
import {
  QWEN_BRAIN_EXECUTE_CONFIRMATIONS,
  QWEN_BRAIN_FUNCTION_TOOLS,
  parseStrategistPolicyText,
} from "./brain.js";
import { connectToSystem1 } from "./mcp-client.js";
import { assertStrategistPolicySafe, STRATEGIST_POLICY_JSON_SCHEMA, type StrategistPolicy } from "./policy-schema.js";
import { createQwenClient, qwenErrorMessage } from "./qwen-client.js";
import { STRATEGIST_SYSTEM_PROMPT } from "./system-prompt.js";
import { searchOsrsWiki } from "./wiki-search.js";

type BrainToolResult = {
  status: string;
  [key: string]: unknown;
};

type LocalPolicyStage = {
  label: string;
  policy: Record<string, unknown>;
};

type LocalExecutionPlan = {
  status: "LOCAL_PLAN_READY" | "LOCAL_PLAN_BLOCKED";
  reason: string;
  policies: LocalPolicyStage[];
  warnings: string[];
  blocker?: string;
};

type WorldGraphNode = {
  id: string;
  name: string;
  worldX: number;
  worldY: number;
  plane?: number;
  tags?: string[];
};

type ResponseFunctionCall = {
  type: string;
  name: string;
  call_id: string;
  arguments?: unknown;
};

const READ_ONLY_MCP_TOOLS = new Set([
  "get_agent_context",
  "knowledge_query",
  "knowledge_get_method",
  "memory_get_profile",
  "memory_search_lessons",
  "perceive_minimap",
  "perceive_chat",
  "perceive_ui_region",
]);

const MUTATING_POLICY_TOOLS = new Set(["load_policy"]);

const FINAL_JSON_ONLY_INSTRUCTION = [
  "Final response format is mandatory:",
  "Return exactly one JSON object matching the strategist policy schema.",
  "Do not use Markdown.",
  "Do not explain the policy in prose.",
  "Do not say that the policy was loaded or staged unless that fact appears inside notesForSystem1.",
  "The JSON object must include kind, policyId, objective, horizon, executionMode, priority, assumptions, requiredObservations, allowedSystem1Capabilities, forbiddenCapabilities, safetyConstraints, stopConditions, successCriteria, system1Policy, steps, and notesForSystem1.",
].join("\n");

const EXECUTE_HANDOFF_INSTRUCTION = [
  "Interactive CLI execution is ARMED for the RuneLite MCP plugin.",
  "Your final action MUST be a load_policy function tool call with executionMode \"execute\" and start true.",
  "Do NOT finish with JSON text only — JSON-only answers are incomplete in execute mode.",
  "The CLI will auto-load valid JSON if you forget, but prefer calling load_policy directly.",
  "Put the concrete Reflex Engine payload in load_policy.policy: task, itemName, quantity, method, destination, inventoryFullBehavior, etc.",
  "Use executionMode \"execute\" on both load_policy and system1Policy.",
].join("\n");

const PROMPT = "OSRS Brain> ";

const EXECUTE_AUTHORIZATION = [
  "Live execution is AUTHORIZED by the user through the interactive CLI.",
  "System 1 (RuneLite MCP plugin / Reflex Engine) will perform in-client RuneLite menu actions.",
  "After planning, call load_policy with executionMode \"execute\", start true, and a concrete system1Policy.",
  "Set system1Policy.executionMode to \"execute\".",
  "Do not stop at dry_run for the final handoff.",
].join(" ");

type CliOptions = {
  live: boolean;
  execute: boolean;
  maxToolRounds: number;
  target: {
    port?: number;
    instanceId?: string;
    playerName?: string;
  };
};

function printBanner(config: BrainConfig, options: CliOptions, resolvedTarget?: Record<string, unknown>): void {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║           OSRS Twin-Brain — System 2 Strategist          ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  Qwen:   ${config.qwenApiKey ? `${config.qwenModel} (QWEN_API_KEY from Windows env)` : "NOT CONFIGURED — add QWEN_API_KEY to Windows Environment Variables"}`);
  console.log(`  Wiki:   ${config.tavilyApiKey ? "Tavily ready (TAVILY_API_KEY from Windows env)" : "optional — add TAVILY_API_KEY to Windows Environment Variables for wiki search"}`);
  console.log(`  MCP:    ${config.mcpServerPath}`);
  console.log(`  Mode:   ${options.live ? "live RuneLite plugin" : "offline simulation"} · ${options.execute ? "execute (menu actions armed)" : "plan only (no in-game actions)"}`);
  if (resolvedTarget?.port) {
    console.log(`  Client: RuneLite plugin on port ${resolvedTarget.port}`);
  } else if (options.live) {
    console.log("  Client: auto-detect first RuneLite plugin (8080–8090), or pass --port");
  }
  console.log("");
  console.log("Type a high-level goal, or 'exit' to quit.");
  console.log("");
}

function formatArgs(args: Record<string, unknown>, keys: string[]): string {
  const compact: Record<string, unknown> = {};
  for (const key of keys) {
    if (args[key] !== undefined) {
      compact[key] = args[key];
    }
  }
  if (Object.keys(compact).length === 0) {
    return JSON.stringify(args);
  }
  const inner = Object.entries(compact)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(", ");
  return `{${inner}}`;
}

function summarizeLoadPolicyArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args);
}

function printBrainAction(name: string, args: Record<string, unknown>): void {
  switch (name) {
    case "knowledge_query":
      console.log(`[Brain] Querying Grimoire: knowledge_query(${formatArgs(args, ["query", "limit"])})`);
      return;
    case "knowledge_get_method":
      console.log(`[Brain] Querying Grimoire: knowledge_get_method(${formatArgs(args, ["activity", "currentLevel"])})`);
      return;
    case "memory_search_lessons":
      console.log(`[Brain] Querying Grimoire: memory_search_lessons(${formatArgs(args, ["query", "onlyFailures", "limit"])})`);
      return;
    case "memory_get_profile":
      console.log(`[Brain] Querying Grimoire: memory_get_profile(${formatArgs(args, ["forceRefresh"])})`);
      return;
    case "search_osrs_wiki":
      console.log(`[Brain] Searching Wiki: search_osrs_wiki(${formatArgs(args, ["query", "maxResults"])})`);
      return;
    case "navigate_to":
      console.log(`[Brain] Routing: navigate_to(${formatArgs(args, ["destination", "executionMode"])})`);
      return;
    case "get_agent_context":
      console.log(`[Brain] Observing: get_agent_context(${formatArgs(args, ["objective"])})`);
      return;
    case "perceive_minimap":
      console.log(`[Brain] Observing: perceive_minimap(${formatArgs(args, ["maxEntities"])})`);
      return;
    case "perceive_chat":
      console.log(`[Brain] Observing: perceive_chat(${formatArgs(args, ["limit"])})`);
      return;
    case "perceive_ui_region":
      console.log(`[Brain] Observing: perceive_ui_region(${formatArgs(args, ["region", "includeText"])})`);
      return;
    case "load_policy":
      console.log(`[Brain] Handoff: load_policy(${summarizeLoadPolicyArgs(args)})`);
      return;
    default:
      console.log(`[Brain] Tool: ${name}(${JSON.stringify(args)})`);
  }
}

function isBlockedToolResult(result: BrainToolResult): boolean {
  if (result.status === "TOOL_BLOCKED"
    || result.status === "EXECUTION_BLOCKED"
    || result.status === "POLICY_BLOCKED") {
    return true;
  }

  if (result.status === "MCP_TOOL_RESULT") {
    const nested = parseMcpToolJson(result.result);
    const status = String(nested?.status ?? "");
    return status === "POLICY_REJECTED"
      || status === "POLICY_NOT_ARMED"
      || status === "EXECUTION_BLOCKED";
  }

  return false;
}

function isPolicyHandoffSuccess(result: BrainToolResult): boolean {
  if (result.status !== "MCP_TOOL_RESULT") {
    return false;
  }
  const nested = parseMcpToolJson(result.result);
  return nested?.status === "POLICY_LOADED" && nested?.willExecute === true;
}

function formatMcpToolFailure(result: BrainToolResult): string {
  if (result.stopReason) {
    return String(result.stopReason);
  }
  const nested = parseMcpToolJson(result.result);
  if (nested?.reason) {
    return String(nested.reason);
  }
  if (nested?.status) {
    return String(nested.status);
  }
  return JSON.stringify(result).slice(0, 500);
}

function buildStrategistInstructions(execute: boolean): string {
  const tail = execute ? EXECUTE_HANDOFF_INSTRUCTION : FINAL_JSON_ONLY_INSTRUCTION;
  return `${STRATEGIST_SYSTEM_PROMPT}\n\n${tail}`;
}

function inferWoodcutQuantity(text: string): number {
  if (/\btwo\b[\s\S]{0,40}\binventor/i.test(text) || /\b2\b[\s\S]{0,40}\binventor/i.test(text)) {
    return 56;
  }
  if (/\bfull\b[\s\S]{0,20}\binventor/i.test(text)) {
    return 28;
  }
  const match = text.match(/\b(\d{1,4})\b/);
  return match ? Number(match[1]) : 28;
}

function extractDestination(text: string): string | undefined {
  if (/edgeville|edvillage|edville/.test(text)) {
    return "Edgeville";
  }
  if (/draynor/.test(text)) {
    return "Draynor Village";
  }
  if (/lumbridge/.test(text)) {
    return "Lumbridge";
  }
  if (/varrock/.test(text)) {
    return "Varrock";
  }
  const match = text.match(/\b(?:go to|travel to|navigate to|walk to)\s+([a-z][a-z\s'-]{2,40})/i);
  return match?.[1]?.trim();
}

// Fields that belong to the Strategist wrapper and must NEVER be forwarded to System 1
const STRATEGIST_ONLY_FIELDS = new Set([
  "kind", "policyId", "horizon", "priority", "assumptions", "requiredObservations",
  "allowedSystem1Capabilities", "forbiddenCapabilities", "safetyConstraints",
  "stopConditions", "successCriteria", "notesForSystem1",
  // steps is intentionally stripped — the LLM puts garbage tool names like "travel"
  // in steps[].preferredSystem1Capability; the ReflexEngine heuristics handle routing
  "steps",
]);

function cleanSystem1Raw(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!STRATEGIST_ONLY_FIELDS.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

function prepareSystem1Payload(policy: StrategistPolicy, goal: string): Record<string, unknown> {
  // Start from the LLM's system1Policy, stripping all strategist-only fields
  const raw = cleanSystem1Raw({ ...(policy.system1Policy ?? {}) });

  // Also try to pull destination from LLM steps[0].inputs if missing
  const stepsDestination = (() => {
    const firstStep = (policy.steps ?? [])[0] as Record<string, unknown> | undefined;
    return String(firstStep?.inputs && typeof firstStep.inputs === "object"
      ? (firstStep.inputs as Record<string, unknown>).destination ?? ""
      : "").trim() || undefined;
  })();

  // Normalize task: the LLM often writes "travel" instead of what ReflexEngine needs
  const rawTask = String(raw.task ?? "").toLowerCase().trim();
  const isExplicitTravel = rawTask === "travel" || rawTask === "navigate" || rawTask === "go_to" || rawTask === "walk";
  const effectiveTask = isExplicitTravel ? "travel" : (raw.task as string | undefined);

  // Do not override Qwen's explicit task if it provided one (and it's not a bad alias)
  if (effectiveTask && effectiveTask !== "strategy_only") {
    const base: Record<string, unknown> = {
      ...raw,
      task: effectiveTask,
      objective: raw.objective ?? policy.objective,
      executionMode: "execute" as const,
      tickMs: Number(raw.tickMs ?? 600),
      maxTicks: Number(raw.maxTicks ?? 600),
    };
    // Ensure destination is present for travel tasks
    if (effectiveTask === "travel" && !base.destination) {
      base.destination = stepsDestination ?? extractDestination(`${goal} ${policy.objective}`) ?? "Edgeville";
    }
    return base;
  }

  // Fallback heuristics when Qwen failed to provide a concrete task
  const corpus = `${goal} ${policy.objective} ${JSON.stringify(raw)}`.toLowerCase();
  const wantsWoodcut = /willow|woodcut|\bchop\b|\blogs?\b|\btree/.test(corpus);
  const wantsTravel = /travel|\bgo to\b|navigate|walk to|edgeville|edvillage/.test(corpus);
  const wantsBank = /bank/.test(corpus);

  if (wantsWoodcut) {
    const itemName = /willow/.test(corpus) ? "Willow logs" : String(raw.itemName ?? "Logs");
    return {
      ...raw,
      task: "chop_logs",
      objective: policy.objective,
      itemName,
      method: "woodcutting",
      quantity: Number(raw.quantity ?? inferWoodcutQuantity(corpus)),
      quantityMode: raw.quantityMode ?? "gain",
      inventoryFullBehavior: wantsBank ? "bank" : (raw.inventoryFullBehavior ?? "stop"),
      bankItemName: wantsBank ? itemName : raw.bankItemName,
      eatAtHpPercent: Number(raw.eatAtHpPercent ?? 35),
      tickMs: Number(raw.tickMs ?? 600),
      maxTicks: Number(raw.maxTicks ?? 600),
      executionMode: "execute",
    };
  }

  if (wantsTravel) {
    return {
      ...raw,
      task: "travel",
      objective: policy.objective,
      destination: String(raw.destination ?? stepsDestination ?? extractDestination(corpus) ?? "Edgeville"),
      tickMs: Number(raw.tickMs ?? 600),
      maxTicks: Number(raw.maxTicks ?? 600),
      executionMode: "execute",
    };
  }

  return {
    ...raw,
    task: "strategy_only",
    objective: raw.objective ?? policy.objective,
    executionMode: "execute",
    tickMs: Number(raw.tickMs ?? 600),
    maxTicks: Number(raw.maxTicks ?? 600),
  };
}

function printSystem1Takeover(loadResult?: unknown, enableLogs?: () => void): void {
  console.log("");
  console.log("🚀 [SYSTEM 1 TAKEOVER] Policy loaded. Reflex Engine is now executing locally. Brain going to sleep.");
  const summary = summarizeLoadResult(loadResult);
  if (summary) {
    console.log(`[System 1] ${summary}`);
  }
  console.log("");
  if (enableLogs) {
    enableLogs();
  }
}

function summarizeLoadResult(loadResult: unknown): string | undefined {
  if (!loadResult || typeof loadResult !== "object") {
    return undefined;
  }
  const record = loadResult as Record<string, unknown>;
  const nested = record.result && typeof record.result === "object"
    ? record.result as Record<string, unknown>
    : record;
  const status = String(nested.status ?? record.status ?? "");
  const task = nested.policyPreview && typeof nested.policyPreview === "object"
    ? (nested.policyPreview as Record<string, unknown>).task
    : undefined;
  const parts = [status, task ? `task=${String(task)}` : undefined].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function armExecuteArgs(name: string, args: Record<string, unknown>, execute: boolean): Record<string, unknown> {
  if (!execute) {
    return args;
  }

  const armed = { ...args };
  if (name === "load_policy") {
    armed.executionMode = "execute";
    armed.start = armed.start ?? true;
    armed.confirmExecution = QWEN_BRAIN_EXECUTE_CONFIRMATIONS.load_policy;
    if (armed.policy && typeof armed.policy === "object" && !Array.isArray(armed.policy)) {
      const policy = armed.policy as Record<string, unknown>;
      const inner = policy.system1Policy && typeof policy.system1Policy === "object"
        ? policy.system1Policy as Record<string, unknown>
        : policy;
      inner.executionMode = "execute";
    }
  }

  if (name === "navigate_to" && (armed.executionMode === "execute" || armed.executionMode === undefined)) {
    armed.executionMode = "execute";
    armed.confirmExecution = QWEN_BRAIN_EXECUTE_CONFIRMATIONS.navigate_to;
  }

  return armed;
}

function buildGoalInstruction(execute: boolean): string {
  const base = "Use function tools for compact context/knowledge, then hand off to System 1 via load_policy. Do not request or emit raw clicks, invokes, keyboard, or mouse actions.";
  return execute ? `${base} ${EXECUTE_AUTHORIZATION}` : base;
}

function normalizeGoalText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bedgvillage\b/g, "edgeville")
    .replace(/\bedgville\b/g, "edgeville")
    .replace(/\bedville\b/g, "edgeville")
    .replace(/\bvarrok\b/g, "varrock")
    .replace(/\binventories\b/g, "inventory");
}

function firstGoalNumber(text: string): number | undefined {
  const wordNumbers: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  for (const [word, value] of Object.entries(wordNumbers)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) {
      return value;
    }
  }
  const match = text.match(/\b(\d{1,4})\b/);
  return match ? Number(match[1]) : undefined;
}

function loadWorldGraphNodes(): WorldGraphNode[] {
  const graphPath = `${repoRoot}\\osrs-mcp-server\\src\\world_graph.json`;
  const graph = JSON.parse(readFileSync(graphPath, "utf8")) as { nodes?: WorldGraphNode[] };
  return graph.nodes ?? [];
}

function findWorldNode(nameOrTag: string): WorldGraphNode | undefined {
  const needle = normalizeGoalText(nameOrTag).replace(/[_-]+/g, " ").trim();
  if (!needle) {
    return undefined;
  }
  return loadWorldGraphNodes().find((node) => {
    const names = [node.id, node.name, ...(node.tags ?? [])]
      .map((value) => normalizeGoalText(String(value)).replace(/[_-]+/g, " ").trim());
    return names.includes(needle) || names.some((value) => value.includes(needle));
  });
}

function nodeDestinationFields(node: WorldGraphNode | undefined): Record<string, unknown> {
  if (!node) {
    return {};
  }
  return {
    destination: node.name,
    destinationWorldX: node.worldX,
    destinationWorldY: node.worldY,
    destinationPlane: node.plane ?? 0,
    destinationRadius: 3,
  };
}

function inferTravelDestination(goal: string): WorldGraphNode | undefined {
  const text = normalizeGoalText(goal);
  if (/\b(edgeville|willow)\b/.test(text) && /\bwillow/.test(text)) {
    return findWorldNode("edgeville willows") ?? findWorldNode("draynor willows");
  }
  if (/\bdraynor\b/.test(text) && /\bwillow/.test(text)) {
    return findWorldNode("draynor willows");
  }
  if (/\bvarrock\b/.test(text) && /\b(tree|oak|woodcut|chop|log)\b/.test(text)) {
    return findWorldNode("varrock west trees");
  }
  if (/\bedgeville\b/.test(text)) {
    return findWorldNode("edgeville bank");
  }
  if (/\bvarrock\b/.test(text)) {
    return findWorldNode("varrock center");
  }
  if (/\bdraynor\b/.test(text)) {
    return findWorldNode("draynor village");
  }
  if (/\blumbridge\b/.test(text) && /\bbank\b/.test(text)) {
    return findWorldNode("lumbridge castle bank");
  }
  if (/\blumbridge\b/.test(text)) {
    return findWorldNode("lumbridge castle");
  }
  const match = text.match(/\b(?:go to|go|travel to|travel|navigate to|walk to)\s+([a-z][a-z\s'-]{2,40})/i);
  return match ? findWorldNode(match[1]) : undefined;
}

function inferBankForNode(node: WorldGraphNode | undefined): WorldGraphNode | undefined {
  const key = normalizeGoalText(`${node?.name ?? ""} ${(node?.tags ?? []).join(" ")}`);
  if (key.includes("edgeville")) {
    return findWorldNode("edgeville bank");
  }
  if (key.includes("draynor")) {
    return findWorldNode("draynor bank");
  }
  if (key.includes("varrock")) {
    return findWorldNode("varrock west bank");
  }
  if (key.includes("lumbridge")) {
    return findWorldNode("lumbridge castle bank");
  }
  return undefined;
}

function inferWoodcutSpec(goal: string) {
  const text = normalizeGoalText(goal);
  if (!/\b(cut|chop|woodcut|tree|log|logs|willow|oak|yew)\b/.test(text)) {
    return undefined;
  }
  if (text.includes("willow")) {
    return { itemName: "Willow logs", targetName: "Willow", location: inferTravelDestination(`${goal} willow`) ?? findWorldNode("draynor willows") };
  }
  if (text.includes("oak")) {
    return { itemName: "Oak logs", targetName: "Oak", location: inferTravelDestination(goal) ?? findWorldNode("varrock west trees") };
  }
  if (text.includes("yew")) {
    return { itemName: "Yew logs", targetName: "Yew", location: inferTravelDestination(goal) ?? findWorldNode("edgeville yews") };
  }
  return { itemName: "Logs", targetName: "Tree", location: inferTravelDestination(goal) ?? findWorldNode("lumbridge trees") };
}

function inventorySlotsFromContext(context: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const candidates = [
    context?.inventory,
    (context?.player as Record<string, unknown> | undefined)?.inventory,
    (context?.snapshot as Record<string, unknown> | undefined)?.inventory,
    (context?.raw as Record<string, unknown> | undefined)?.inventory,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function isKeptToolItem(item: Record<string, unknown>, keepText: string): boolean {
  const name = String(item.name ?? "").toLowerCase();
  if (keepText.includes("axe") && name.includes("axe")) {
    return true;
  }
  if (keepText.includes("pickaxe") && name.includes("pickaxe")) {
    return true;
  }
  return false;
}

async function buildDepositExceptPolicy(
  goal: string,
  client: Client,
  target: Record<string, unknown>,
  keepText: string,
): Promise<LocalPolicyStage | undefined> {
  const context = await callJsonTool(client, "get_agent_context", {
    ...target,
    objective: goal,
    includeDiagnostics: false,
    includeInventoryLimit: 28,
    forceRefresh: true,
  });
  const inventory = inventorySlotsFromContext(context);
  const depositItems = inventory
    .filter((item) => !isKeptToolItem(item, keepText))
    .map((item) => String(item.name ?? "").trim())
    .filter(Boolean);
  const uniqueNames = [...new Set(depositItems)];
  if (uniqueNames.length === 0) {
    return undefined;
  }

  return {
    label: `Deposit current inventory except ${keepText}`,
    policy: {
      task: "deposit_inventory_except",
      objective: goal,
      executionMode: "execute",
      tickMs: 600,
      maxTicks: uniqueNames.length + 4,
      steps: [
        {
          tool: "interact_with",
          reason: "Open the nearest bank before depositing non-kept inventory items.",
          arguments: {
            entityType: "npc",
            name: "Banker",
            option: "Bank",
            nearestToPlayer: true,
          },
        },
        ...uniqueNames.map((itemName) => ({
          tool: "deposit_inventory_item",
          reason: `Deposit ${itemName}; kept tool items remain in inventory.`,
          arguments: {
            itemName,
            quantity: "All",
          },
        })),
      ],
    },
  };
}

async function buildLocalExecutionPlan(
  goal: string,
  client: Client,
  target: Record<string, unknown>,
  options: CliOptions,
): Promise<LocalExecutionPlan | undefined> {
  const text = normalizeGoalText(goal);
  const policies: LocalPolicyStage[] = [];
  const warnings: string[] = [];
  const wantsTravel = /\b(go|travel|navigate|walk)\b/.test(text);
  const woodcut = inferWoodcutSpec(goal);
  const wantsBank = /\bbank\b/.test(text);
  const wantsPreBank = /\b(before starting|first|start)\b[\s\S]{0,80}\b(bank|deposit|put everything|empty inventory)\b/.test(text)
    || /\bput everything\b[\s\S]{0,80}\bbank\b/.test(text);
  const keepText = text.includes("axe") ? "axe" : text.includes("pickaxe") ? "pickaxe" : "";

  if (!wantsTravel && !woodcut && !wantsBank) {
    return undefined;
  }

  const resourceNode = woodcut?.location;
  const bankNode = inferBankForNode(resourceNode) ?? (wantsBank ? inferTravelDestination(`${goal} bank`) : undefined);
  const travelNode = woodcut ? resourceNode : inferTravelDestination(goal);

  if (wantsPreBank) {
    if (bankNode) {
      policies.push({
        label: `Travel to ${bankNode.name} for inventory preparation`,
        policy: {
          task: "travel",
          objective: goal,
          executionMode: "execute",
          tickMs: 600,
          maxTicks: 300,
          ...nodeDestinationFields(bankNode),
        },
      });
    }
    if (keepText) {
      const depositExcept = await buildDepositExceptPolicy(goal, client, target, keepText);
      if (depositExcept) {
        policies.push(depositExcept);
      } else {
        warnings.push(`No non-${keepText} inventory items were visible to deposit before starting.`);
      }
    } else {
      warnings.push("Inventory prep requested, but no kept item was recognized. Say 'keep axe' or 'keep pickaxe' for selective banking.");
    }
  }

  if (travelNode) {
    policies.push({
      label: `Travel to ${travelNode.name}`,
      policy: {
        task: "travel",
        objective: goal,
        executionMode: "execute",
        tickMs: 600,
        maxTicks: 600,
        ...nodeDestinationFields(travelNode),
      },
    });
  } else if (wantsTravel) {
    return {
      status: "LOCAL_PLAN_BLOCKED",
      reason: "local_fast_path",
      policies: [],
      warnings,
      blocker: "I could not resolve the requested destination in world_graph.json.",
    };
  }

  if (woodcut) {
    const inventoryRunsMatch = text.match(/\b(\d{1,2})\s*(?:full\s*)?inventory\b/);
    const wordInventoryRuns = /\btwo\s*(?:full\s*)?inventory\b/.test(text) ? 2 : undefined;
    const inventoryRuns = inventoryRunsMatch ? Number(inventoryRunsMatch[1]) : wordInventoryRuns;
    const shouldBankLogs = wantsBank || /\bput them\b[\s\S]{0,30}\bbank\b/.test(text);
    const perInventoryQuantity = keepText === "axe" ? 27 : 28;
    const quantity = inventoryRuns ? perInventoryQuantity : firstGoalNumber(text) ?? inferWoodcutQuantity(text);
    const runs = inventoryRuns ?? 1;

    for (let index = 0; index < runs; index += 1) {
      if (index > 0 && resourceNode) {
        policies.push({
          label: `Return to ${resourceNode.name} for inventory ${index + 1}`,
          policy: {
            task: "travel",
            objective: goal,
            executionMode: "execute",
            tickMs: 600,
            maxTicks: 600,
            ...nodeDestinationFields(resourceNode),
          },
        });
      }

      policies.push({
        label: inventoryRuns ? `Cut inventory ${index + 1}/${runs} of ${woodcut.itemName}` : `Cut ${quantity} ${woodcut.itemName}`,
        policy: {
          task: "chop_logs",
          objective: goal,
          itemName: woodcut.itemName,
          targetName: woodcut.targetName,
          actionOption: "Chop down",
          quantity,
          quantityMode: "gain",
          method: "woodcutting",
          inventoryFullBehavior: "stop",
          eatAtHpPercent: 35,
          executionMode: "execute",
          tickMs: 600,
          maxTicks: 900,
        },
      });

      if (shouldBankLogs) {
        if (!bankNode) {
          return {
            status: "LOCAL_PLAN_BLOCKED",
            reason: "local_fast_path",
            policies,
            warnings,
            blocker: "Banking was requested, but no nearby bank could be inferred for this resource location.",
          };
        }
        policies.push({
          label: `Travel to ${bankNode.name} to bank ${woodcut.itemName}`,
          policy: {
            task: "travel",
            objective: goal,
            executionMode: "execute",
            tickMs: 600,
            maxTicks: 600,
            ...nodeDestinationFields(bankNode),
          },
        });
        policies.push({
          label: `Deposit ${woodcut.itemName}`,
          policy: {
            task: "deposit_logs",
            objective: goal,
            itemName: woodcut.itemName,
            bankItemName: woodcut.itemName,
            bankQuantity: "All",
            bankAction: "deposit",
            executionMode: "execute",
            tickMs: 600,
            maxTicks: 20,
          },
        });
      }
    }
  }

  if (policies.length === 0) {
    return undefined;
  }

  return {
    status: "LOCAL_PLAN_READY",
    reason: "local_fast_path",
    policies,
    warnings,
  };
}

function parseMcpToolJson(result: unknown): Record<string, unknown> | undefined {
  const record = result as { content?: Array<{ type?: string; text?: string }> };
  const text = record?.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function resolveTargetClient(client: Client, target: CliOptions["target"], live: boolean): Promise<Record<string, unknown>> {
  const resolved: Record<string, unknown> = {};
  if (target.port !== undefined) {
    resolved.port = target.port;
  }
  if (target.instanceId) {
    resolved.instanceId = target.instanceId;
  }
  if (target.playerName) {
    resolved.playerName = target.playerName;
  }

  if (!live || resolved.port !== undefined) {
    return resolved;
  }

  try {
    const raw = await client.callTool({ name: "list_clients", arguments: {} });
    const payload = parseMcpToolJson(raw);
    const clients = Array.isArray(payload?.clients) ? payload.clients as Array<Record<string, unknown>> : [];
    if (clients.length === 1 && clients[0]?.port !== undefined) {
      resolved.port = clients[0].port;
      if (clients[0].instanceId) {
        resolved.instanceId = clients[0].instanceId;
      }
      if (clients[0].playerName) {
        resolved.playerName = clients[0].playerName;
      }
    } else if (clients.length > 1) {
      console.log("[Brain] Multiple RuneLite clients detected — pass --port, --instance-id, or --player-name");
      for (const entry of clients) {
        console.log(`  · port ${entry.port} · ${entry.playerName ?? "unknown"} · ${entry.instanceId ?? "no-id"}`);
      }
    }
  } catch {
    // Discovery is best-effort; MCP load_policy will surface connection errors.
  }

  return resolved;
}

async function createQwenResponse(qwen: ReturnType<typeof createQwenClient>, config: BrainConfig, payload: Record<string, unknown>) {
  try {
    return await (qwen as { responses: { create: (body: Record<string, unknown>) => Promise<unknown> } }).responses.create(payload);
  } catch (error) {
    throw new Error(qwenErrorMessage(error, config));
  }
}

function responseFunctionCalls(response: unknown): ResponseFunctionCall[] {
  const output = Array.isArray((response as { output?: unknown[] })?.output) ? (response as { output: unknown[] }).output : [];
  return output.filter((item) => {
    const call = item as ResponseFunctionCall;
    return call?.type === "function_call" && call?.name && call?.call_id;
  }) as ResponseFunctionCall[];
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  if (typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function collectResponseText(response: unknown): string {
  const output = Array.isArray((response as { output?: unknown[] })?.output) ? (response as { output: unknown[] }).output : [];
  return output.flatMap((item) => {
    const entry = item as { content?: string | Array<{ text?: string; value?: string }> };
    if (typeof entry?.content === "string") {
      return [entry.content];
    }
    if (Array.isArray(entry?.content)) {
      return entry.content
        .map((content) => content?.text ?? content?.value ?? "")
        .filter(Boolean);
    }
    return [];
  }).join("\n");
}

async function callBrainTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  target: Record<string, unknown>,
  config: BrainConfig,
): Promise<BrainToolResult> {
  if (name === "search_osrs_wiki") {
    const query = String(args.query ?? "");
    const results = await searchOsrsWiki({ query, maxResults: Number(args.maxResults ?? 5) }, config);
    return {
      status: "WIKI_SEARCH_READY",
      query,
      results: results.map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.content,
      })),
    };
  }

  if (!READ_ONLY_MCP_TOOLS.has(name) && !MUTATING_POLICY_TOOLS.has(name) && name !== "navigate_to") {
    return {
      status: "TOOL_BLOCKED",
      tool: name,
      stopReason: "Tool is not in the System 2 allowlist.",
    };
  }

  if (name === "load_policy" || name === "navigate_to") {
    const expected = QWEN_BRAIN_EXECUTE_CONFIRMATIONS[name];
    const wantsExecution = args.executionMode === "execute" || args.start === true;
    if (wantsExecution && args.confirmExecution !== expected) {
      return {
        status: "EXECUTION_BLOCKED",
        tool: name,
        stopReason: `Execution requires exact confirmation token ${expected}. Strategist should prefer dry_run.`,
      };
    }
  }

  if (name === "load_policy" && args.policy) {
    const policy = (args.policy as Record<string, unknown>).system1Policy ?? args.policy;
    try {
      assertStrategistPolicySafe(wrapPolicyForSafetyCheck(policy, args.executionMode));
    } catch (error) {
      return {
        status: "POLICY_BLOCKED",
        tool: name,
        stopReason: error instanceof Error ? error.message : "Policy failed safety validation.",
      };
    }
  }

  if ((name === "load_policy" || name === "navigate_to") && args.executionMode === "execute" && typeof args.confirmExecution !== "string") {
    return {
      status: "EXECUTION_BLOCKED",
      tool: name,
      stopReason: "Execution requires an explicit confirmation token. Strategist should prefer dry_run.",
    };
  }

  const mergedArgs = { ...target, ...args };
  const result = await client.callTool({ name, arguments: mergedArgs });
  return {
    status: "MCP_TOOL_RESULT",
    tool: name,
    result,
  };
}

function textContent(result: unknown): string {
  const record = result as { content?: Array<{ type?: string; text?: string }> };
  const text = record?.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") {
    throw new Error(`Expected text content, got ${JSON.stringify(result).slice(0, 500)}`);
  }
  return text;
}

async function callJsonTool(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const text = textContent(result);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      status: "NON_JSON_TOOL_RESULT",
      tool: name,
      text: text.slice(0, 1000),
    };
  }
}

function loadedPolicyFromStatus(status: Record<string, unknown>): Record<string, unknown> | undefined {
  const active = status.activePolicy ?? status.policy ?? status.active;
  return active && typeof active === "object" ? active as Record<string, unknown> : undefined;
}

function policyStatusFromStatus(status: Record<string, unknown>): string {
  const policy = loadedPolicyFromStatus(status);
  return String(policy?.status ?? status.status ?? "unknown");
}

function formatPolicyProgress(status: Record<string, unknown>): string {
  const policy = loadedPolicyFromStatus(status);
  if (!policy) {
    return `status=${String(status.status ?? "unknown")}`;
  }
  const parts = [
    `status=${String(policy.status ?? status.status ?? "unknown")}`,
    policy.task ? `task=${String(policy.task)}` : undefined,
    policy.tickCount !== undefined ? `ticks=${String(policy.tickCount)}` : undefined,
    policy.stepIndex !== undefined ? `step=${String(policy.stepIndex)}` : undefined,
    policy.itemName ? `item=${String(policy.itemName)}` : undefined,
    policy.quantity !== undefined ? `qty=${String(policy.quantity)}` : undefined,
    policy.stopReason ? `reason=${String(policy.stopReason)}` : undefined,
  ].filter(Boolean);
  return parts.join(" | ");
}

async function monitorSystem1Policy(
  client: Client,
  label: string,
  maxSeconds = Number(process.env.OSRS_BRAIN_MONITOR_SECONDS ?? 1800),
): Promise<Record<string, unknown>> {
  const started = Date.now();
  let lastLine = "";
  while (Date.now() - started < maxSeconds * 1000) {
    const status = await callJsonTool(client, "reflex_status", {});
    const line = formatPolicyProgress(status);
    if (line !== lastLine) {
      console.log(`[System 1] ${label}: ${line}`);
      lastLine = line;
    }

    const terminal = policyStatusFromStatus(status);
    if (["completed", "blocked", "stopped", "paused"].includes(terminal)) {
      return status;
    }
    await delay(Number(process.env.OSRS_BRAIN_MONITOR_INTERVAL_MS ?? 1500));
  }

  const timedOut = await callJsonTool(client, "reflex_stop", {
    reason: `BRAIN_MONITOR_TIMEOUT:${label}`,
  });
  console.log(`[System 1] ${label}: monitor timeout; stopped active policy.`);
  return timedOut;
}

async function runLocalExecutionPlan(
  plan: LocalExecutionPlan,
  connection: import("./mcp-client.js").BrainMcpConnection,
  target: Record<string, unknown>,
  config: BrainConfig,
  options: CliOptions,
): Promise<void> {
  console.log(`[Brain] Local fast path selected: ${plan.reason}. Qwen/wiki skipped for this goal.`);
  for (const warning of plan.warnings) {
    console.log(`[Brain] Note: ${warning}`);
  }

  if (plan.status === "LOCAL_PLAN_BLOCKED") {
    console.log(`[Brain] Blocked: ${plan.blocker ?? "local plan could not be compiled"}`);
    return;
  }

  console.log(`[Brain] Compiled ${plan.policies.length} System 1 policy stage(s):`);
  for (const [index, stage] of plan.policies.entries()) {
    console.log(`  ${index + 1}. ${stage.label}`);
  }

  if (!options.execute) {
    console.log("[Brain] Plan-only mode. No System 1 policy was started.");
    return;
  }

  connection.enableSystem1Logs();
  for (const [index, stage] of plan.policies.entries()) {
    const args = armExecuteArgs("load_policy", {
      policy: {
        ...stage.policy,
        executionMode: "execute",
      },
      start: true,
      executionMode: "execute",
    }, true);
    console.log("");
    console.log(`[Brain] Starting stage ${index + 1}/${plan.policies.length}: ${stage.label}`);
    printBrainAction("load_policy", args);
    const result = await callBrainTool(connection.client, "load_policy", args, target, config);
    if (!isPolicyHandoffSuccess(result)) {
      console.log(`[Brain] Stage failed to start: ${formatMcpToolFailure(result)}`);
      return;
    }

    printSystem1Takeover(result.result ?? result);
    const finalStatus = await monitorSystem1Policy(connection.client, stage.label);
    const terminal = policyStatusFromStatus(finalStatus);
    if (terminal !== "completed") {
      console.log(`[Brain] Sequence stopped at stage ${index + 1}: ${formatPolicyProgress(finalStatus)}`);
      return;
    }
  }

  console.log("");
  console.log("[Brain] Local fast-path sequence completed.");
}

function wrapPolicyForSafetyCheck(policy: unknown, executionMode: unknown): StrategistPolicy {
  return {
    kind: "osrs.strategist_policy.v1",
    policyId: "tool-call-safety-check",
    objective: "Validate load_policy tool payload before forwarding to System 1.",
    horizon: "single_action",
    executionMode: executionMode === "execute" ? "execute" : "dry_run",
    priority: 1,
    assumptions: [],
    requiredObservations: [],
    allowedSystem1Capabilities: [],
    forbiddenCapabilities: [],
    safetyConstraints: [],
    stopConditions: [],
    successCriteria: [],
    system1Policy: policy && typeof policy === "object" && !Array.isArray(policy) ? policy as Record<string, unknown> : { value: policy },
    steps: [],
    notesForSystem1: [],
  };
}

async function repairPolicyJson(qwen: ReturnType<typeof createQwenClient>, config: BrainConfig, goal: string, priorOutputText: string, parseError?: string) {
  const response = await createQwenResponse(qwen, config, {
    model: config.qwenModel,
    instructions: `${STRATEGIST_SYSTEM_PROMPT}\n\n${FINAL_JSON_ONLY_INSTRUCTION}`,
    input: JSON.stringify({
      goal,
      parseError,
      priorOutputText,
      requiredSchema: STRATEGIST_POLICY_JSON_SCHEMA,
      instruction: "Convert the prior strategist answer into exactly one valid JSON object matching requiredSchema. No Markdown. No prose. No tool calls.",
    }),
    parallel_tool_calls: false,
  });
  const outputText = (response as { output_text?: string }).output_text ?? collectResponseText(response);
  return {
    response,
    outputText,
    policyValidation: parseStrategistPolicyText(outputText),
  };
}

async function processGoal(goal: string, config: BrainConfig, options: CliOptions): Promise<void> {
  const connection = await connectToSystem1(config);

  try {
    const target = options.live
      ? await resolveTargetClient(connection.client, options.target, true)
      : { port: 65535 };
    console.log("");
    console.log(`[Brain] Goal received: "${goal}"`);
    console.log(`[Brain] Mode: ${options.live ? "live RuneLite plugin" : "offline simulation"} · ${options.execute ? "EXECUTE (menu actions armed)" : "plan-only (no in-game actions)"}`);
    if (options.execute && options.live && !target.port) {
      console.log("[Brain] WARNING: No RuneLite port auto-detected. Ensure the plugin is loaded (8080–8090) or set OSRS_RUNELITE_PORT / --port.");
    } else if (options.execute && options.live && target.port) {
      console.log(`[Brain] RuneLite client: port ${target.port}`);
    }
    if (!options.execute) {
      console.log("[Brain] Tip: remove --plan-only to execute in-game. Default mode executes via RuneLite menu actions.");
    }

    const localPlan = await buildLocalExecutionPlan(goal, connection.client, target, options);
    if (localPlan) {
      await runLocalExecutionPlan(localPlan, connection, target, config, options);
      return;
    }

    const qwen = createQwenClient(config);
    console.log("[Brain] Strategist thinking...");

    let response = await createQwenResponse(qwen, config, {
      model: config.qwenModel,
      instructions: buildStrategistInstructions(options.execute),
      input: JSON.stringify({
        goal,
        target,
        executionAuthorized: options.execute,
        instruction: buildGoalInstruction(options.execute),
      }),
      tools: QWEN_BRAIN_FUNCTION_TOOLS,
      parallel_tool_calls: true,
    });

    for (let round = 0; round < options.maxToolRounds; round += 1) {
      const calls = responseFunctionCalls(response);
      if (calls.length === 0) {
        const outputText = (response as { output_text?: string }).output_text ?? collectResponseText(response);
        await finalizeGoal(goal, qwen, config, connection, target, options, outputText);
        return;
      }

      let handoffComplete = false;
      let handoffResult: BrainToolResult | undefined;
      const outputs = await Promise.all(calls.map(async (call) => {
        let rawArgs = parseArguments(call.arguments);
        
        if (call.name === "load_policy") {
          // Extract the policy object from the LLM's load_policy call args.
          // The LLM may pass: { policy: { system1Policy: {...}, steps: [...] } }
          // or a flat policy object directly. We rebuild it cleanly.
          const llmPolicyArg = rawArgs.policy && typeof rawArgs.policy === "object"
            ? rawArgs.policy as Record<string, unknown>
            : rawArgs;
          const fakePolicy: StrategistPolicy = {
             kind: "osrs.strategist_policy.v1",
             policyId: "tool-call",
             objective: String(llmPolicyArg.objective ?? goal),
             horizon: "single_action",
             executionMode: options.execute ? "execute" : "dry_run",
             priority: 1,
             assumptions: [],
             requiredObservations: [],
             allowedSystem1Capabilities: [],
             forbiddenCapabilities: [],
             safetyConstraints: [],
             stopConditions: [],
             successCriteria: [],
             // system1Policy is the inner payload; prefer llmPolicyArg.system1Policy if present
             system1Policy: (llmPolicyArg.system1Policy && typeof llmPolicyArg.system1Policy === "object"
               ? llmPolicyArg.system1Policy as Record<string, unknown>
               : llmPolicyArg),
             // Preserve steps for stepsDestination extraction only — prepareSystem1Payload strips them
             steps: Array.isArray(llmPolicyArg.steps) ? llmPolicyArg.steps : [],
             notesForSystem1: [],
          };
          const payload = prepareSystem1Payload(fakePolicy, goal);
          // Replace rawArgs entirely with clean payload — do NOT spread the dirty rawArgs
          rawArgs = {
            policy: payload,
            start: rawArgs.start ?? true,
          };
        }

        const args = armExecuteArgs(call.name, rawArgs, options.execute);
        printBrainAction(call.name, args);
        const result = await callBrainTool(connection.client, call.name, args, target, config);

        if (call.name === "load_policy" && !isBlockedToolResult(result)) {
          handoffComplete = true;
          handoffResult = result;
        }

        if (isBlockedToolResult(result)) {
          console.log(`[Brain] Blocked: ${call.name} — ${String(result.stopReason ?? result.status)}`);
        }

        return {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        };
      }));

      if (handoffComplete) {
        if (options.execute) {
          if (handoffResult && isPolicyHandoffSuccess(handoffResult)) {
            printSystem1Takeover(handoffResult.result ?? handoffResult, () => connection.enableSystem1Logs());
          } else {
            console.log(`[Brain] load_policy did not arm execution: ${formatMcpToolFailure(handoffResult ?? { status: "UNKNOWN" })}`);
          }
        } else {
          console.log("[Brain] Policy staged in dry-run mode. System 1 was not started.");
        }
        return;
      }

      response = await createQwenResponse(qwen, config, {
        model: config.qwenModel,
        previous_response_id: (response as { id: string }).id,
        instructions: buildStrategistInstructions(options.execute),
        input: outputs,
        tools: QWEN_BRAIN_FUNCTION_TOOLS,
        parallel_tool_calls: true,
      });
    }

    const outputText = (response as { output_text?: string }).output_text ?? collectResponseText(response);
    console.log("[Brain] Tool round limit reached; summarizing strategist output.");
    await finalizeGoal(goal, qwen, config, connection, target, options, outputText, true);
  } finally {
    await connection.close();
  }
}

async function issuePolicyToSystem1(
  client: Client,
  policy: StrategistPolicy,
  goal: string,
  target: Record<string, unknown>,
  config: BrainConfig,
  execute: boolean,
): Promise<BrainToolResult> {
  const payload = prepareSystem1Payload(policy, goal);
  const args = armExecuteArgs("load_policy", {
    ...payload,
    policy: payload,
    start: true,
    executionMode: execute ? "execute" : "dry_run",
  }, execute);
  printBrainAction("load_policy", args);
  return callBrainTool(client, "load_policy", args, target, config);
}

async function finalizeGoal(
  goal: string,
  qwen: ReturnType<typeof createQwenClient>,
  config: BrainConfig,
  connection: import("./mcp-client.js").BrainMcpConnection,
  target: Record<string, unknown>,
  options: CliOptions,
  outputText: string,
  roundLimited = false,
): Promise<void> {
  const validation = parseStrategistPolicyText(outputText);
  if (validation.status === "POLICY_VALID" && validation.policy) {
    console.log(`[Brain] Policy drafted: ${validation.policy.policyId ?? "unknown"} — ${validation.policy.objective ?? goal}`);

    if (options.execute) {
      console.log("[Brain] Auto-handoff to System 1 (Qwen returned JSON without load_policy)...");
      const issued = await issuePolicyToSystem1(connection.client, validation.policy, goal, target, config, true);
      if (isPolicyHandoffSuccess(issued)) {
        printSystem1Takeover(issued.result ?? issued, () => connection.enableSystem1Logs());
        return;
      }
      console.log(`[Brain] System 1 handoff failed: ${formatMcpToolFailure(issued)}`);
      return;
    }

    console.log("[Brain] Plan-only mode. System 1 was not started.");
    return;
  }

  const repair = await repairPolicyJson(qwen, config, goal, outputText, validation.error);
  if (repair.policyValidation.status === "POLICY_VALID" && repair.policyValidation.policy) {
    console.log(`[Brain] Policy repaired: ${repair.policyValidation.policy.policyId ?? "unknown"}`);

    if (options.execute) {
      console.log("[Brain] Auto-handoff to System 1...");
      const issued = await issuePolicyToSystem1(connection.client, repair.policyValidation.policy, goal, target, config, true);
      if (isPolicyHandoffSuccess(issued)) {
        printSystem1Takeover(issued.result ?? issued, () => connection.enableSystem1Logs());
        return;
      }
      console.log(`[Brain] System 1 handoff failed: ${formatMcpToolFailure(issued)}`);
      return;
    }

    console.log("[Brain] Plan-only mode. System 1 was not started.");
    return;
  }

  console.log(`[Brain] Could not produce a valid policy${roundLimited ? " before the tool round limit" : ""}.`);
  if (validation.error) {
    console.log(`[Brain] Parse error: ${validation.error}`);
  }
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function parseCliFlags(): CliOptions {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const planOnly = args.has("--plan-only");
  const executeEnv = readEnvVar("OSRS_BRAIN_EXECUTE");
  const executeDisabled = executeEnv === "0" || executeEnv?.toLowerCase() === "false";
  const portValue = argValue("--port") ?? readEnvVar("OSRS_RUNELITE_PORT");
  const target: CliOptions["target"] = {};
  if (portValue) {
    target.port = Number(portValue);
  }
  if (argValue("--instance-id")) {
    target.instanceId = argValue("--instance-id");
  }
  if (argValue("--player-name")) {
    target.playerName = argValue("--player-name");
  }

  return {
    live: !dryRun,
    execute: !dryRun && !planOnly && !executeDisabled,
    maxToolRounds: Number(process.env.OSRS_BRAIN_MAX_TOOL_ROUNDS ?? 8),
    target,
  };
}

function startRepl(config: BrainConfig, options: CliOptions): void {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let busy = false;

  const ask = (): void => {
    rl.question(PROMPT, (line) => {
      void handleLine(line.trim());
    });
  };

  const handleLine = async (line: string): Promise<void> => {
    if (!line) {
      ask();
      return;
    }

    if (line.toLowerCase() === "exit" || line.toLowerCase() === "quit") {
      rl.close();
      return;
    }

    if (busy) {
      console.log("[Brain] Still processing the previous goal. Please wait.");
      ask();
      return;
    }

    busy = true;
    try {
      await processGoal(line, config, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Brain] Error: ${message}`);
    } finally {
      busy = false;
      ask();
    }
  };

  rl.on("close", () => {
    console.log("");
    console.log("[Brain] Goodbye.");
    process.exit(0);
  });

  ask();
}

async function main(): Promise<void> {
  const config = getBrainConfig();
  const options = parseCliFlags();
  const oneShotGoal = argValue("--goal");

  if (!config.qwenApiKey) {
    console.log("[Brain] QWEN_API_KEY is not configured. Local fast-path commands still work; unknown goals will fail when they need Qwen.");
  }

  let resolvedTarget: Record<string, unknown> | undefined;
  if (options.live) {
    const connection = await connectToSystem1(config);
    try {
      resolvedTarget = await resolveTargetClient(connection.client, options.target, true);
    } finally {
      await connection.close();
    }
  }

  printBanner(config, options, resolvedTarget);
  if (oneShotGoal) {
    await processGoal(oneShotGoal, config, options);
    return;
  }
  startRepl(config, options);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Brain] Fatal: ${message}`);
  process.exit(1);
});
