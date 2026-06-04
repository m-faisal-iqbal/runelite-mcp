import { inspectSystem1 } from "./mcp-client.js";

const requiredTools = [
  "load_policy",
  "reflex_status",
  "reflex_stop",
  "transport_graph_status",
  "plan_route",
  "navigate_to",
  "perceive_minimap",
  "perceive_chat",
  "perceive_ui_region",
  "strategy_cache_get",
  "strategy_cache_put",
  "strategy_cache_list",
  "memory_search_lessons",
  "get_game_state",
  "get_interface_summary",
  "get_skills",
  "list_clients"
];

const policyOrKnowledgeSignals = [
  "knowledge",
  "memory",
  "semantic",
  "agent",
  "skill",
  "policy",
  "reflex",
  "navigation"
];

const inspection = await inspectSystem1();
const missingTools = requiredTools.filter((name) => !inspection.toolNames.includes(name));
const hasStrategistSurface = inspection.toolNames.some((name) =>
  policyOrKnowledgeSignals.some((signal) => name.includes(signal))
);

if (missingTools.length > 0) {
  console.error(JSON.stringify({ status: "FAIL", reason: "MISSING_REQUIRED_TOOLS", missingTools }, null, 2));
  process.exit(1);
}

if (!hasStrategistSurface) {
  console.error(JSON.stringify({ status: "FAIL", reason: "MISSING_STRATEGIST_TOOL_SURFACE" }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: "PASS",
  serverPath: inspection.serverPath,
  toolCount: inspection.toolCount,
  resourceCount: inspection.resourceCount,
  requiredTools,
  strategistToolExamples: inspection.toolNames
    .filter((name) => policyOrKnowledgeSignals.some((signal) => name.includes(signal)))
    .slice(0, 12)
}, null, 2));
