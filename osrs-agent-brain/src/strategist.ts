import type { BrainConfig } from "./config.js";
import { getBrainConfig } from "./config.js";
import { connectToSystem1 } from "./mcp-client.js";
import { draftPolicyOnce } from "./qwen-client.js";
import type { StrategistPolicy } from "./policy-schema.js";
import { assertStrategistPolicySafe, assertSystem1PolicySafe } from "./policy-schema.js";
import { searchOsrsWiki } from "./wiki-search.js";

export type StrategistDraftOptions = {
  goal: string;
  useQwen?: boolean;
  live?: boolean;
  port?: number;
  instanceId?: string;
  playerName?: string;
  wikiSearch?: "auto" | "force" | "off";
};

export type StrategistContext = {
  goal: string;
  gatheredAt: number;
  system1: {
    toolCount: number;
    resourceCount: number;
    policyTools: string[];
    knowledgeTools: string[];
    forbiddenRawToolsPresent: string[];
  };
  strategyCache: unknown;
  observation: unknown;
  reflexStatus: unknown;
  knowledge: {
    query: unknown;
    method: unknown;
    index: unknown;
  };
  wikiSearch: unknown;
  memoryLessons: unknown;
  memoryProfile: unknown;
};

export type StrategistDraft = {
  status: "POLICY_DRAFTED" | "QWEN_NOT_CONFIGURED" | "POLICY_CACHE_HIT";
  source: "qwen" | "local_scaffold_no_qwen" | "strategy_cache";
  goal: string;
  context: StrategistContext;
  policy: StrategistPolicy | string;
  cache?: {
    status: string;
    key?: string;
    used: boolean;
    stored?: boolean;
  };
  next: string;
};

export type IssuedPolicyResult = {
  status: "ISSUED_TO_SYSTEM1";
  loadResult: unknown;
  reflexStatus: unknown;
  cleanup?: unknown;
};

const rawToolNeedles = ["click", "invoke_", "move_mouse", "keyboard", "perform_until", "execute_agent_step"];

export async function gatherStrategistContext(options: StrategistDraftOptions, config: BrainConfig = getBrainConfig()): Promise<StrategistContext> {
  const connection = await connectToSystem1(config);
  try {
    const [toolsResult, resourcesResult] = await Promise.all([
      connection.client.listTools(),
      connection.client.listResources()
    ]);
    const toolNames = toolsResult.tools.map((tool) => tool.name).sort();
    const resourceUris = resourcesResult.resources.map((resource) => resource.uri).sort();
    const target = options.live
      ? cleanTarget({ port: options.port, instanceId: options.instanceId, playerName: options.playerName })
      : { port: options.port ?? 65535 };

    const [strategyCache, observation, reflexStatus, reflexResource, knowledge, method, knowledgeIndex, memoryLessons, memoryProfile] = await Promise.all([
      callJsonTool(connection.client, "strategy_cache_get", {
        goal: options.goal,
        method: "strategist_policy_v1",
      }),
      callJsonTool(connection.client, "get_agent_context", {
        objective: options.goal,
        includeDiagnostics: false,
        includeNearbyLimit: 5,
        includeInventoryLimit: 12,
        ...target,
      }),
      callJsonTool(connection.client, "reflex_status", {}),
      readJsonResource(connection.client, "osrs://reflex/status"),
      callJsonTool(connection.client, "knowledge_query", {
        query: options.goal,
        limit: 6,
      }),
      callJsonTool(connection.client, "knowledge_get_method", {
        activity: options.goal,
        currentLevel: 1,
      }),
      readJsonResource(connection.client, "osrs://knowledge/index"),
      callJsonTool(connection.client, "memory_search_lessons", {
        query: options.goal,
        onlyFailures: isRiskyGoal(options.goal),
        limit: 6,
      }),
      readJsonResource(connection.client, "osrs://memory/profile"),
    ]);

    const wikiSearch = await gatherWikiSearchContext(options, config, {
      knowledge,
      method,
    });

    return {
      goal: options.goal,
      gatheredAt: Date.now(),
      system1: {
        toolCount: toolNames.length,
        resourceCount: resourceUris.length,
        policyTools: toolNames.filter((name) =>
          name === "load_policy" ||
          name.startsWith("reflex_") ||
          name === "plan_route" ||
          name === "navigate_to" ||
          name.startsWith("perceive_")
        ),
        knowledgeTools: toolNames.filter((name) => name.startsWith("knowledge_")),
        forbiddenRawToolsPresent: toolNames.filter((name) => rawToolNeedles.some((needle) => name.includes(needle))),
      },
      strategyCache,
      observation,
      reflexStatus: {
        tool: reflexStatus,
        resource: reflexResource,
      },
      knowledge: {
        query: knowledge,
        method,
        index: knowledgeIndex,
      },
      wikiSearch,
      memoryLessons,
      memoryProfile,
    };
  } finally {
    await connection.close();
  }
}

