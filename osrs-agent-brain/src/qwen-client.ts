import OpenAI from "openai";
import type { BrainConfig } from "./config.js";
import { getBrainConfig } from "./config.js";
import { STRATEGIST_SYSTEM_PROMPT } from "./system-prompt.js";

export function createQwenClient(config: BrainConfig = getBrainConfig()): OpenAI {
  if (!config.qwenApiKey) {
    throw new Error("QWEN_API_KEY is required before the Strategist can call Qwen.");
  }

  return new OpenAI({
    apiKey: config.qwenApiKey,
    baseURL: config.qwenBaseUrl
  });
}

export function qwenErrorMessage(error: unknown, config: BrainConfig): string {
  const record = error as Record<string, unknown>;
  const status = record?.status ?? record?.["statusCode"] ?? record?.["code"];
  const message = error instanceof Error ? error.message : String(error);
  const details = [
    `message=${message}`,
    `model=${config.qwenModel}`,
    `baseUrl=${config.qwenBaseUrl}`,
    `apiKeySource=${config.qwenApiKeySource ?? "missing"}`,
  ];

  if (status) {
    details.unshift(`status=${String(status)}`);
  }
  if (String(status) === "401" || message.includes("401")) {
    details.push("hint=The configured QWEN_API_KEY is missing/invalid for this Qwen-compatible endpoint, or the key belongs to a different region/workspace.");
  }

  return `Qwen Responses API request failed (${details.join(", ")}).`;
}

export async function draftPolicyOnce(goal: string, compactContext: unknown, config: BrainConfig = getBrainConfig()): Promise<string> {
  const qwen = createQwenClient(config);
  const response = await (qwen as any).responses.create({
    model: config.qwenModel,
    instructions: STRATEGIST_SYSTEM_PROMPT,
    input: JSON.stringify({
      goal,
      compactContext,
      instruction: "Return one strategist policy JSON object. Do not call low-level action tools."
    }),
    parallel_tool_calls: true,
  });

  return response.output_text ?? collectResponseText(response);
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
