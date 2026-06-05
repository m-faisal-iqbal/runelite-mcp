import { execSync } from "node:child_process";
import { platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const brainRoot = path.resolve(sourceDir, "..");
export const repoRoot = path.resolve(brainRoot, "..");

export type BrainConfig = {
  mcpServerPath: string;
  mcpServerCwd: string;
  qwenApiKey?: string;
  qwenApiKeySource?: "QWEN_API_KEY";
  qwenBaseUrl: string;
  qwenModel: string;
  tavilyApiKey?: string;
};

export function readEnvVar(name: string): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) {
    return direct;
  }

  if (platform() !== "win32") {
    return undefined;
  }

  for (const hive of [
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ]) {
    try {
      const output = execSync(`reg query "${hive}" /v ${name}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const match = output.match(new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)`, "i"));
      const value = match?.[1]?.trim();
      if (value) {
        process.env[name] = value;
        return value;
      }
    } catch {
      // Variable not defined in this hive.
    }
  }

  return undefined;
}

export function getBrainConfig(): BrainConfig {
  const defaultMcpServerPath = path.resolve(repoRoot, "osrs-mcp-server", "build", "index.js");
  const mcpServerPath = path.resolve(process.env.OSRS_MCP_SERVER_PATH ?? defaultMcpServerPath);
  const qwenApiKey = readEnvVar("QWEN_API_KEY");
  const tavilyApiKey = readEnvVar("TAVILY_API_KEY");

  return {
    mcpServerPath,
    mcpServerCwd: path.dirname(mcpServerPath),
    qwenApiKey,
    qwenApiKeySource: qwenApiKey ? "QWEN_API_KEY" : undefined,
    qwenBaseUrl: readEnvVar("QWEN_BASE_URL") ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    qwenModel: readEnvVar("QWEN_MODEL") ?? "qwen3.7-plus",
    tavilyApiKey,
  };
}
