import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
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

export async function draftPolicyOnce(goal: string, compactContext: unknown, config: BrainConfig = getBrainConfig()): Promise<string> {
  const qwen = createQwenClient(config);
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: STRATEGIST_SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        goal,
        compactContext,
        instruction: "Return one strategist policy JSON object. Do not call low-level action tools."
      })
    }
  ];

  const response = await qwen.chat.completions.create({
    model: config.qwenModel,
    messages
  });

  return response.choices[0]?.message?.content ?? "";
}