export async function draftStrategistPolicy(options: StrategistDraftOptions, config: BrainConfig = getBrainConfig()): Promise<StrategistDraft> {
  const context = await gatherStrategistContext(options, config);
  const cachedEntry = (context.strategyCache as any)?.entry;
  if (cachedEntry?.policy) {
    assertStrategistPolicySafe(cachedEntry.policy as StrategistPolicy);
    return {
      status: "POLICY_CACHE_HIT",
      source: "strategy_cache",
      goal: options.goal,
      context,
      policy: cachedEntry.policy,
      cache: {
        status: "STRATEGY_CACHE_HIT",
        key: cachedEntry.key,
        used: true,
      },
      next: "Cached policy returned. Submit policy.system1Policy to load_policy only after execution is explicitly authorized.",
    };
  }

  if (options.useQwen && config.qwenApiKey) {
    const policy = await draftPolicyOnce(options.goal, compactContextForQwen(context), config);
    await cacheStrategyPolicy(options.goal, policy, "qwen", context, config);
    return {
      status: "POLICY_DRAFTED",
      source: "qwen",
      goal: options.goal,
      context,
      policy,
      cache: {
        status: "STRATEGY_CACHED",
        used: false,
        stored: true,
      },
      next: "Review the JSON. Submit policy.system1Policy to load_policy only after execution is explicitly authorized.",
    };
  }

  const policy = buildLocalPolicyScaffold(options.goal, context);
  assertStrategistPolicySafe(policy);
  await cacheStrategyPolicy(options.goal, policy, "local_scaffold_no_qwen", context, config);
  return {
    status: config.qwenApiKey ? "POLICY_DRAFTED" : "QWEN_NOT_CONFIGURED",
    source: "local_scaffold_no_qwen",
    goal: options.goal,
    context,
    policy,
    cache: {
      status: "STRATEGY_CACHED",
      used: false,
      stored: true,
    },
    next: config.qwenApiKey
      ? "Pass --use-qwen to request a Qwen-authored strategist policy."
      : "Set QWEN_API_KEY to request a Qwen-authored strategist policy. This local scaffold is for smoke testing the handoff shape.",
  };
}

async function cacheStrategyPolicy(goal: string, policy: unknown, source: string, context: StrategistContext, config: BrainConfig) {
  const connection = await connectToSystem1(config);
  try {
    await callJsonTool(connection.client, "strategy_cache_put", {
      goal,
      method: "strategist_policy_v1",
      source,
      policy,
      contextSummary: {
        observedStatus: (context.observation as any)?.status,
        knowledgeResultCount: (context.knowledge.query as any)?.results?.length,
        wikiSearchStatus: (context.wikiSearch as any)?.status,
        wikiSearchResultCount: (context.wikiSearch as any)?.results?.length,
        policyTools: context.system1.policyTools,
      },
      metadata: {
        cachedBy: "osrs-agent-brain",
        cachedAt: Date.now(),
      },
    });
  } finally {
    await connection.close();
  }
}

