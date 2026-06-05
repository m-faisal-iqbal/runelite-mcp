import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { BrainConfig } from "./config.js";
import { getBrainConfig } from "./config.js";
import { connectToSystem1 } from "./mcp-client.js";
import { assertStrategistPolicySafe, STRATEGIST_POLICY_JSON_SCHEMA, type StrategistPolicy } from "./policy-schema.js";
import { createQwenClient, qwenErrorMessage } from "./qwen-client.js";
import { STRATEGIST_SYSTEM_PROMPT } from "./system-prompt.js";
import { searchOsrsWiki } from "./wiki-search.js";

type BrainToolResult = {
  status: string;
  [key: string]: unknown;
};

type BrainRunOptions = {
  goal: string;
  maxToolRounds?: number;
  live?: boolean;
  target?: {
    port?: number;
    instanceId?: string;
    playerName?: string;
  };
};

type ResponseFunctionCall = {
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

const MUTATING_POLICY_TOOLS = new Set([
  "load_policy",
]);

const FINAL_JSON_ONLY_INSTRUCTION = [
  "Final response format is mandatory:",
  "Return exactly one JSON object matching the strategist policy schema.",
  "Do not use Markdown.",
  "Do not explain the policy in prose.",
  "Do not say that the policy was loaded or staged unless that fact appears inside notesForSystem1.",
  "The JSON object must include kind, policyId, objective, horizon, executionMode, priority, assumptions, requiredObservations, allowedSystem1Capabilities, forbiddenCapabilities, safetyConstraints, stopConditions, successCriteria, system1Policy, steps, and notesForSystem1.",
].join("\n");

export const QWEN_BRAIN_EXECUTE_CONFIRMATIONS = {
  load_policy: "LOAD_POLICY_EXECUTE",
  navigate_to: "NAVIGATE_ONE_STEP",
} as const;

export const QWEN_BRAIN_FUNCTION_TOOLS = [
  functionTool("get_agent_context", "Read compact current player/runtime context.", {
    objective: { type: "string" },
    includeDiagnostics: { type: "boolean" },
    includeNearbyLimit: { type: "number" },
    includeInventoryLimit: { type: "number" },
  }),
  functionTool("knowledge_query", "Query local OSRS knowledge records.", {
    query: { type: "string" },
    limit: { type: "number" },
  }, ["query"]),
  functionTool("knowledge_get_method", "Find a local skilling/activity method record.", {
    activity: { type: "string" },
    currentLevel: { type: "number" },
  }, ["activity"]),
  functionTool("memory_search_lessons", "Retrieve prior lessons/failures before risky planning.", {
    query: { type: "string" },
    onlyFailures: { type: "boolean" },
    limit: { type: "number" },
  }, ["query"]),
  functionTool("memory_get_profile", "Read compact remembered player profile, preferences, and durable constraints.", {
    forceRefresh: { type: "boolean" },
  }),
  functionTool("navigate_to", "Load or execute one bounded System 1 navigation step. Prefer dry_run.", {
    destination: { type: "string" },
    executionMode: { type: "string", enum: ["dry_run", "execute"] },
    confirmExecution: { type: "string" },
  }, ["destination"]),
  functionTool("perceive_minimap", "Read compact minimap/camera/player context.", {
    maxEntities: { type: "number" },
  }),
  functionTool("perceive_chat", "Read compact recent chat context.", {
    limit: { type: "number" },
  }),
  functionTool("perceive_ui_region", "Read compact UI/region perception for current interface state.", {
    region: { type: "string" },
    includeText: { type: "boolean" },
  }),
  functionTool("load_policy", "Load a concrete System 1 policy into the ReflexEngine.", {
    policy: { type: "object" },
    start: { type: "boolean" },
    executionMode: { type: "string", enum: ["dry_run", "execute"] },
    confirmExecution: { type: "string" },
  }, ["policy"]),
  functionTool("search_osrs_wiki", "Search the live OSRS Wiki through Tavily for planning evidence.", {
    query: { type: "string" },
    maxResults: { type: "number" },
  }, ["query"]),
] as const;

export async function runBrainWithResponses(options: BrainRunOptions, config: BrainConfig = getBrainConfig()) {
  const qwen = createQwenClient(config);
  const connection = await connectToSystem1(config);
  try {
    const target = options.live ? options.target ?? {} : { port: 65535 };
    let response = await createQwenResponse(qwen, config, {
      model: config.qwenModel,
      instructions: `${STRATEGIST_SYSTEM_PROMPT}\n\n${FINAL_JSON_ONLY_INSTRUCTION}`,
      input: JSON.stringify({
        goal: options.goal,
        target,
        instruction: "Use function tools for compact context/knowledge, then return only a strategist policy JSON object. Do not request or emit raw clicks, invokes, keyboard, or mouse actions.",
      }),
      tools: QWEN_BRAIN_FUNCTION_TOOLS,
      parallel_tool_calls: true,
    });

    for (let round = 0; round < (options.maxToolRounds ?? 4); round += 1) {
      const calls = responseFunctionCalls(response);
      if (calls.length === 0) {
        const outputText = response.output_text ?? collectResponseText(response);
        return finalizeBrainPolicyResponse(qwen, config, {
          goal: options.goal,
          response,
          outputText,
          invalidStatus: "BRAIN_POLICY_INVALID",
        });
      }

      const outputs = await Promise.all(calls.map(async (call) => ({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(await callBrainTool(connection.client, call.name, parseArguments(call.arguments), target, config)),
      })));

      response = await createQwenResponse(qwen, config, {
        model: config.qwenModel,
        previous_response_id: response.id,
        instructions: `${STRATEGIST_SYSTEM_PROMPT}\n\n${FINAL_JSON_ONLY_INSTRUCTION}`,
        input: outputs,
        tools: QWEN_BRAIN_FUNCTION_TOOLS,
        parallel_tool_calls: true,
      });
    }

    const outputText = response.output_text ?? collectResponseText(response);
    return finalizeBrainPolicyResponse(qwen, config, {
      goal: options.goal,
      response,
      outputText,
      invalidStatus: "BRAIN_TOOL_ROUND_LIMIT",
      stopReason: "MAX_TOOL_ROUNDS_REACHED",
    });
  } finally {
    await connection.close();
  }
}

async function finalizeBrainPolicyResponse(qwen: any, config: BrainConfig, args: {
  goal: string;
  response: any;
  outputText: string;
  invalidStatus: "BRAIN_POLICY_INVALID" | "BRAIN_TOOL_ROUND_LIMIT";
  stopReason?: string;
}) {
  const policyValidation = parseStrategistPolicyText(args.outputText);
  if (policyValidation.status === "POLICY_VALID") {
    return {
      status: "BRAIN_POLICY_READY",
      goal: args.goal,
      responseId: args.response.id,
      outputText: args.outputText,
      policy: policyValidation.policy,
      policyValidation,
      rawResponse: args.response,
    };
  }

  const repair = await repairPolicyJson(qwen, config, args.goal, args.outputText, policyValidation.error);
  if (repair.policyValidation.status === "POLICY_VALID") {
    return {
      status: "BRAIN_POLICY_READY",
      goal: args.goal,
      responseId: args.response.id,
      outputText: repair.outputText,
      policy: repair.policyValidation.policy,
      policyValidation: repair.policyValidation,
      repair: {
        attempted: true,
        responseId: repair.response.id,
        originalError: policyValidation.error,
      },
      rawResponse: args.response,
    };
  }

  return {
    status: args.invalidStatus,
    goal: args.goal,
    responseId: args.response.id,
    outputText: args.outputText,
    policyValidation,
    repair: {
      attempted: true,
      responseId: repair.response.id,
      outputText: repair.outputText,
      policyValidation: repair.policyValidation,
    },
    stopReason: args.stopReason,
  };
}

async function repairPolicyJson(qwen: any, config: BrainConfig, goal: string, priorOutputText: string, parseError?: string) {
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
  const outputText = response.output_text ?? collectResponseText(response);
  return {
    response,
    outputText,
    policyValidation: parseStrategistPolicyText(outputText),
  };
}

async function createQwenResponse(qwen: any, config: BrainConfig, payload: Record<string, unknown>) {
  try {
    return await qwen.responses.create(payload);
  } catch (error) {
    throw new Error(qwenErrorMessage(error, config));
  }
}

async function callBrainTool(client: Client, name: string, args: Record<string, unknown>, target: Record<string, unknown>, config: BrainConfig): Promise<BrainToolResult> {
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

function functionTool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties,
      required,
    },
  };
}

