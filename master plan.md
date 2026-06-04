# 🧠 OSRS Cognitive Generalist Agent: Master Implementation Plan

## 🏗️ Architectural Paradigm: The Twin-Brain System
We are shifting from an "LLM-in-the-loop" execution model to a **Twin-Brain Cognitive Architecture**. 

1. **System 1 (The Predictive Game Engine / PGE):** A local, ultra-fast TypeScript/Java engine inside the MCP server. It executes micro-loops (chopping, combat, eating, walking, ...) at the 600ms OSRS tick speed *without* calling the LLM. It handles reflexes, survival guards, and pathfinding.
2. **System 2 (The Agent Brain):** A standalone Node.js application (`osrs-agent-brain`) that connects to our MCP server as an MCP Client. It uses the **Qwen 3.7 Plus API** to act as the high-level Strategist. It plans, queries the Grimoire, handles anomalies, and issues "Policies" to System 1.

**Current Status:** Phases 0-5 of the previous infrastructure plan are complete (Runtime, In-Client Actions, Memory, Knowledge, Semantic UI). We are now pivoting to the Cognitive Execution layer.

---

## 🚀 Phase 1: The Reflex Engine (System 1 Core)
**Goal:** Build the local execution engine that replaces LLM-driven `while` loops.
- [ ] **Create `src/engine/ReflexEngine.ts`:** A background loop synced to the OSRS game tick (600ms).
- [ ] **Policy Executor:** Instead of the LLM calling `click_tree`, the LLM issues a policy: `load_policy({ task: "chop_oak", eat_at_hp: 40 })`. The PGE executes this locally using existing `invoke_menu_action` tools.
- [ ] **Survival Guards (Interrupts):** Hardcode local checks that run *every tick* before the main policy:
  - `IF HP < threshold AND inventory.has(food) -> eat()`
  - `IF inventory_full -> execute_banking_policy()`
- [ ] **Threat Interrupts:** `IF minimap.has_red_dot() -> drop_valuables() -> teleport()`.
- **Acceptance Test:** The AI can chop trees and automatically eat food when HP drops, with zero LLM API calls during the loop.

## 🗺️ Phase 2: Global Navigation & Active Perception
**Goal:** Give System 1 the ability to move and see without bothering System 2.
- [ ] **Transport Graph (`graphology`):** Build `world_graph.json` containing major OSRS locations and edges (Walking, Teleports, Fairy Rings, ...). Implement Dijkstra's algorithm in `navigate_to(destination)`.
- [ ] **Minimap POI Reader:** Add `GET /api/minimap/icons` to the Java plugin to extract semantic map icons (Banks, Altars, Red Dots/Players, ...).
- [ ] **Active Perception Tools:** Replace full JSON dumps with focused tools: `perceive_minimap()`, `perceive_chat()`, `perceive_ui_region()`.
- **Acceptance Test:** The PGE can calculate and walk a route from Lumbridge to Varrock West Bank using the Transport Graph, avoiding obstacles, without LLM intervention.

## 🧠 Phase 3: The Agent Brain Scaffold (System 2)
**Goal:** Build the standalone Qwen 3.7 Plus Strategist application.
- [ ] **Scaffold `osrs-agent-brain`:** Create a new Node.js/TypeScript directory at the repo root.
- [ ] **MCP Client Integration:** Install `@modelcontextprotocol/sdk` to connect to the existing `osrs-mcp-server` via stdio/HTTP.
- [ ] **Qwen API Integration:** Install `openai` SDK. Configure it to use `QWEN_API_KEY` (from Windows Env Vars) pointing to the Qwen Cloud Models API base URL.
- [ ] **System Prompt Engineering:** Write a strict System Prompt for Qwen 3.7 Plus defining it as the "OSRS Generalist Strategist". It must know it *does not click things*; it queries the `knowledge_*` tools and outputs JSON Policies for System 1.
- [ ] **Tavily Web Search Tool:** Add a custom MCP tool using the `tavily` npm package so Qwen can search the live OSRS Wiki if the local Grimoire lacks information.
- **Acceptance Test:** The Brain can connect to the MCP server, read the player's current state, query the Grimoire for "How to get 50 Magic or how to get 20 fishing, firemaking and woodcutting, or complete draynor saylor 1 quest", and output a structured milestone plan.

