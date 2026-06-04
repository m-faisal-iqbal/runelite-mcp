import { STRATEGIST_PROMPT_GUARDRAILS, STRATEGIST_SYSTEM_PROMPT } from "./system-prompt.js";

const missing = STRATEGIST_PROMPT_GUARDRAILS.filter((guardrail) => !STRATEGIST_SYSTEM_PROMPT.includes(guardrail));

if (missing.length > 0) {
  console.error(JSON.stringify({ status: "FAIL", reason: "PROMPT_GUARDRAIL_MISSING", missing }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: "PASS",
  guardrailCount: STRATEGIST_PROMPT_GUARDRAILS.length,
  promptLength: STRATEGIST_SYSTEM_PROMPT.length
}, null, 2));
