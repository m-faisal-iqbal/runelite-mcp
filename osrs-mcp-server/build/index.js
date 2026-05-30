import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import { mouse, Point, keyboard, Key } from "@nut-tree-fork/nut-js";
const configuredMouseSpeed = Number(process.env.OSRS_MOUSE_SPEED ?? "300");
mouse.config.mouseSpeed = Number.isFinite(configuredMouseSpeed) && configuredMouseSpeed > 0
    ? configuredMouseSpeed
    : 300;
const server = new McpServer({
    name: "osrs-mcp-server",
    version: "1.0.0",
});
const RUNELITE_API = "http://localhost:8080/api";
// --- State Reading Tools ---
server.tool("get_game_state", "Get current player state, location, and health", {}, async () => {
    try {
        const res = await axios.get(`${RUNELITE_API}/state`);
        return {
            content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error fetching state: ${e.message}` }] };
    }
});
server.tool("get_inventory", "Get the items currently in the player's inventory", {}, async () => {
    try {
        const res = await axios.get(`${RUNELITE_API}/inventory`);
        return {
            content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error fetching inventory: ${e.message}` }] };
    }
});
server.tool("get_npcs", "Get a list of nearby NPCs with canvas coordinates and absolute desktop screen coordinates", {}, async () => {
    try {
        const res = await axios.get(`${RUNELITE_API}/npcs`);
        return {
            content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error fetching NPCs: ${e.message}` }] };
    }
});
server.tool("get_dialogue", "Check for open NPC dialogues, player dialogues, or dialogue options with absolute desktop screen coordinates when clickable", {}, async () => {
    try {
        const res = await axios.get(`${RUNELITE_API}/dialogue`);
        return {
            content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error fetching dialogue: ${e.message}` }] };
    }
});
server.tool("get_game_objects", "Get a list of interactable game objects (trees, doors, rocks) with names and absolute desktop screen coordinates", {}, async () => {
    try {
        const res = await axios.get(`${RUNELITE_API}/objects`);
        return {
            content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error fetching game objects: ${e.message}` }] };
    }
});
server.tool("get_ground_items", "Get a list of items dropped on the ground with names and absolute desktop screen coordinates", {}, async () => {
    try {
        const res = await axios.get(`${RUNELITE_API}/grounditems`);
        return {
            content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error fetching ground items: ${e.message}` }] };
    }
});
server.tool("get_bank", "Get all items currently in the player's bank (if the bank interface is open)", {}, async () => {
    try {
        const res = await axios.get(`${RUNELITE_API}/bank`);
        return {
            content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error fetching bank: ${e.message}` }] };
    }
});
server.tool("get_equipment", "Get all items currently equipped by the player", {}, async () => {
    try {
        const res = await axios.get(`${RUNELITE_API}/equipment`);
        return {
            content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error fetching equipment: ${e.message}` }] };
    }
});
server.tool("get_skills", "Get the player's level, boosted level, and XP for all 23 skills", {}, async () => {
    try {
        const res = await axios.get(`${RUNELITE_API}/skills`);
        return {
            content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error fetching skills: ${e.message}` }] };
    }
});
// --- Action Tools (OS-Level) ---
server.tool("move_mouse_and_click", "Moves the hardware mouse to an absolute desktop screen X/Y coordinate and clicks. Use screenX/screenY from RuneLite API results, not canvasX/canvasY.", {
    x: z.number().describe("The absolute desktop screen X coordinate, usually a screenX value from the RuneLite API"),
    y: z.number().describe("The absolute desktop screen Y coordinate, usually a screenY value from the RuneLite API"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click")
}, async ({ x, y, rightClick }) => {
    try {
        await mouse.setPosition(new Point(x, y));
        if (rightClick) {
            await mouse.rightClick();
        }
        else {
            await mouse.leftClick();
        }
        return {
            content: [{ type: "text", text: `Successfully moved mouse to ${x}, ${y} and clicked.` }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error moving mouse: ${e.message}` }] };
    }
});
server.tool("type_text", "Types text using the hardware keyboard. Useful for naming character, entering bank pins, or chatting.", {
    text: z.string().describe("The text to type"),
    pressEnter: z.boolean().optional().describe("Whether to press Enter after typing")
}, async ({ text, pressEnter }) => {
    try {
        await keyboard.type(text);
        if (pressEnter) {
            await keyboard.type(Key.Enter);
        }
        return {
            content: [{ type: "text", text: `Successfully typed: "${text}"` }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error typing text: ${e.message}` }] };
    }
});
server.tool("press_key", "Press a specific key on the keyboard, like 'Space' (often used to continue dialogue) or 'Escape'.", {
    keyName: z.string().describe("The name of the key to press (e.g., 'Space', 'Escape', 'Enter')")
}, async ({ keyName }) => {
    try {
        let k;
        switch (keyName.toLowerCase()) {
            case 'space':
                k = Key.Space;
                break;
            case 'escape':
                k = Key.Escape;
                break;
            case 'enter':
                k = Key.Enter;
                break;
            default: return { content: [{ type: "text", text: `Unsupported key: ${keyName}` }] };
        }
        await keyboard.type(k);
        return {
            content: [{ type: "text", text: `Successfully pressed key: ${keyName}` }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error pressing key: ${e.message}` }] };
    }
});
// --- Start Server ---
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("OSRS MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
});