function responseFunctionCalls(response: any): ResponseFunctionCall[] {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output.filter((item: any) => item?.type === "function_call" && item?.name && item?.call_id);
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  if (typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function collectResponseText(response: any): string {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output.flatMap((item: any) => {
    if (typeof item?.content === "string") {
      return [item.content];
    }
    if (Array.isArray(item?.content)) {
      return item.content
        .map((content: any) => content?.text ?? content?.value ?? "")
        .filter(Boolean);
    }
    return [];
  }).join("\n");
}

export type ParsedStrategistPolicyResult = {
  status: "POLICY_VALID" | "POLICY_INVALID";
  policy?: StrategistPolicy;
  error?: string;
};

export function parseStrategistPolicyText(text: string): ParsedStrategistPolicyResult {
  const candidate = extractJsonObjectText(text);
  if (!candidate) {
    return {
      status: "POLICY_INVALID",
      error: "No JSON object found in strategist response.",
    };
  }

  try {
    const policy = JSON.parse(candidate) as StrategistPolicy;
    assertStrategistPolicySafe(policy);
    return {
      status: "POLICY_VALID",
      policy,
    };
  } catch (error) {
    return {
      status: "POLICY_INVALID",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractJsonObjectText(text: string): string | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const source = fenced ? fenced[1].trim() : trimmed;
  if (source.startsWith("{") && source.endsWith("}")) {
    return source;
  }

  const start = source.indexOf("{");
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return undefined;
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
