import { parseStrategistPolicyText, QWEN_BRAIN_EXECUTE_CONFIRMATIONS } from "./brain.js";
import type { StrategistPolicy } from "./policy-schema.js";

const validPolicy: StrategistPolicy = {
  kind: "osrs.strategist_policy.v1",
  policyId: "smoke-policy-001",
  objective: "Acquire five logs with safe local woodcutting policy.",
  horizon: "short_task",
  executionMode: "dry_run",
  priority: 5,
  assumptions: ["Player is logged in and near normal trees."],
  requiredObservations: ["inventory_count", "nearby_objects", "player_position"],
  allowedSystem1Capabilities: ["load_policy", "reflex_interact", "inventory_guard"],
  forbiddenCapabilities: ["raw_mouse", "raw_keyboard", "old_llm_loop"],
  safetyConstraints: ["Stop if health is low.", "Stop if another player threat appears on minimap."],
  stopConditions: ["Inventory full.", "No reachable trees.", "Policy timeout."],
  successCriteria: ["Inventory contains at least five logs."],
  system1Policy: {
    type: "gather_item",
    itemName: "Logs",
    quantity: 5,
    method: "woodcutting",
    targetObjectNames: ["Tree"],
    guards: {
      eat_food_when: { hpPercentBelow: 35 },
      stopOnMinimapPlayerThreat: true,
    },
  },
  steps: [
    {
      name: "woodcut-local-tree",
      intent: "Let System 1 choose and interact with a reachable normal tree.",
      preferredSystem1Capability: "reflex_interact",
      inputs: { objectName: "Tree" },
      verification: ["Logs increase in inventory."],
      stopIf: ["No reachable tree is visible."],
    },
  ],
  notesForSystem1: ["Use in-client interaction primitives only."],
};

const valid = parseStrategistPolicyText(JSON.stringify(validPolicy));
const fenced = parseStrategistPolicyText(`\`\`\`json\n${JSON.stringify(validPolicy)}\n\`\`\``);
const blocked = parseStrategistPolicyText(JSON.stringify({
  ...validPolicy,
  policyId: "smoke-policy-blocked",
  system1Policy: {
    steps: [
      {
        tool: "execute_agent_step",
        reason: "This old LLM loop primitive must never be issued by System 2.",
      },
    ],
  },
}));

const failures = [
  valid.status === "POLICY_VALID" ? undefined : "valid JSON policy was rejected",
  fenced.status === "POLICY_VALID" ? undefined : "fenced JSON policy was rejected",
  blocked.status === "POLICY_INVALID" ? undefined : "raw old-loop policy was not rejected",
  QWEN_BRAIN_EXECUTE_CONFIRMATIONS.load_policy === "LOAD_POLICY_EXECUTE" ? undefined : "load_policy token changed",
  QWEN_BRAIN_EXECUTE_CONFIRMATIONS.navigate_to === "NAVIGATE_ONE_STEP" ? undefined : "navigate_to token changed",
].filter(Boolean);

if (failures.length > 0) {
  console.error(JSON.stringify({
    status: "FAIL",
    failures,
    valid,
    fenced,
    blocked,
    confirmations: QWEN_BRAIN_EXECUTE_CONFIRMATIONS,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: "PASS",
  parsedPolicyId: valid.policy?.policyId,
  blockedReason: blocked.error,
  confirmations: QWEN_BRAIN_EXECUTE_CONFIRMATIONS,
}, null, 2));
