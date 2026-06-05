import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { BrainConfig } from "./config.js";
import { getBrainConfig } from "./config.js";

export type BrainMcpConnection = {
  client: Client;
  enableSystem1Logs: () => void;
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
  let showSystem1Logs = true;

  transport.stderr?.on("data", (chunk: Buffer) => {
    if (showSystem1Logs) {
      const text = chunk.toString();
      // Pretty-print Reflex Engine log lines to stdout so they interleave visibly
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        if (line.startsWith("[Reflex Engine]")) {
          // Reformat for clearer display
          const formatted = line
            .replace("[Reflex Engine] [POLICY_LOADED]", "  🟢 [S1] Policy loaded")
            .replace("[Reflex Engine] [POLICY_STARTED]", "  ▶️  [S1] Policy started")
            .replace("[Reflex Engine] [POLICY_COMPLETED]", "  ✅ [S1] Policy completed")
            .replace("[Reflex Engine] [POLICY_BLOCKED]", "  🔴 [S1] Policy BLOCKED")
            .replace("[Reflex Engine] [POLICY_STOPPED]", "  ⏹️  [S1] Policy stopped")
            .replace("[Reflex Engine] [POLICY_PAUSED]", "  ⏸️  [S1] Policy paused")
            .replace("[Reflex Engine] [STEP_RESULT]", "  🔧 [S1] Step result")
            .replace("[Reflex Engine] [TICK_STALLED]", "  ⏳ [S1] Tick stalled")
            .replace(/\[Reflex Engine\] \[TICK (\d+)\] (.+)/, "  🔄 [S1] Tick $1: $2");
          console.log(formatted);
        } else {
          process.stderr.write(line + "\n");
        }
      }
    }
  });

  await client.connect(transport);
  let closed = false;

  return {
    client,
    enableSystem1Logs: () => { showSystem1Logs = true; },
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