export async function issueSystem1Policy(system1Policy: Record<string, unknown>, options: {
  start?: boolean;
  cleanup?: boolean;
  executionMode?: "dry_run" | "execute";
  confirmExecution?: string;
} = {}, config: BrainConfig = getBrainConfig()): Promise<IssuedPolicyResult> {
  assertSystem1PolicySafe(system1Policy);
  const connection = await connectToSystem1(config);
  try {
    const loadResult = await callJsonTool(connection.client, "load_policy", {
      policy: system1Policy,
      start: options.start ?? false,
      executionMode: options.executionMode ?? system1Policy.executionMode ?? "dry_run",
      confirmExecution: options.confirmExecution,
    });
    const reflexStatus = await callJsonTool(connection.client, "reflex_status", {});
    const cleanup = options.cleanup === false
      ? undefined
      : await callJsonTool(connection.client, "reflex_stop", { reason: "BRAIN_ISSUE_POLICY_CLEANUP" });

    return {
      status: "ISSUED_TO_SYSTEM1",
      loadResult,
      reflexStatus,
      cleanup,
    };
  } finally {
    await connection.close();
  }
}

export function buildLocalPolicyScaffold(goal: string, context: StrategistContext): StrategistPolicy {
  const inferred = inferSystem1Policy(goal);
  const policyId = `strategy_${Date.now()}`;

  return {
    kind: "osrs.strategist_policy.v1",
    policyId,
    objective: goal,
    horizon: inferred.horizon,
    executionMode: "dry_run",
    priority: 5,
    assumptions: [
      "This is a local scaffold because Qwen was not invoked.",
      "System 1 must validate fresh state before any real execution.",
      `Current observation status: ${String((context.observation as any)?.status ?? "UNKNOWN")}`,
      `Retrieved memory lessons: ${Number((context.memoryLessons as any)?.lessons?.length ?? 0)}`,
      `Wiki search status: ${String((context.wikiSearch as any)?.status ?? "UNKNOWN")}`,
    ],
    requiredObservations: [
      "get_agent_context",
      "reflex_status",
      "knowledge_query",
    ],
    allowedSystem1Capabilities: [
      "load_policy",
      "reflex_status",
      "reflex_stop",
      "plan_route",
      "navigate_to",
      "perceive_minimap",
      "perceive_chat",
      "perceive_ui_region",
      "knowledge_query",
      "knowledge_get_method",
    ],
    forbiddenCapabilities: context.system1.forbiddenRawToolsPresent,
    safetyConstraints: [
      "Do not call raw click, invoke, mouse, or keyboard tools from System 2.",
      "Use dry_run until a controlling process explicitly authorizes execution.",
      "Stop on inventory full unless a banking policy is loaded.",
      "Respect System 1 survival guards before efficiency goals.",
    ],
    stopConditions: inferred.stopConditions,
    successCriteria: inferred.successCriteria,
    system1Policy: inferred.system1Policy,
    steps: [
      {
        name: "load_system1_policy",
        intent: "Hand the concrete policy to the Reflex Engine; System 1 owns the local tick loop.",
        preferredSystem1Capability: "load_policy",
        inputs: inferred.system1Policy,
        verification: ["reflex_status reports loaded/running/completed/blocked with stopReason"],
        stopIf: ["load_policy rejects policy", "reflex_status reports blocked"],
      },
    ],
    notesForSystem1: [
      "Run local tick execution only inside ReflexEngine.",
      "Never ask System 2 for per-tick action decisions.",
    ],
  };
}

