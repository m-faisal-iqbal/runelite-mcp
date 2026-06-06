# OSRS RuneLite MCP

Local MCP bridge for controlling Old School RuneScape through official RuneLite.

The project has two pieces:

- `osrs-mcp-plugin`: a RuneLite plugin that exposes local HTTP endpoints on `localhost:8080` through `localhost:8090`.
- `osrs-mcp-server`: a TypeScript MCP server that Codex starts over stdio and exposes OSRS tools, resources, and prompts.

## Safety And Development Scope

This repository should be developed as a **human