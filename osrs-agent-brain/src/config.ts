import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const brainRoot = path.resolve(sourceDir, "..");
export const repoRoot = path.resolve(brainRoot, "..");

export type BrainConfig = {
  mcpServerPath: string;
  mcpServerCwd: string;
  qwenApiKey?: string;
  qwenBaseUrl: string;
  qwenModel: string;
  tavilyApiKey?: string;
};

export function getBrainConfig(): BrainConfig {
  const defaultMcpServerPath = path.resolve(repoRoot, "osrs-mcp-server", "build", "index.js");
  const mcpServerPath = path.resolve(process.env.OSRS_MCP_SERVER_PATH ?? defaultMcpServerPath);

  return {
    mcpServerPath,
    mcpServerCwd: path.dirname(mcpServerPath),
    qwenApiKey: process.env.QWEN_API_KEY,
    qwenBaseUrl: process.env.QWEN_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    qwenModel: process.env.QWEN_MODEL ?? "qwen-plus",
    tavilyApiKey: process.env.TAVILY_API_KEY
  };
}
