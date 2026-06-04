import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { BrainConfig } from "./config.js";
import { getBrainConfig } from "./config.js";

export type BrainMcpConnection = {
  client: Client;
  close: () => Promise<void>;
};

export async function connectToSystem1(config: BrainConfig = getBrainConfig()): Promise<BrainMcpConnection> {
  if (!existsSync(config.mcpServerPath)) {
    throw new Error(`MCP server build not found at ${config.mcpServerPath}. Run npm run build in osrs-mcp-server first.`);
  }

  const client = new Client({
    name: "osrs-agent-brain",
    version: "0.1.0"
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [config.mcpServerPath],
    cwd: config.mcpServerCwd,
    stderr: "pipe",
    env: {
      ...process.env,
      OSRS_MCP_CLIENT: "osrs-agent-brain"
    }
  });
  transport.stderr?.on("data", () => {
    // Keep smoke output machine-readable; stderr is still available by changing this handler during debugging.
  });

  await client.connect(transport);
  let closed = false;

  return {
    client,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  };
}

export async function inspectSystem1(config: BrainConfig = getBrainConfig()) {
  const connection = await connectToSystem1(config);
  try {
    const [tools, resources] = await Promise.all([
      connection.client.listTools(),
      connection.client.listResources()
    ]);

    return {
      serverPath: config.mcpServerPath,
      toolCount: tools.tools.length,
      resourceCount: resources.resources.length,
      toolNames: tools.tools.map((tool) => tool.name).sort(),
      resourceUris: resources.resources.map((resource) => resource.uri).sort()
    };
  } finally {
    await connection.close();
  }
}
