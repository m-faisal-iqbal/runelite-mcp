import { getBrainConfig } from "./config.js";
import { runBrainWithResponses } from "./brain.js";
import { inspectSystem1 } from "./mcp-client.js";
import { draftStrategistPolicy, issueSystem1Policy } from "./strategist.js";
import { STRATEGIST_SYSTEM_PROMPT } from "./system-prompt.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const config = getBrainConfig();

  if (args.has("--print-system-prompt")) {
    console.log(STRATEGIST_SYSTEM_PROMPT);
    return;
  }

  if (args.has("--mcp-smoke")) {
    const inspection = await inspectSystem1(config);
    console.log(JSON.stringify(inspection, null, 2));
    return;
  }

  const goal = argValue("--goal");
  if (goal) {
    if (args.has("--responses-brain") || args.has("--use-qwen")) {
      const result = await runBrainWithResponses({
        goal,
        live: args.has("--live"),
        target: {
          port: argValue("--port") ? Number(argValue("--port")) : undefined,
          instanceId: argValue("--instance-id"),
          playerName: argValue("--player-name"),
        },
        maxToolRounds: argValue("--max-tool-rounds") ? Number(argValue("--max-tool-rounds")) : undefined,
      }, config);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const draft = await draftStrategistPolicy({
      goal,
      useQwen: false,
      live: args.has("--live"),
      port: argValue("--port") ? Number(argValue("--port")) : undefined,
      instanceId: argValue("--instance-id"),
      playerName: argValue("--player-name"),
      wikiSearch: args.has("--no-wiki-search") ? "off" : args.has("--wiki-search") ? "force" : "auto",
    }, config);
    if (args.has("--issue-policy")) {
      if (typeof draft.policy === "string") {
        throw new Error("Cannot issue Qwen policy text until it has been parsed into the strategist policy schema.");
      }
      const issued = await issueSystem1Policy(draft.policy.system1Policy, {
        start: args.has("--start-policy"),
        cleanup: !args.has("--keep-policy-loaded"),
      }, config);
      console.log(JSON.stringify({ ...draft, issued }, null, 2));
      return;
    }
    console.log(JSON.stringify(draft, null, 2));
    return;
  }

  console.log(JSON.stringify({
    status: "READY",
    architecture: "Twin-Brain",
    role: "System 2 Strategist",
    mcpServerPath: config.mcpServerPath,
    qwenConfigured: Boolean(config.qwenApiKey),
    qwenApiKeySource: config.qwenApiKeySource,
    qwenBaseUrl: config.qwenBaseUrl,
    qwenModel: config.qwenModel,
    tavilyConfigured: Boolean(config.tavilyApiKey),
    next: "Run npm run smoke:mcp, pass --print-system-prompt, or use --goal \"chop 5 logs\". Add --responses-brain to invoke Qwen function tools."
  }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ status: "ERROR", message }, null, 2));
  process.exitCode = 1;
});