function inferSystem1Policy(goal: string) {
  const text = goal.toLowerCase();
  if (text.includes("mining") || text.includes("mine") || text.includes(" ore")) {
    const quantity = firstNumber(text) ?? 1;
    const itemName = miningItemNameFromGoal(text);
    return {
      horizon: "short_task" as const,
      system1Policy: {
        task: `mine_${itemName.toLowerCase().replace(/\s+/g, "_").replace(/_ore$/, "")}`,
        objective: goal,
        itemName,
        quantity,
        quantityMode: "gain",
        method: "mining",
        inventoryFullBehavior: text.includes("drop") ? "drop" : "stop",
        dropItemName: text.includes("drop") ? itemName : undefined,
        eatAtHpPercent: 35,
        executionMode: "dry_run",
      },
      stopConditions: [
        `${quantity} ${itemName} gained`,
        "inventory full before target quantity is gained",
        "matching rocks are not visible or reachable",
        "RuneLite client unavailable",
        "survival guard cannot find food when needed",
      ],
      successCriteria: [`Inventory gains ${quantity} ${itemName}`],
    };
  }

  if (text.includes("log") || text.includes("tree") || text.includes("woodcut") || text.includes("chop")) {
    const quantity = firstNumber(text) ?? 5;
    const itemName = text.includes("oak") ? "Oak logs" : "Logs";
    const inventoryFullBehavior = text.includes("drop")
      ? "drop"
      : text.includes("bank")
        ? "bank"
        : "stop";
    return {
      horizon: "short_task" as const,
      system1Policy: {
        task: "chop_logs",
        objective: goal,
        itemName,
        quantity,
        quantityMode: "gain",
        method: "woodcutting",
        inventoryFullBehavior,
        dropItemName: inventoryFullBehavior === "drop" ? itemName : undefined,
        bankItemName: inventoryFullBehavior === "bank" ? itemName : undefined,
        eatAtHpPercent: 35,
        executionMode: "dry_run",
      },
      stopConditions: [
        `${quantity} ${itemName} acquired`,
        inventoryFullBehavior === "drop"
          ? "inventory full and selected item cannot be dropped"
          : inventoryFullBehavior === "bank"
            ? "inventory full and bank is not open"
            : "inventory full",
        "RuneLite client unavailable",
        "survival guard cannot find food when needed",
      ],
      successCriteria: [`Inventory gains ${quantity} ${itemName}`],
    };
  }

  if (text.includes("travel") || text.includes("navigate") || text.includes("walk to")) {
    const destination = inferDestination(goal);
    return {
      horizon: "short_task" as const,
      system1Policy: {
        task: "travel",
        objective: goal,
        destination,
        executionMode: "dry_run",
      },
      stopConditions: [
        "destination reached",
        "route unavailable in transport graph",
        "RuneLite client unavailable for movement",
        "navigation step blocked by current local scene",
      ],
      successCriteria: [`System 1 route is planned toward ${destination}`],
    };
  }

  if (text.includes("chicken") || text.includes("combat") || text.includes("kill") || text.includes("attack")) {
    return {
      horizon: "short_task" as const,
      system1Policy: {
        task: "combat",
        objective: goal,
        targetName: text.includes("chicken") ? "Chicken" : undefined,
        targetType: "npc",
        actionOption: "Attack",
        eatAtHpPercent: 35,
        executionMode: "dry_run",
      },
      stopConditions: [
        "target unavailable",
        "hitpoints safety threshold reached without food",
        "combat engagement validated or blocked",
      ],
      successCriteria: ["System 1 validates and dispatches safe combat interactions only"],
    };
  }

  return {
    horizon: "multi_stage_goal" as const,
    system1Policy: {
      task: "strategy_only",
      objective: goal,
      executionMode: "dry_run",
      maxTicks: 1,
    },
    stopConditions: ["No concrete Reflex Engine policy inferred from goal"],
    successCriteria: ["A precise blocker or required observation is reported before execution"],
  };
}

function firstNumber(text: string) {
  const match = text.match(/\b(\d{1,4})\b/);
  return match ? Number(match[1]) : undefined;
}

function miningItemNameFromGoal(text: string) {
  if (text.includes("tin")) {
    return "Tin ore";
  }
  if (text.includes("copper")) {
    return "Copper ore";
  }
  if (text.includes("iron")) {
    return "Iron ore";
  }
  if (text.includes("coal")) {
    return "Coal";
  }
  if (text.includes("clay")) {
    return "Clay";
  }
  if (text.includes("silver")) {
    return "Silver ore";
  }
  if (text.includes("gold")) {
    return "Gold ore";
  }
  if (text.includes("mithril")) {
    return "Mithril ore";
  }
  if (text.includes("adamant")) {
    return "Adamantite ore";
  }
  if (text.includes("runite") || text.includes("rune ore")) {
    return "Runite ore";
  }
  return "Tin ore";
}