## 📚 Phase 4: Episodic Memory & Strategy Caching
**Goal:** Enable true machine learning and token-saving.
- [ ] **Strategy Cache:** Add a SQLite table `strategy_cache`. If System 1 successfully completes a "chop oak" policy, cache the exact parameters. Next time, System 2 loads it instantly with zero planning tokens.
- [ ] **Episodic Encoding:** When System 1 fails (e.g., dies to a dragon), format the state/action/outcome into a vector embedding and store it in the Memory Ledger.
- [ ] **Memory Retrieval:** Before System 2 plans a dangerous task, it must query the Memory DB for similar past failures to avoid repeating them.
- **Acceptance Test:** The AI fails a task, logs the lesson ("Need anti-fire potion"), and automatically withdraws the potion from the bank on the next attempt without being explicitly told.

## ⚔️ Phase 5: Domain Mastery & Expert Policies
**Goal:** Execute meta-game tactics that separate bots from experts.
- [ ] **Combat State Machine:** Implement prayer flicking, tick-eating, and safe-spotting logic inside the PGE.
- [ ] **Tick-Manipulation Policies:** Implement "3-Tick Mining" and "2-Tick Scimitar" policies that queue the next action before the server confirms the current one.
- [ ] **Algorithmic Puzzle Solvers:** Write deterministic TypeScript solvers for Puzzle Boxes and Maze widgets (bypassing the LLM entirely).
- **Acceptance Test:** The AI can mine gold ore at the Crafting Guild/any place that avaviable for current account using 3-tick mechanics, achieving near-theoretical maximum XP/hr.

## 💻 Phase 6: The Command Interface
**Goal:** Give the user a way to command the Brain.
- [ ] **Chat UI:** Scaffold a simple local web UI (using Next.js + Vercel AI SDK or Chainlit) inside `osrs-agent-brain`.
- [ ] **Goal Ingestion:** Allow the user to type high-level goals (e.g., "Start a new account, do Tutorial Island, then get 50 Magic, then get 10 quest point choose quest that gave more points").
- [ ] **Telemetry Dashboard:** Display the Brain's current thought process, the active System 1 Policy, and the Memory/Inventory state in real-time.
- **Acceptance Test:** User types a goal in the UI -> Brain plans -> PGE executes -> UI updates with progress.

---

## ⚙️ Environment & API Configuration
- **LLM Provider:** Qwen Cloud Models API (Qwen 3.7 Plus). OpenAI-compatible SDK and you can use best option mean what you think is best like response api and other options you can explore SDK and use best feature that fit our case.
- **API Key:** Stored in Windows Environment Variables as `QWEN_API_KEY`.
- **Web Search:** Tavily API (Free tier). Key stored as `TAVILY_API_KEY` in Stored in Windows Environment Variables or you can also Connect directly to Tavily's remote MCP server by this url: https://mcp.tavily.com/mcp/?tavilyApiKey=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
- **Execution Rule:** The LLM (System 2) is strictly forbidden from calling raw `click_*` or `invoke_*` tools directly. It must only call `navigate_to`, `knowledge_query`, and `load_policy`.

## 🛑 Hard Rules for Codex (The AI Builder)
1. **DO NOT** build any more LLM-centric execution loops (like `agent_run_goal` calling raw click tools).
2. **DO NOT** send full 3000-line JSON snapshots to the Qwen API. Use the Semantic UI and Active Perception tools.
3. **ALL** high-level autonomy must flow through the `osrs-agent-brain` (System 2) issuing policies to the `ReflexEngine` (System 1).
4. **KEEP** the existing `knowledge_*` and `memory_*` tools in the MCP server; the Qwen Brain will use them heavily via MCP.
5. If you think you can do better something or something is missing definitely do you have premissions