# OSRS Agent Brain

System 2 for the Twin-Brain OSRS agent.

The existing `osrs-mcp-server` is System 1: the local Reflex Engine that owns fast game-tick execution, safety guards, pathing, verification, and all raw input primitives.

This package is System 2: a bounded strategist process. It connects to the MCP server, gathers compact observations and knowledge, asks Qwen for strategy when needed, and emits policies for System 1. It does not click, type, call raw invoke tools, or run LLM-controlled action loops.

## Environment

- `QWEN_API_KEY`: required only when asking Qwen for a strategy.
- `QWEN_BASE_URL`: optional. Defaults to `https://dashscope.aliyuncs.com/compatible-mode/v1`.
- `QWEN_MODEL`: optional. Defaults to `qwen-plus`.
- `OSRS_MCP_SERVER_PATH`: optional. Defaults to `../osrs-mcp-server/build/index.js`.
- `TAVILY_API_KEY`: reserved for the future OSRS Wiki search tool.

## Scripts

- `npm run build`: type-check and compile.
- `npm run smoke:mcp`: start the existing MCP server over stdio, list tools/resources, and confirm the Brain can connect.
- `npm run smoke:prompt`: confirm the strategist prompt contains the hard policy-only guardrails.
- `npm run dev -- --mcp-smoke`: run the same bounded MCP handshake from the Brain entrypoint.

No script here starts an LLM execution loop. The Brain is a strategist, not a clicker.