function inferDestination(goal: string) {
  const match = goal.match(/\b(?:travel|navigate|walk)\s+(?:to\s+)?(.+)$/i);
  return match?.[1]?.trim() || goal;
}

function compactContextForQwen(context: StrategistContext) {
  return {
    goal: context.goal,
    system1: context.system1,
    observation: compactUnknown(context.observation, 4000),
    reflexStatus: compactUnknown(context.reflexStatus, 2000),
    knowledge: compactUnknown(context.knowledge, 6000),
    wikiSearch: compactUnknown(context.wikiSearch, 3000),
    memoryLessons: compactUnknown(context.memoryLessons, 3000),
    memoryProfile: compactUnknown(context.memoryProfile, 2000),
  };
}

async function gatherWikiSearchContext(
  options: StrategistDraftOptions,
  config: BrainConfig,
  localKnowledge: { knowledge: unknown; method: unknown }
) {
  const mode = options.wikiSearch ?? "auto";
  if (mode === "off") {
    return {
      status: "WIKI_SEARCH_SKIPPED",
      reason: "disabled_by_request",
    };
  }

  if (!config.tavilyApiKey) {
    return {
      status: "WIKI_SEARCH_UNCONFIGURED",
      reason: "TAVILY_API_KEY is not configured",
    };
  }

  if (mode === "auto" && !shouldSearchWiki(options.goal, localKnowledge)) {
    return {
      status: "WIKI_SEARCH_SKIPPED",
      reason: "local_knowledge_available",
    };
  }

  try {
    const results = await searchOsrsWiki({ query: options.goal, maxResults: 5 }, config);
    return {
      status: "WIKI_SEARCH_RESULTS",
      query: options.goal,
      resultCount: results.length,
      results,
    };
  } catch (error: any) {
    return {
      status: "WIKI_SEARCH_FAILURE",
      query: options.goal,
      message: error?.message ?? String(error),
    };
  }
}

function shouldSearchWiki(goal: string, localKnowledge: { knowledge: unknown; method: unknown }) {
  const localResultCount = Number((localKnowledge.knowledge as any)?.results?.length ?? 0);
  const methodStatus = String((localKnowledge.method as any)?.status ?? "");
  if (localResultCount <= 1 || /not_found|missing|unavailable|unknown/i.test(methodStatus)) {
    return true;
  }

  return /\b(quest|diary|achievement|boss|minigame|clue|puzzle|spell|magic|fishing|firemaking|smithing|crafting|herblore|construction|slayer)\b/i.test(goal);
}

function isRiskyGoal(goal: string) {
  return /\b(combat|fight|kill|attack|dragon|pvp|wilderness|boss|danger|risk)\b/i.test(goal);
}

function cleanTarget(target: { port?: number; instanceId?: string; playerName?: string }) {
  return Object.fromEntries(Object.entries(target).filter(([, value]) => value !== undefined));
}

async function callJsonTool(client: any, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return parseJsonText(extractText(result), name);
}

async function readJsonResource(client: any, uri: string) {
  try {
    const result = await client.readResource({ uri });
    const text = result?.contents?.find((item: any) => typeof item.text === "string")?.text;
    return text ? parseJsonText(text, uri) : { status: "RESOURCE_EMPTY", uri };
  } catch (error: any) {
    return { status: "RESOURCE_UNAVAILABLE", uri, reason: error?.message ?? String(error) };
  }
}

function extractText(result: any) {
  const text = result?.content?.find((item: any) => item.type === "text")?.text;
  if (typeof text !== "string") {
    throw new Error(`Expected text content, got ${JSON.stringify(result)}`);
  }
  return text;
}

function parseJsonText(text: string, label: string) {
  try {
    return JSON.parse(text);
  } catch (error: any) {
    return { status: "NON_JSON_TEXT", label, text: text.slice(0, 1000), parseError: error?.message ?? String(error) };
  }
}

function compactUnknown(value: unknown, maxChars: number) {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) {
    return value;
  }
  return {
    truncated: true,
    maxChars,
    preview: text.slice(0, maxChars),
  };
}
