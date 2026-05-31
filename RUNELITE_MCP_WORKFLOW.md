# OSRS MCP Local Workflow

This project has two parts:

- RuneLite plugin: exposes the local HTTP API from inside RuneLite.
- TypeScript MCP server: Codex starts this over stdio from `C:\Users\Faisal Iqbal\.codex\config.toml`.

## Build And Install

- `Build-OSRS-MCP.bat`
  Builds the RuneLite plugin jar and TypeScript MCP server. It does not start or close RuneLite.

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
- Prefer `interact_with` for named object/NPC/player/ground-item interactions. It opens the context menu, then invokes the selected RuneLite menu action in-client using the real menu params.
- `click_object`, `click_npc`, and `click_ground_item` accept an optional `option`; when set, they use the same hybrid `interact_with` path instead of a blind screen click.
- `walk_to` now tries a loaded-scene in-client WALK action first in `auto` mode, then falls back to minimap click for farther tiles.
- Use `invoke_menu_action`, `invoke_walk_action`, and `invoke_widget_action` directly only when you already have or are deliberately testing raw RuneLite action params. Prefer `dryRun: true` first.
- Click tools refuse stale coordinates and hidden/minimized canvases.
- Prefer `click_object`, `click_npc`, `click_ground_item`, `click_inventory_slot`, `walk_to`, and `click_minimap_tile` over raw `move_mouse_and_click`.
- Use `get_minimap` and `get_camera` to inspect orientation, map angle, minimap zoom, and viewport context before tricky navigation.
- Use `calculate_path_to` to inspect bounded straight-line minimap steps before navigation, then `walk_path_to` to click only the next step.
- After any click or walk, use `wait_until_idle`, `wait_until_location`, or `wait_for_chat_message` to verify what happened before choosing the next action.
- Prefer `use_inventory_item_on_object`, `use_inventory_item_on_npc`, and `use_inventory_item_on_inventory_item` for item-use flows instead of manually chaining raw item and target clicks.
- Prefer `right_click_npc`, `right_click_object`, `right_click_ground_item`, then `select_option` for actions that need a RuneLite context menu; `select_option` uses in-client action params when RuneLite exposes them.
- Use `get_combat`/`click_special_attack` for combat controls and `get_shop`/`buy_item`/`sell_item` for shop interactions.
- Use `get_bank_actions`, then `withdraw_bank_item` or `deposit_inventory_item` while the bank UI is open so item actions use visible bank/inventory widget coordinates.
- Use the hover tools or `npm run verify:coords -- --port 8081 --type npc --name "Sir Prysin" --source convexHull --hover` to verify coordinates without clicking.
