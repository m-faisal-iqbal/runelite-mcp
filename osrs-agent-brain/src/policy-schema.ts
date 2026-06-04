export type ExecutionMode = "dry_run" | "execute";
export type PolicyHorizon = "single_action" | "short_task" | "multi_stage_goal";

export type PolicyStep = {
  name: string;
  intent: string;
  preferredSystem1Capability: string;
  inputs: Record<string, unknown>;
  verification: string[];
  stopIf: string[];
};

export type StrategistPolicy = {
  kind: "osrs.strategist_policy.v1";
  policyId: string;
  objective: string;
  horizon: PolicyHorizon;
  executionMode: ExecutionMode;
  priority: number;
  assumptions: string[];
  requiredObservations: string[];
  allowedSystem1Capabilities: string[];
  forbiddenCapabilities: string[];
  safetyConstraints: string[];
  stopConditions: string[];
  successCriteria: string[];
  system1Policy: Record<string, unknown>;
  steps: PolicyStep[];
  notesForSystem1: string[];
};

const FORBIDDEN_SYSTEM2_CAPABILITY_NEEDLES = [
  "click",
  "invoke_",
  "move_mouse",
  "keyboard",
  "perform_until",
  "execute_agent_step",
];

function containsForbiddenCapability(value: unknown): string | undefined {
  const text = String(value ?? "").toLowerCase();
  return FORBIDDEN_SYSTEM2_CAPABILITY_NEEDLES.find((needle) => text.includes(needle));
}

function checkCapabilityList(values: unknown, path: string, errors: string[]) {
  if (!Array.isArray(values)) {
    return;
  }
  for (const [index, value] of values.entries()) {
    const needle = containsForbiddenCapability(value);
    if (needle) {
      errors.push(`${path}[${index}] contains forbidden raw capability '${value}' matched by '${needle}'`);
    }
  }
}

function checkStepCapability(step: unknown, path: string, errors: string[]) {
  if (!step || typeof step !== "object") {
    return;
  }
  const record = step as Record<string, unknown>;
  for (const key of ["tool", "preferredSystem1Capability", "capability"]) {
    if (!(key in record)) {
      continue;
    }
    const needle = containsForbiddenCapability(record[key]);
    if (needle) {
      errors.push(`${path}.${key} contains forbidden raw capability '${String(record[key])}' matched by '${needle}'`);
    }
  }
}

function checkSystem1PolicyValue(value: unknown, path: string, errors: string[]) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => checkSystem1PolicyValue(entry, `${path}[${index}]`, errors));
    return;
  }

  const record = value as Record<string, unknown>;
  checkStepCapability(record, path, errors);
  for (const [key, nested] of Object.entries(record)) {
    if (["objective", "notes", "reason", "description"].includes(key)) {
      continue;
    }
    if (nested && typeof nested === "object") {
      checkSystem1PolicyValue(nested, `${path}.${key}`, errors);
    }
  }
}

export function validateStrategistPolicy(policy: StrategistPolicy): string[] {
  const errors: string[] = [];
  checkCapabilityList(policy.allowedSystem1Capabilities, "allowedSystem1Capabilities", errors);
  policy.steps.forEach((step, index) => checkStepCapability(step, `steps[${index}]`, errors));
  checkSystem1PolicyValue(policy.system1Policy, "system1Policy", errors);
  return errors;
}

export function assertStrategistPolicySafe(policy: StrategistPolicy) {
  const errors = validateStrategistPolicy(policy);
  if (errors.length > 0) {
    throw new Error(`Strategist policy violates Twin-Brain execution rules: ${errors.join("; ")}`);
  }
}

export function assertSystem1PolicySafe(system1Policy: Record<string, unknown>) {
  const errors: string[] = [];
  checkSystem1PolicyValue(system1Policy, "system1Policy", errors);
  if (errors.length > 0) {
    throw new Error(`System 2 attempted to issue raw action steps instead of a policy: ${errors.join("; ")}`);
  }
}

export const STRATEGIST_POLICY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "policyId",
    "objective",
    "horizon",
    "executionMode",
    "priority",
    "assumptions",
    "requiredObservations",
    "allowedSystem1Capabilities",
    "forbiddenCapabilities",
    "safetyConstraints",
    "stopConditions",
    "successCriteria",
    "system1Policy",
    "steps",
    "notesForSystem1"
  ],
  properties: {
    kind: { const: "osrs.strategist_policy.v1" },
    policyId: { type: "string" },
    objective: { type: "string" },
    horizon: { enum: ["single_action", "short_task", "multi_stage_goal"] },
    executionMode: { enum: ["dry_run", "execute"] },
    priority: { type: "integer", minimum: 1, maximum: 10 },
    assumptions: { type: "array", items: { type: "string" } },
    requiredObservations: { type: "array", items: { type: "string" } },
    allowedSystem1Capabilities: { type: "array", items: { type: "string" } },
    forbiddenCapabilities: { type: "array", items: { type: "string" } },
    safetyConstraints: { type: "array", items: { type: "string" } },
    stopConditions: { type: "array", items: { type: "string" } },
    successCriteria: { type: "array", items: { type: "string" } },
    system1Policy: {
      type: "object",
      description: "Concrete payload for the MCP load_policy tool. This is the only action handoff System 2 may produce."
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "intent", "preferredSystem1Capability", "inputs", "verification", "stopIf"],
        properties: {
          name: { type: "string" },
          intent: { type: "string" },
          preferredSystem1Capability: { type: "string" },
          inputs: { type: "object" },
          verification: { type: "array", items: { type: "string" } },
          stopIf: { type: "array", items: { type: "string" } }
        }
      }
    },
    notesForSystem1: { type: "array", items: { type: "string" } }
  }
} as const;
