import { QWEN_BRAIN_FUNCTION_TOOLS } from "./brain.js";

const names = QWEN_BRAIN_FUNCTION_TOOLS.map((tool) => tool.name).sort();
const required = [
  "get_agent_context",
  "knowledge_get_method",
  "knowledge_query",
  "load_policy",
  "memory_get_profile",
  "memory_search_lessons",
  "navigate_to",
  "perceive_chat",
  "perceive_minimap",
  "perceive_ui_region",
  "search_osrs_wiki",
];
const forbiddenNeedles = [
  "agent_run_goal",
  "run_agent_cycle",
  "execute_agent_step",
  "strategy_cache",
  "plan_route",
  "click",
  "invoke",
  "mouse",
  "keyboard",
];

const missing = required.filter((name) => !names.includes(name));
const forbidden = names.filter((name) => forbiddenNeedles.some((needle) => name.includes(needle)));

if (missing.length > 0 || forbidden.length > 0) {
  console.error(JSON.stringify({
    status: "FAIL",
    reason: "QWEN_BRAIN_TOOL_SURFACE_INVALID",
    missing,
    forbidden,
    names,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: "PASS",
  toolCount: names.length,
  names,
}, null, 2));
