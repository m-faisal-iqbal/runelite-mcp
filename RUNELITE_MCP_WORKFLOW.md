# OSRS MCP Local Workflow

This project has two parts:

- RuneLite plugin: exposes the local HTTP API from inside RuneLite.
- TypeScript MCP server: Codex starts this over stdio from `C:\Users\Faisal Iqbal\.codex\config.toml`.

## Build And Install

- `Build-OSRS-MCP.bat`
  Builds the RuneLite plugin jar and TypeScript MCP server. It does not start or close RuneLite.

- `cd osrs-mcp-server && npm run smoke:mcp`
  Starts the built MCP server over stdio, verifies the expected tools/resources/prompts, calls `observe_game`, `run_agent_cycle`, `execute_agent_step` in dry-run mode, `get_agent_context`, and `diagnose_runtime`, then closes the child process. This does not start or close RuneLite. Add `-- --live` only when a plugin-loaded RuneLite client is already open and should be required.

- `cd osrs-mcp-server && npm run smoke:plugin`
  Checks a running RuneLite plugin over safe HTTP calls: API index, identity feature flags, `/state`, `/snapshot`, `/events`, coordinate diagnostics, and `dryRun: true` action validation. It does not click or invoke actions.

- `cd osrs-mcp-server && npm run smoke:planner`
  Runs synthetic snapshot checks for the pure action planner, including login, woodcutting, dialogue, full-inventory banking, low-HP food safety, and stale-runtime handling.

- `cd osrs-mcp-server && npm run smoke:agent-context`
  Runs synthetic checks for the compact observation bundle returned by `get_agent_context`, `observe_game`, and `run_agent_cycle`.

- `cd osrs-mcp-server && npm run smoke:runtime-modules`
  Runs synthetic checks for client selection and plugin runtime diagnostics after modularization.

- `cd osrs-mcp-server && npm run smoke:navigation`
  Runs synthetic checks for route fallback math, path step selection, and tile-distance behavior.

- `Install-OSRS-MCP-Plugin.bat`
  Builds, then copies the plugin jar to `%USERPROFILE%\.runelite\plugins\osrs-mcp-plugin.jar`.
  It does not start or close RuneLite.

- `Start-OSRS-MCP.bat`
  Builds, then starts RuneLite with the local development plugin classpath only when RuneLite is not already running.
  It does not close an open RuneLite client.

- `Restart-OSRS-MCP.bat`
  Explicit restart path. It warns first, then closes RuneLite and starts the local development plugin classpath.

## Plugin Loading Limitation

Standard RuneLite launcher builds do not always load arbitrary local jars from `%USERPROFILE%\.runelite\plugins`.
When that happens, the copied jar is present but the in-game plugin API will not appear.

The reliable local development path in this project is:

1. Close RuneLite yourself when it is safe for the account.
2. Run `Start-OSRS-MCP.bat`, or use `Restart-OSRS-MCP.bat` when you explicitly want the script to close and relaunch RuneLite.
3. Verify one of these URLs responds:
   - `http://localhost:8080/api/identity`
   - `http://localhost:8081/api/identity`
   - up to `http://localhost:8090/api/identity`

The plugin chooses the first free port from `8080` through `8090`. Use the MCP `list_clients` tool to discover active clients and `select_client` to choose the account/window before clicking.

## Safety Notes

- The scripts do not unexpectedly close RuneLite unless `Restart-OSRS-MCP.bat` or `-RestartRuneLite` is used.
- The Phase 1 action API exposes `/api/action/menu`, `/api/action/walk`, and `/api/action/widget`; all three run on RuneLite's ClientThread.
- Use `diagnose_runtime` after a rebuild/install or after a 404 from a newer endpoint. It reports stale running plugin copies and missing feature endpoints without restarting RuneLite.
- Use `observe_game` for a single read-only perception packet before deciding: compact context, optional conservative plan/package, and optional screenshot metadata/image. It never executes gameplay actions.
- Use `run_agent_cycle` for a single safe control-loop pass: observe, plan, select the next step, and validate it. It returns `willExecute: false` and does not click or invoke actions.
- Use `execute_agent_step` for exactly one validated step. It defaults to dry-run; real execution requires `executionMode: "execute"` and `confirmExecution: "EXECUTE_ONE_STEP"`, captures a baseline by default, and returns post-action verification guidance. For `perform_until` plans it performs one loop interaction only, not the whole loop.
- Use `agent_start_goal`, `agent_status`, `agent_stop`, `agent_pause`, `agent_resume`, and `agent_history` for the Phase 1 in-memory agent gateway. This is a control plane only; full-auto loops arrive in Phase 2.
- Use bounded Universal Activity tools for player-like actions: `skill_interact`, `skill_acquire`, `skill_train`, `skill_travel`, and `skill_combat`. Phase 1 supports log acquisition/woodcutting and simple NPC combat first; broader inventory, economy, and global travel policies return explicit blockers.
- Use `get_agent_context` before planning a gameplay action. It returns one compact orientation bundle with runtime readiness, player state, risks, inventory, nearby targets, dialogue, chat, and recommended next checks.
- Use `plan_next_action` when you want a conservative ordered list of MCP tool calls for the current objective without executing anything. It currently plans common routines for woodcutting, mining, fishing, banking/deposit, dialogue, combat opening, and ground-item pickup.
- Use `prepare_agent_step` when you want the current context plus the next action packaged with safety flags, baseline guidance, and verification guidance. It never executes the action.
- Use `validate_prepared_step` immediately before acting when you need a fresh target check or a plugin `dryRun:true` validation for raw `invoke_*` params. It never executes real gameplay actions.
- MCP resources are available for low-overhead context:
  - `osrs://snapshot/latest`
  - `osrs://events/recent`
  - `osrs://client/identity`
