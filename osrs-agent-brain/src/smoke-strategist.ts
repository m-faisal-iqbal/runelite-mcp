import { draftStrategistPolicy, issueSystem1Policy } from "./strategist.js";

const draft = await draftStrategistPolicy({
  goal: `chop 5 normal tree logs nearest to the player smoke ${Date.now()}`,
  live: false,
  useQwen: false,
  wikiSearch: "off",
});

if (draft.source !== "local_scaffold_no_qwen") {
  console.error(JSON.stringify({ status: "FAIL", reason: "SMOKE_SHOULD_NOT_CALL_QWEN", source: draft.source }, null, 2));
  process.exit(1);
}

if (typeof draft.policy === "string") {
  console.error(JSON.stringify({ status: "FAIL", reason: "EXPECTED_STRUCTURED_POLICY" }, null, 2));
  process.exit(1);
}

if (draft.policy.system1Policy.task !== "chop_logs") {
  console.error(JSON.stringify({ status: "FAIL", reason: "EXPECTED_CHOP_LOGS_POLICY", policy: draft.policy }, null, 2));
  process.exit(1);
}

if (draft.policy.system1Policy.quantityMode !== "gain") {
  console.error(JSON.stringify({ status: "FAIL", reason: "EXPECTED_GAIN_QUANTITY_MODE", policy: draft.policy }, null, 2));
  process.exit(1);
}

if (!draft.policy.allowedSystem1Capabilities.includes("load_policy")) {
  console.error(JSON.stringify({ status: "FAIL", reason: "MISSING_LOAD_POLICY_CAPABILITY" }, null, 2));
  process.exit(1);
}

const forbidden = draft.policy.steps
  .map((step) => step.preferredSystem1Capability)
  .filter((capability) => capability.includes("click") || capability.includes("invoke") || capability.includes("mouse"));

if (forbidden.length > 0) {
  console.error(JSON.stringify({ status: "FAIL", reason: "RAW_CAPABILITY_IN_POLICY_STEPS", forbidden }, null, 2));
  process.exit(1);
}

const issued = await issueSystem1Policy(draft.policy.system1Policy, {
  start: false,
  cleanup: true,
});

if ((issued.loadResult as any)?.status !== "POLICY_LOADED") {
  console.error(JSON.stringify({ status: "FAIL", reason: "LOAD_POLICY_FAILED", issued }, null, 2));
  process.exit(1);
}

if ((issued.reflexStatus as any)?.activePolicy?.status !== "loaded") {
  console.error(JSON.stringify({ status: "FAIL", reason: "REFLEX_STATUS_NOT_LOADED", issued }, null, 2));
  process.exit(1);
}

if ((draft.context.memoryLessons as any)?.status !== "MEMORY_LESSONS") {
  console.error(JSON.stringify({ status: "FAIL", reason: "MEMORY_LESSONS_NOT_RETRIEVED", memoryLessons: draft.context.memoryLessons }, null, 2));
  process.exit(1);
}

let rawPolicyRejected = false;
try {
  await issueSystem1Policy({
    steps: [{ tool: "invoke_menu_action", arguments: { menuAction: "WALK" } }],
  }, {
    start: false,
    cleanup: true,
  });
} catch (error) {
  rawPolicyRejected = String(error instanceof Error ? error.message : error).includes("raw action");
}

if (!rawPolicyRejected) {
  console.error(JSON.stringify({ status: "FAIL", reason: "RAW_SYSTEM1_POLICY_NOT_REJECTED" }, null, 2));
  process.exit(1);
}

const miningDraft = await draftStrategistPolicy({
  goal: `mine 1 tin ore nearest to the player smoke ${Date.now()}`,
  live: false,
  useQwen: false,
  wikiSearch: "off",
});

if (typeof miningDraft.policy === "string") {
  console.error(JSON.stringify({ status: "FAIL", reason: "EXPECTED_STRUCTURED_MINING_POLICY" }, null, 2));
  process.exit(1);
}

if (miningDraft.policy.system1Policy.task !== "mine_tin" ||
  miningDraft.policy.system1Policy.itemName !== "Tin ore" ||
  miningDraft.policy.system1Policy.quantityMode !== "gain" ||
  miningDraft.policy.system1Policy.method !== "mining") {
  console.error(JSON.stringify({ status: "FAIL", reason: "EXPECTED_MINE_TIN_GAIN_POLICY", policy: miningDraft.policy }, null, 2));
  process.exit(1);
}

const issuedMining = await issueSystem1Policy(miningDraft.policy.system1Policy, {
  start: false,
  cleanup: true,
});

if ((issuedMining.loadResult as any)?.status !== "POLICY_LOADED") {
  console.error(JSON.stringify({ status: "FAIL", reason: "LOAD_MINING_POLICY_FAILED", issuedMining }, null, 2));
  process.exit(1);
}

const draftCache = draft.cache;
if (!draftCache || draftCache.status !== "STRATEGY_CACHED" || draftCache.stored !== true) {
  console.error(JSON.stringify({ status: "FAIL", reason: "EXPECTED_STRATEGY_CACHE_STORE", cache: draft.cache }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: "PASS",
  source: draft.source,
  cacheStatus: draftCache.status,
  memoryLessonCount: (draft.context.memoryLessons as any)?.lessons?.length ?? 0,
  observedStatus: (draft.context.observation as any)?.status,
  policyId: draft.policy.policyId,
  system1Task: draft.policy.system1Policy.task,
  system1QuantityMode: draft.policy.system1Policy.quantityMode,
  system1ExecutionMode: draft.policy.system1Policy.executionMode,
  miningTask: miningDraft.policy.system1Policy.task,
  miningQuantityMode: miningDraft.policy.system1Policy.quantityMode,
  issuedMiningStatus: (issuedMining.loadResult as any)?.status,
  issuedStatus: (issued.loadResult as any)?.status,
  reflexStatusAfterIssue: (issued.reflexStatus as any)?.activePolicy?.status,
  forbiddenRawToolsDetected: draft.context.system1.forbiddenRawToolsPresent.length,
  rawPolicyRejected,
}, null, 2));
