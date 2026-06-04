import { getBrainConfig } from "./config.js";
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
    const draft = await draftStrategistPolicy({
      goal,
      useQwen: args.has("--use-qwen"),
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
    tavilyConfigured: Boolean(config.tavilyApiKey),
    next: "Run npm run smoke:mcp, pass --print-system-prompt, or use --goal \"chop 5 logs\"."
  }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ status: "ERROR", message }, null, 2));
  process.exitCode = 1;
});