- MCP prompts are available for common play loops: `experienced-player-loop`, `woodcut-and-bank`, `complete-dialogue`, and `withdraw-and-equip`.
- The cached snapshot now includes `prayers`, `combat`, `chat`, and `interfaceSummary` in addition to player/entity/inventory state.
- `/api/events` and `get_recent_events` expose recent plugin hooks such as GameTick, chat, animation changes, item-container changes, and widget loads; pass `eventType` to filter noisy tick events. `/api/stream` now emits both `snapshot` and `events` SSE messages.
- Prefer `interact_with` for named object/NPC/player/ground-item interactions. It opens the context menu, then invokes the selected RuneLite menu action in-client using the real menu params.
- Prefer `handle_dialogue` for NPC/player dialogue loops, `eat_food_when` for threshold-based food safety, and `perform_until` for repeated actions such as chopping/mining until inventory-full or a chat/entity condition.
- Use `mark_action_baseline` before risky actions and `verify_last_action` afterward when you need a concrete snapshot diff, such as inventory quantity, location, dialogue, chat, or entity-count changes.
- `click_object`, `click_npc`, and `click_ground_item` accept an optional `option`; when set, they use the same hybrid `interact_with` path instead of a blind screen click.
- `walk_to` now tries a loaded-scene in-client WALK action first in `auto` mode, then falls back to minimap click for farther tiles.
- Use `get_pathfinding_status` to distinguish current loaded-scene collision-map A* from a future global Shortest Path bridge.
- Use `invoke_menu_action`, `invoke_walk_action`, and `invoke_widget_action` directly only when you already have or are deliberately testing raw RuneLite action params. Prefer `dryRun: true` first. Use `wait_for_game_tick` or `tickAligned: true` when timing-sensitive actions should land just after a fresh OSRS game tick.
- Click tools refuse stale coordinates and hidden/minimized canvases.
- Prefer `click_object`, `click_npc`, `click_ground_item`, `click_inventory_slot`, `walk_to`, and `click_minimap_tile` over raw `move_mouse_and_click`.
- Use `get_minimap` and `get_camera` to inspect orientation, map angle, minimap zoom, and viewport context before tricky navigation.
- Use `get_widgets` with a focused `filter` such as `withdraw`, `deposit`, `exchange`, `quest`, or `continue` when a complex interface needs generic widget ids, actions, bounds, and click coordinates.
- Use `walk_route_to` for multi-step movement to a known tile. Use `calculate_path_to` to inspect local collision-aware path data before navigation, and `walk_path_to` when you want one bounded step.
- After any click or walk, use `verify_after_action` for combined checks, or `wait_until_idle`, `wait_until_location`, and `wait_for_chat_message` for single-condition waits.
- Use `get_screenshot` or `capture_canvas_screenshot` before/after risky actions, or pass `canvasX`/`canvasY` from a target to capture a focused crop around the clickable area.
- OS fallback mouse movement is humanized by default; inspect it with `get_input_profile` and disable with `OSRS_HUMANIZE_MOUSE=false` if coordinate testing needs instant movement.
- Prefer `use_inventory_item_on_object`, `use_inventory_item_on_npc`, and `use_inventory_item_on_inventory_item` for item-use flows instead of manually chaining raw item and target clicks.
- Prefer `right_click_npc`, `right_click_object`, `right_click_ground_item`, then `select_option` for actions that need a RuneLite context menu; `select_option` uses in-client action params when RuneLite exposes them.
- Use `get_combat`/`click_special_attack` for combat controls and `get_shop`/`buy_item`/`sell_item` for shop interactions.
- Use `get_bank_actions`, then `withdraw_bank_item` or `deposit_inventory_item` while the bank UI is open so item actions use visible bank/inventory widget coordinates.
- Use the hover tools or `npm run verify:coords -- --port 8081 --type npc --name "Sir Prysin" --source convexHull --hover` to verify coordinates without clicking.
