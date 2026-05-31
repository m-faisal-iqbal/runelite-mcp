import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import { mouse, Point, keyboard, Key } from "@nut-tree-fork/nut-js";
class StateCache {
    ttlMs;
    apiTimeoutMs;
    entries = new Map();
    constructor(ttlMs, apiTimeoutMs) {
        this.ttlMs = ttlMs;
        this.apiTimeoutMs = apiTimeoutMs;
    }
    status(baseURL) {
        const entry = this.entries.get(baseURL);
        return {
            baseURL,
            cached: Boolean(entry && entry.fetchedAt > 0),
            fetchedAt: entry?.fetchedAt ?? 0,
            cacheAgeMs: entry?.fetchedAt ? Date.now() - entry.fetchedAt : null,
            streamStarted: Boolean(entry?.streamStarted),
            streamSupported: Boolean(entry?.streamSupported),
            streamSupportChecked: Boolean(entry?.streamSupportChecked),
            streamActive: Boolean(entry?.streamActive),
            streamLastEventAt: entry?.streamLastEventAt ?? 0,
            streamAgeMs: entry?.streamLastEventAt ? Date.now() - entry.streamLastEventAt : null,
            streamError: entry?.streamError,
        };
    }
    async ensureStreamSupported(baseURL) {
        const entry = this.entryFor(baseURL);
        if (entry.streamSupportChecked) {
            return Boolean(entry.streamSupported);
        }
        try {
            const identity = (await axios.get(`${baseURL}/identity`, { timeout: Math.min(this.apiTimeoutMs, 900) })).data;
            entry.streamSupported = identity?.supportsConcurrentStreams === true;
        }
        catch (error) {
            entry.streamSupported = false;
            entry.streamError = error?.message ?? String(error);
        }
        entry.streamSupportChecked = true;
        return Boolean(entry.streamSupported);
    }
    startStream(baseURL) {
        const entry = this.entryFor(baseURL);
        if (entry.streamStarted) {
            return;
        }
        entry.streamStarted = true;
        void (async () => {
            let retryDelayMs = 750;
            while (entry.streamStarted) {
                try {
                    const response = await fetch(`${baseURL}/stream`);
                    if (!response.ok || !response.body) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    entry.streamActive = true;
                    entry.streamError = undefined;
                    retryDelayMs = 750;
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = "";
                    while (entry.streamStarted) {
                        const { value, done } = await reader.read();
                        if (done) {
                            break;
                        }
                        buffer += decoder.decode(value, { stream: true });
                        let separatorIndex = buffer.search(/\r?\n\r?\n/);
                        while (separatorIndex >= 0) {
                            const block = buffer.slice(0, separatorIndex);
                            buffer = buffer.slice(separatorIndex + (buffer[separatorIndex] === "\r" ? 4 : 2));
                            this.handleSseBlock(baseURL, block);
                            separatorIndex = buffer.search(/\r?\n\r?\n/);
                        }
                    }
                }
                catch (error) {
                    entry.streamError = error?.message ?? String(error);
                }
                finally {
                    entry.streamActive = false;
                }
                await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
                retryDelayMs = Math.min(retryDelayMs * 2, 5000);
            }
        })();
    }
    async get(baseURL, force = false) {
        if (!force && await this.ensureStreamSupported(baseURL)) {
            this.startStream(baseURL);
        }
        const now = Date.now();
        const cached = this.entries.get(baseURL);
        if (!force && cached && now - cached.fetchedAt <= this.ttlMs) {
            return cached.snapshot;
        }
        if (!force && cached?.inflight) {
            return cached.inflight;
        }
        const inflight = runeliteApi(baseURL).get("/snapshot").then((res) => {
            const snapshot = res.data;
            this.update(baseURL, snapshot);
            return snapshot;
        }).catch((error) => {
            if (cached) {
                cached.inflight = undefined;
            }
            else {
                this.entries.delete(baseURL);
            }
            throw error;
        });
        this.entryFor(baseURL).inflight = inflight;
        return inflight;
    }
    entryFor(baseURL) {
        const existing = this.entries.get(baseURL);
        if (existing) {
            return existing;
        }
        const entry = { fetchedAt: 0, snapshot: {} };
        this.entries.set(baseURL, entry);
        return entry;
    }
    update(baseURL, snapshot) {
        const entry = this.entryFor(baseURL);
        entry.fetchedAt = Date.now();
        entry.snapshot = snapshot;
        entry.inflight = undefined;
    }
    handleSseBlock(baseURL, block) {
        const dataLines = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart());
        if (dataLines.length === 0) {
            return;
        }
        const snapshot = JSON.parse(dataLines.join("\n"));
        this.update(baseURL, snapshot);
        this.entryFor(baseURL).streamLastEventAt = Date.now();
    }
}
const configuredMouseSpeed = Number(process.env.OSRS_MOUSE_SPEED ?? "300");
mouse.config.mouseSpeed = Number.isFinite(configuredMouseSpeed) && configuredMouseSpeed > 0
    ? configuredMouseSpeed
    : 300;
const server = new McpServer({
    name: "osrs-mcp-server",
    version: "1.0.0",
});
const RUNELITE_API = process.env.OSRS_RUNELITE_API ?? "http://localhost:8080/api";
let selectedRuneliteApi = RUNELITE_API;
let selectedClientInstanceId;
const configuredApiTimeoutMs = Number(process.env.OSRS_API_TIMEOUT_MS ?? "3000");
const API_TIMEOUT_MS = Number.isFinite(configuredApiTimeoutMs) && configuredApiTimeoutMs > 0
    ? configuredApiTimeoutMs
    : 3000;
const configuredSnapshotCacheTtlMs = Number(process.env.OSRS_SNAPSHOT_CACHE_TTL_MS ?? "250");
const SNAPSHOT_CACHE_TTL_MS = Number.isFinite(configuredSnapshotCacheTtlMs) && configuredSnapshotCacheTtlMs >= 0
    ? configuredSnapshotCacheTtlMs
    : 250;
const stateCache = new StateCache(SNAPSHOT_CACHE_TTL_MS, API_TIMEOUT_MS);
function runeliteApi(baseURL = selectedRuneliteApi) {
    return axios.create({
        baseURL,
        timeout: API_TIMEOUT_MS,
    });
}
function errorText(action, e) {
    const status = e?.response?.status ? ` HTTP ${e.response.status}` : "";
    const responseData = e?.response?.data ? ` ${JSON.stringify(e.response.data)}` : "";
    return `Error ${action}:${status} ${e?.message ?? String(e)}${responseData}`;
}
function apiBaseFromPort(port) {
    return `http://localhost:${port}/api`;
}
function runeliteApiForPort(port) {
    return runeliteApi(port === undefined ? selectedRuneliteApi : apiBaseFromPort(port));
}
function startSnapshotStream(baseURL) {
    stateCache.startStream(baseURL);
}
function snapshotStreamStatus(baseURL) {
    return stateCache.status(baseURL);
}
async function ensureSnapshotStreamSupported(baseURL) {
    return stateCache.ensureStreamSupported(baseURL);
}
async function getSnapshotForBase(baseURL, force = false) {
    return stateCache.get(baseURL, force);
}
async function discoverClients() {
    const ports = Array.from({ length: 11 }, (_, index) => 8080 + index);
    const clients = [];
    for (const port of ports) {
        try {
            const baseURL = apiBaseFromPort(port);
            const res = await axios.get(`${baseURL}/identity`, { timeout: 600 });
            clients.push({ ...res.data, baseUrl: baseURL });
        }
        catch {
            // Ignore closed ports during discovery.
        }
    }
    return clients;
}
async function resolveRuneliteApi(target = {}) {
    if (target.port !== undefined) {
        return apiBaseFromPort(target.port);
    }
    const needsDiscovery = Boolean(target.instanceId || target.playerName || selectedClientInstanceId);
    if (!needsDiscovery) {
        const clients = await discoverClients();
        if (clients.length === 1) {
            selectedRuneliteApi = clients[0].baseUrl;
            selectedClientInstanceId = clients[0].instanceId;
            return selectedRuneliteApi;
        }
        if (clients.length > 1) {
            throw new Error(`Multiple RuneLite clients are active. Use list_clients/select_client or pass port/instanceId/playerName. Clients: ${JSON.stringify(clients)}`);
        }
        return selectedRuneliteApi;
    }
    const clients = await discoverClients();
    const matches = clients.filter((client) => (target.instanceId && client.instanceId === target.instanceId) ||
        (target.playerName && String(client.playerName ?? "").toLowerCase() === target.playerName.toLowerCase()) ||
        (!target.instanceId && !target.playerName && selectedClientInstanceId && client.instanceId === selectedClientInstanceId));
    if (matches.length !== 1) {
        throw new Error(`Expected exactly one matching RuneLite client, found ${matches.length}. Clients: ${JSON.stringify(clients)}`);
    }
    selectedRuneliteApi = matches[0].baseUrl;
    selectedClientInstanceId = matches[0].instanceId;
    return selectedRuneliteApi;
}
async function apiForTarget(target = {}) {
    return runeliteApi(await resolveRuneliteApi(target));
}
async function getSnapshotForTarget(target = {}, force = false) {
    const baseURL = await resolveRuneliteApi(target);
    return {
        baseURL,
        snapshot: await getSnapshotForBase(baseURL, force),
    };
}
async function assertClientReady(baseURL) {
    const identity = (await runeliteApi(baseURL).get("/identity")).data;
    if (identity?.windowMinimized) {
        throw new Error(`RuneLite client ${identity.instanceId ?? baseURL} is minimized`);
    }
    if (identity?.canvasShowing === false) {
        throw new Error(`RuneLite client ${identity.instanceId ?? baseURL} canvas is not visible`);
    }
    if (identity?.windowActive === false) {
        throw new Error(`RuneLite client ${identity.instanceId ?? baseURL} window is not active; focus RuneLite before OS click tools`);
    }
    return identity;
}
function targetMatches(entity, name, id) {
    if (id !== undefined && entity.id !== id) {
        return false;
    }
    if (name && String(entity.name ?? "").toLowerCase() !== name.toLowerCase()) {
        return false;
    }
    return true;
}
function requireFreshClickable(target, maxAgeMs, coordinateSource) {
    if (!target) {
        throw new Error("No matching target found");
    }
    if (coordinateSource && target.coordinateSource !== coordinateSource) {
        throw new Error(`Target coordinateSource is ${target.coordinateSource}, expected ${coordinateSource}`);
    }
    if (!Number.isFinite(target.screenX) || !Number.isFinite(target.screenY)) {
        throw new Error(`Target has no click-ready screenX/screenY: ${target.coordinateWarning ?? "unknown reason"}`);
    }
    if (target.coordinateWarning) {
        throw new Error(`Target coordinates are not safe to click: ${target.coordinateWarning}`);
    }
    if (target.ageMs !== undefined && target.ageMs > maxAgeMs) {
        throw new Error(`Target is stale: ageMs=${target.ageMs}, maxAgeMs=${maxAgeMs}`);
    }
}
async function clickPoint(x, y, rightClick) {
    await mouse.setPosition(new Point(x, y));
    if (rightClick) {
        await mouse.rightClick();
    }
    else {
        await mouse.leftClick();
    }
}
async function movePoint(x, y) {
    await mouse.setPosition(new Point(x, y));
}
async function invokeMenuAction(baseURL, action) {
    const body = {
        param0: action.param0,
        param1: action.param1,
        menuAction: action.menuAction ?? action.type,
        identifier: action.identifier ?? action.id,
        itemId: action.itemId ?? -1,
        option: action.option ?? "",
        target: action.target ?? "",
        dryRun: action.dryRun ?? false,
    };
    const res = await runeliteApi(baseURL).post("/action/menu", body);
    return res.data;
}
async function getPlayerLocation(target = {}) {
    const { snapshot } = await getSnapshotForTarget(target);
    return snapshot.state?.location;
}
function sortNearestToPlayer(items, playerLocation) {
    if (!playerLocation) {
        return items;
    }
    return items.slice().sort((a, b) => {
        const da = Math.abs((a.worldX ?? 0) - playerLocation.x) + Math.abs((a.worldY ?? 0) - playerLocation.y);
        const db = Math.abs((b.worldX ?? 0) - playerLocation.x) + Math.abs((b.worldY ?? 0) - playerLocation.y);
        return da - db;
    });
}
function sortByDistance(items) {
    return items.slice().sort((a, b) => (a.distanceToPlayer ?? Number.MAX_SAFE_INTEGER) - (b.distanceToPlayer ?? Number.MAX_SAFE_INTEGER));
}
function formatTarget(target) {
    if (!target) {
        return "No matching target found";
    }
    return JSON.stringify(target, null, 2);
}
function freshEnough(target, maxAgeMs) {
    return target.ageMs === undefined || target.ageMs <= maxAgeMs;
}
function hasScreenPoint(target) {
    return Number.isFinite(target.screenX) && Number.isFinite(target.screenY);
}
function chebyshevDistance(a, b) {
    return Math.max(Math.abs((a?.x ?? 0) - (b?.x ?? 0)), Math.abs((a?.y ?? 0) - (b?.y ?? 0)));
}
function calculateStraightLineSteps(from, to, maxStepTiles = 18, maxSteps = 12) {
    if (!from || !Number.isFinite(from.x) || !Number.isFinite(from.y)) {
        throw new Error("Current player location is unavailable");
    }
    if (!Number.isFinite(to.worldX) || !Number.isFinite(to.worldY)) {
        throw new Error("Target worldX/worldY are required");
    }
    const safeMaxStep = Math.max(1, Math.floor(maxStepTiles));
    const totalDx = to.worldX - from.x;
    const totalDy = to.worldY - from.y;
    const distance = Math.max(Math.abs(totalDx), Math.abs(totalDy));
    const stepsNeeded = Math.max(1, Math.ceil(distance / safeMaxStep));
    const stepsToReturn = Math.min(stepsNeeded, Math.max(1, Math.floor(maxSteps)));
    const steps = [];
    for (let i = 1; i <= stepsToReturn; i += 1) {
        const factor = Math.min(1, i / stepsNeeded);
        steps.push({
            worldX: Math.round(from.x + totalDx * factor),
            worldY: Math.round(from.y + totalDy * factor),
            plane: to.plane ?? from.plane ?? 0,
            final: i === stepsNeeded,
        });
    }
    return {
        from,
        target: { worldX: to.worldX, worldY: to.worldY, plane: to.plane ?? from.plane ?? 0 },
        distance,
        maxStepTiles: safeMaxStep,
        stepsNeeded,
        returnedSteps: steps.length,
        truncated: stepsNeeded > steps.length,
        collisionAware: false,
        note: "Straight-line minimap steps only; obstacles and doors are not pathfound.",
        steps,
    };
}
function targetsForType(snapshot, entityType) {
    switch (entityType.toLowerCase()) {
        case "npc":
        case "npcs":
            return snapshot.npcs ?? [];
        case "object":
        case "objects":
            return snapshot.objects ?? [];
        case "ground_item":
        case "grounditem":
        case "grounditems":
        case "item":
            return snapshot.groundItems ?? [];
        case "player":
        case "players":
            return snapshot.players ?? [];
        default:
            throw new Error(`Unsupported entityType: ${entityType}`);
    }
}
function defaultCoordinateSourceForType(entityType) {
    switch (entityType.toLowerCase()) {
        case "npc":
        case "npcs":
        case "player":
        case "players":
            return "convexHull";
        case "object":
        case "objects":
            return "clickbox";
        default:
            return undefined;
    }
}
function selectLiveTarget(snapshot, entityType, name, id, nearestToPlayer, coordinateSource) {
    const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
    const matches = sortNearestToPlayer(sortByDistance(targetsForType(snapshot, entityType).filter((target) => targetMatches(target, name, id))), playerLocation);
    const expectedSource = coordinateSource ?? defaultCoordinateSourceForType(entityType);
    if (expectedSource) {
        return matches.find((target) => target.coordinateSource === expectedSource && hasScreenPoint(target));
    }
    return matches.find((target) => hasScreenPoint(target));
}
function clientTargetSchema() {
    return {
        instanceId: z.string().optional().describe("Optional RuneLite plugin instanceId to target"),
        playerName: z.string().optional().describe("Optional player name to target"),
        port: z.number().optional().describe("Optional RuneLite API port to target, for example 8081"),
    };
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function openContextMenuForTarget(args) {
    const targetClient = { instanceId: args.instanceId, playerName: args.playerName, port: args.port };
    const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
    await assertClientReady(baseURL);
    const expectedSource = args.coordinateSource ?? defaultCoordinateSourceForType(args.entityType);
    const target = selectLiveTarget(snapshot, args.entityType, args.name, args.id, args.nearestToPlayer ?? true, args.coordinateSource);
    requireFreshClickable(target, args.maxAgeMs ?? 600, expectedSource);
    await clickPoint(target.screenX, target.screenY, true);
    await sleep(Math.max(0, args.menuDelayMs ?? 150));
    const menu = (await runeliteApi(baseURL).get("/context_menu")).data;
    return {
        rightClicked: {
            entityType: args.entityType,
            name: target.name,
            id: target.id,
            screenX: target.screenX,
            screenY: target.screenY,
            worldX: target.worldX,
            worldY: target.worldY,
            coordinateSource: target.coordinateSource,
            distanceToPlayer: target.distanceToPlayer,
            ageMs: target.ageMs,
        },
        menu,
    };
}
async function clickMinimapProjection(worldX, worldY, plane, target = {}, maxAgeMs = 1000) {
    const api = await apiForTarget(target);
    await assertClientReady(api.defaults.baseURL ?? selectedRuneliteApi);
    const res = await api.get("/minimap", { params: { worldX, worldY, plane } });
    const minimapTarget = res.data?.target;
    requireFreshClickable(minimapTarget, maxAgeMs, "minimapProjection");
    await clickPoint(minimapTarget.screenX, minimapTarget.screenY);
    return minimapTarget;
}
async function clickShopAction(actionText, itemName, itemId, rightClick, target = {}) {
    const baseURL = await resolveRuneliteApi(target);
    await assertClientReady(baseURL);
    const res = await runeliteApi(baseURL).get("/shop");
    const actionNeedle = actionText.toLowerCase();
    const itemNeedle = itemName?.toLowerCase();
    const shopTarget = (res.data?.actionWidgets ?? []).find((widget) => {
        const actions = Array.isArray(widget.actions) ? widget.actions.join(" ").toLowerCase() : "";
        const label = `${widget.name ?? ""} ${widget.text ?? ""}`.toLowerCase();
        return actions.includes(actionNeedle) &&
            (itemId === undefined || widget.itemId === itemId) &&
            (!itemNeedle || label.includes(itemNeedle));
    });
    requireFreshClickable(shopTarget, 1000, "widgetBounds");
    await clickPoint(shopTarget.screenX, shopTarget.screenY, rightClick);
    return shopTarget;
}
async function clickBankAction(actionText, itemName, itemId, rightClick, target = {}) {
    const baseURL = await resolveRuneliteApi(target);
    await assertClientReady(baseURL);
    const res = await runeliteApi(baseURL).get("/bank_actions");
    const actionNeedle = actionText.toLowerCase();
    const itemNeedle = itemName?.toLowerCase();
    const widgets = actionNeedle.includes("deposit")
        ? res.data?.depositWidgets ?? []
        : res.data?.withdrawWidgets ?? [];
    const bankTarget = widgets.find((widget) => {
        const actions = Array.isArray(widget.actions) ? widget.actions.join(" ").toLowerCase() : "";
        const label = `${widget.name ?? ""} ${widget.text ?? ""}`.toLowerCase();
        return actions.includes(actionNeedle) &&
            (itemId === undefined || widget.itemId === itemId) &&
            (!itemNeedle || label.includes(itemNeedle));
    });
    requireFreshClickable(bankTarget, 1000, "widgetBounds");
    await clickPoint(bankTarget.screenX, bankTarget.screenY, rightClick);
    return bankTarget;
}
function findInventoryItem(snapshot, name, id, slot) {
    return (snapshot.inventory ?? []).find((item) => (slot === undefined || item.slot === slot) &&
        targetMatches(item, name, id) &&
        Number.isFinite(item.slotScreenX) &&
        Number.isFinite(item.slotScreenY));
}
function requireFreshInventoryItem(item, maxAgeMs) {
    if (!item) {
        throw new Error("No matching inventory item with slot coordinates found");
    }
    if (!Number.isFinite(item.slotScreenX) || !Number.isFinite(item.slotScreenY)) {
        throw new Error("Inventory item has no click-ready slotScreenX/slotScreenY");
    }
    if (item.ageMs !== undefined && item.ageMs > maxAgeMs) {
        throw new Error(`Inventory item data is stale: ageMs=${item.ageMs}, maxAgeMs=${maxAgeMs}`);
    }
}
async function selectInventoryItemForUse(item, target, useRightClickMenu = true) {
    if (useRightClickMenu) {
        await clickPoint(item.slotScreenX, item.slotScreenY, true);
        await sleep(150);
        await selectContextMenuOption("Use", target, false);
    }
    else {
        await clickPoint(item.slotScreenX, item.slotScreenY);
    }
}
async function selectContextMenuOption(text, target = {}, exact) {
    const baseURL = await resolveRuneliteApi(target);
    await assertClientReady(baseURL);
    const menu = (await runeliteApi(baseURL).get("/context_menu")).data;
    if (!menu?.isOpen) {
        throw new Error("Context menu is not open");
    }
    const needle = text.toLowerCase();
    const entries = (menu.entries ?? []);
    const match = entries.find((entry) => {
        const optionText = `${entry.option ?? ""} ${entry.target ?? ""}`.trim().toLowerCase();
        return exact ? optionText === needle || String(entry.option ?? "").toLowerCase() === needle : optionText.includes(needle);
    });
    if (!match) {
        throw new Error("No matching context menu option found");
    }
    if (Number.isFinite(match.param0) && Number.isFinite(match.param1) && Number.isFinite(match.identifier) && match.type) {
        const action = await invokeMenuAction(baseURL, {
            param0: match.param0,
            param1: match.param1,
            type: match.type,
            identifier: match.identifier,
            itemId: match.itemId,
            option: match.option,
            target: match.target,
        });
        return { ...match, actionMode: "client_menu_action", action };
    }
    requireFreshClickable(match, 1000);
    await clickPoint(match.screenX, match.screenY);
    return { ...match, actionMode: "os_click_fallback" };
}
function isPlayerIdle(state) {
    return state?.isIdle === true || (state?.animation === -1 && !state?.interactingWith);
}
function tileDistance(location, worldX, worldY, plane) {
    if (!location || !Number.isFinite(location.x) || !Number.isFinite(location.y)) {
        return Number.MAX_SAFE_INTEGER;
    }
    if (plane !== undefined && location.plane !== plane) {
        return Number.MAX_SAFE_INTEGER;
    }
    return Math.max(Math.abs(location.x - worldX), Math.abs(location.y - worldY));
}
function matchesChatMessage(message, text, caseSensitive, type) {
    if (type && String(message.type ?? "").toLowerCase() !== type.toLowerCase()) {
        return false;
    }
    const haystack = String(message.message ?? "");
    return caseSensitive ? haystack.includes(text) : haystack.toLowerCase().includes(text.toLowerCase());
}
// --- State Reading Tools ---
server.tool("get_game_state", "Get current player state, location, and health", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
    try {
        const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
        return {
            content: [{ type: "text", text: JSON.stringify(snapshot.state ?? {}, null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching state", e) }] };
    }
});
server.tool("get_inventory", "Get the items currently in the player's inventory", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
    try {
        const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
        return {
            content: [{ type: "text", text: JSON.stringify(snapshot.inventory ?? [], null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching inventory", e) }] };
    }
});
server.tool("get_npcs", "Get a list of nearby NPCs with canvas coordinates and absolute desktop screen coordinates", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
    try {
        const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
        return {
            content: [{ type: "text", text: JSON.stringify(snapshot.npcs ?? [], null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching NPCs", e) }] };
    }
});
server.tool("get_dialogue", "Check for open NPC dialogues, player dialogues, or dialogue options with absolute desktop screen coordinates when clickable", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
    try {
        const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
        return {
            content: [{ type: "text", text: JSON.stringify(snapshot.dialogue ?? {}, null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching dialogue", e) }] };
    }
});
server.tool("get_game_objects", "Get a list of interactable game objects (trees, doors, rocks) with names and absolute desktop screen coordinates", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
    try {
        const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
        return {
            content: [{ type: "text", text: JSON.stringify(snapshot.objects ?? [], null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching game objects", e) }] };
    }
});
server.tool("get_ground_items", "Get a list of items dropped on the ground with names and absolute desktop screen coordinates", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
    try {
        const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
        return {
            content: [{ type: "text", text: JSON.stringify(snapshot.groundItems ?? [], null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching ground items", e) }] };
    }
});
server.tool("get_players", "Get visible players with combat level, location, animation/interacting state, and screen coordinates when available", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
    try {
        const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
        return {
            content: [{ type: "text", text: JSON.stringify(snapshot.players ?? [], null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching players", e) }] };
    }
});
server.tool("get_bank", "Get all items currently in the player's bank (if the bank interface is open)", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
    try {
        const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
        return {
            content: [{ type: "text", text: JSON.stringify(snapshot.bank ?? [], null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching bank", e) }] };
    }
});
server.tool("get_bank_actions", "Read visible bank Withdraw and Deposit widgets with click-ready widget coordinates when the bank interface is open.", {
    ...clientTargetSchema(),
}, async ({ instanceId, playerName, port }) => {
    try {
        const res = await (await apiForTarget({ instanceId, playerName, port })).get("/bank_actions");
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching bank actions", e) }] };
    }
});
server.tool("get_equipment", "Get all items currently equipped by the player", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
    try {
        const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
        return {
            content: [{ type: "text", text: JSON.stringify(snapshot.equipment ?? [], null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching equipment", e) }] };
    }
});
server.tool("get_skills", "Get the player's level, boosted level, and XP for all 23 skills", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
    try {
        const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
        return {
            content: [{ type: "text", text: JSON.stringify(snapshot.skills ?? {}, null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching skills", e) }] };
    }
});
server.tool("get_coordinate_debug", "Get RuneLite canvas origin, canvas size, DPI transform, mouse position, and player coordinate debug data", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
    try {
        const res = await (await apiForTarget({ instanceId, playerName, port })).get("/debug/coordinates");
        return {
            content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching coordinate debug", e) }] };
    }
});
server.tool("get_latest_snapshot", "Get the latest cached RuneLite snapshot with state, NPCs, dialogue, objects, ground items, tick, capturedAt, and ageMs.", {
    ...clientTargetSchema(),
}, async ({ instanceId, playerName, port }) => {
    try {
        const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port }, true);
        return {
            content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching latest snapshot", e) }] };
    }
});
server.tool("get_player_location", "Get the current player name, world location, health, run energy, tick, capturedAt, and ageMs.", {
    ...clientTargetSchema(),
}, async ({ instanceId, playerName, port }) => {
    try {
        const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
        return {
            content: [{ type: "text", text: JSON.stringify(snapshot.state ?? {}, null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching player location", e) }] };
    }
});
server.tool("find_nearest_object", "Refresh object data and return the nearest matching object without clicking.", {
    name: z.string().optional().describe("Object name, for example Tree"),
    id: z.number().optional().describe("Object ID"),
    requireClickable: z.boolean().optional().describe("Only return objects with screenX/screenY"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 1000"),
    ...clientTargetSchema(),
}, async ({ name, id, requireClickable, maxAgeMs, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const { snapshot } = await getSnapshotForTarget(targetClient, true);
        const objects = snapshot.objects ?? [];
        const playerLocation = snapshot.state?.location;
        const matches = sortNearestToPlayer(sortByDistance(objects.filter((object) => targetMatches(object, name, id))), playerLocation).filter((object) => freshEnough(object, maxAgeMs ?? 1000))
            .filter((object) => !requireClickable || hasScreenPoint(object));
        return { content: [{ type: "text", text: formatTarget(matches[0]) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("finding nearest object", e) }] };
    }
});
server.tool("find_nearest_npc", "Refresh NPC data and return the nearest matching NPC without clicking.", {
    name: z.string().optional().describe("NPC name"),
    id: z.number().optional().describe("NPC ID"),
    requireClickable: z.boolean().optional().describe("Only return NPCs with screenX/screenY"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 1000"),
    ...clientTargetSchema(),
}, async ({ name, id, requireClickable, maxAgeMs, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const { snapshot } = await getSnapshotForTarget(targetClient, true);
        const npcs = snapshot.npcs ?? [];
        const playerLocation = snapshot.state?.location;
        const matches = sortNearestToPlayer(sortByDistance(npcs.filter((npc) => targetMatches(npc, name, id))), playerLocation).filter((npc) => freshEnough(npc, maxAgeMs ?? 1000))
            .filter((npc) => !requireClickable || hasScreenPoint(npc));
        return { content: [{ type: "text", text: formatTarget(matches[0]) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("finding nearest NPC", e) }] };
    }
});
server.tool("find_nearest_ground_item", "Refresh ground-item data and return the nearest matching item without clicking.", {
    name: z.string().optional().describe("Ground item name"),
    id: z.number().optional().describe("Item ID"),
    requireClickable: z.boolean().optional().describe("Only return items with screenX/screenY"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 1000"),
    ...clientTargetSchema(),
}, async ({ name, id, requireClickable, maxAgeMs, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const { snapshot } = await getSnapshotForTarget(targetClient, true);
        const items = snapshot.groundItems ?? [];
        const playerLocation = snapshot.state?.location;
        const matches = sortNearestToPlayer(sortByDistance(items.filter((item) => targetMatches(item, name, id))), playerLocation).filter((item) => freshEnough(item, maxAgeMs ?? 1000))
            .filter((item) => !requireClickable || hasScreenPoint(item));
        return { content: [{ type: "text", text: formatTarget(matches[0]) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("finding nearest ground item", e) }] };
    }
});
server.tool("verify_target_visible", "Refresh the latest snapshot and verify a matching entity is visible, fresh, click-ready, and from the expected coordinate source without clicking.", {
    entityType: z.string().describe("npc, object, ground_item, or player"),
    name: z.string().optional().describe("Entity name"),
    id: z.number().optional().describe("Entity ID where available"),
    nearestToPlayer: z.boolean().optional().describe("Prefer nearest matching entity to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    coordinateSource: z.string().optional().describe("Optional required coordinateSource, for example clickbox or convexHull"),
    ...clientTargetSchema(),
}, async ({ entityType, name, id, nearestToPlayer, maxAgeMs, coordinateSource, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
        await assertClientReady(baseURL);
        const items = targetsForType(snapshot, entityType).filter((item) => targetMatches(item, name, id));
        const sorted = sortNearestToPlayer(sortByDistance(items), nearestToPlayer ? snapshot.state?.location : null);
        const target = coordinateSource
            ? sorted.find((item) => item.coordinateSource === coordinateSource && hasScreenPoint(item))
            : sorted.find((item) => hasScreenPoint(item));
        requireFreshClickable(target, maxAgeMs ?? 600, coordinateSource);
        return { content: [{ type: "text", text: JSON.stringify({ visible: true, target }, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ visible: false, error: e.message }, null, 2) }] };
    }
});
server.tool("get_vars", "Read selected RuneLite varbit and varp values for quest/state checks without dumping every game variable.", {
    varbits: z.array(z.number()).optional().describe("Varbit IDs to read"),
    varps: z.array(z.number()).optional().describe("VarPlayer/varp IDs to read"),
    ...clientTargetSchema(),
}, async ({ varbits, varps, instanceId, playerName, port }) => {
    try {
        const api = await apiForTarget({ instanceId, playerName, port });
        const res = await api.get("/vars", { params: { varbits: (varbits ?? []).join(","), varps: (varps ?? []).join(",") } });
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching vars", e) }] };
    }
});
server.tool("get_quest_state", "Read RuneLite quest state by quest name, enum name, or id. Omit name to list all quest states.", {
    name: z.string().optional().describe("Quest name or enum name, for example Cook's Assistant or COOKS_ASSISTANT"),
    id: z.number().optional().describe("RuneLite quest id"),
    ...clientTargetSchema(),
}, async ({ name, id, instanceId, playerName, port }) => {
    try {
        const res = await (await apiForTarget({ instanceId, playerName, port })).get("/quest_state", {
            params: { name: name ?? id },
        });
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching quest state", e) }] };
    }
});
server.tool("get_prayers", "Read prayer level, active prayers, prayer varbits, and prayer/quick-prayer orb coordinates.", {
    ...clientTargetSchema(),
}, async ({ instanceId, playerName, port }) => {
    try {
        const res = await (await apiForTarget({ instanceId, playerName, port })).get("/prayers");
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching prayers", e) }] };
    }
});
server.tool("click_prayer_orb", "Click the minimap prayer orb or quick-prayer orb using fresh widget screen coordinates.", {
    orb: z.enum(["prayer", "quick_prayer"]).describe("Which orb to click"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
}, async ({ orb, rightClick, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const baseURL = await resolveRuneliteApi(targetClient);
        await assertClientReady(baseURL);
        const res = await runeliteApi(baseURL).get("/prayers");
        const label = orb === "quick_prayer" ? "quickPrayerOrb" : "prayerOrb";
        const target = (res.data?.controls ?? []).find((control) => control.label === label);
        requireFreshClickable(target, 1000, "widgetBounds");
        await clickPoint(target.screenX, target.screenY, rightClick);
        return { content: [{ type: "text", text: `Clicked ${label} at ${target.screenX}, ${target.screenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error clicking prayer orb: ${e.message}` }] };
    }
});
server.tool("get_combat", "Read combat style widgets, auto-retaliate widget, combat tab coordinates, and player combat state.", {
    ...clientTargetSchema(),
}, async ({ instanceId, playerName, port }) => {
    try {
        const res = await (await apiForTarget({ instanceId, playerName, port })).get("/combat");
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching combat controls", e) }] };
    }
});
server.tool("click_combat_style", "Click one of the four visible combat style widgets using fresh widget screen coordinates.", {
    style: z.number().min(1).max(4).describe("Combat style number 1-4"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
}, async ({ style, rightClick, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const baseURL = await resolveRuneliteApi(targetClient);
        await assertClientReady(baseURL);
        const res = await runeliteApi(baseURL).get("/combat");
        const target = (res.data?.controls ?? []).find((control) => control.label === `style${style}`);
        requireFreshClickable(target, 1000, "widgetBounds");
        await clickPoint(target.screenX, target.screenY, rightClick);
        return { content: [{ type: "text", text: `Clicked combat style ${style} at ${target.screenX}, ${target.screenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error clicking combat style: ${e.message}` }] };
    }
});
server.tool("toggle_auto_retaliate", "Click the auto-retaliate combat widget using fresh widget screen coordinates.", {
    ...clientTargetSchema(),
}, async ({ instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const baseURL = await resolveRuneliteApi(targetClient);
        await assertClientReady(baseURL);
        const res = await runeliteApi(baseURL).get("/combat");
        const target = (res.data?.controls ?? []).find((control) => control.label === "autoRetaliate");
        requireFreshClickable(target, 1000, "widgetBounds");
        await clickPoint(target.screenX, target.screenY);
        return { content: [{ type: "text", text: `Clicked auto-retaliate at ${target.screenX}, ${target.screenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error toggling auto-retaliate: ${e.message}` }] };
    }
});
server.tool("click_special_attack", "Click the visible special-attack combat widget using fresh widget screen coordinates when available.", {
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
}, async ({ rightClick, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const baseURL = await resolveRuneliteApi(targetClient);
        await assertClientReady(baseURL);
        const res = await runeliteApi(baseURL).get("/combat");
        const target = (res.data?.specialAttackWidgets ?? []).find((widget) => Number.isFinite(widget.screenX) && Number.isFinite(widget.screenY));
        requireFreshClickable(target, 1000, "widgetBounds");
        await clickPoint(target.screenX, target.screenY, rightClick);
        return { content: [{ type: "text", text: `Clicked special attack at ${target.screenX}, ${target.screenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error clicking special attack: ${e.message}` }] };
    }
});
server.tool("get_shop", "Read visible shop/trade action widgets with Buy/Sell actions and click-ready widget coordinates.", {
    ...clientTargetSchema(),
}, async ({ instanceId, playerName, port }) => {
    try {
        const res = await (await apiForTarget({ instanceId, playerName, port })).get("/shop");
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching shop", e) }] };
    }
});
server.tool("click_shop_action", "Click a visible shop/trade widget whose actions include Buy/Sell text, optionally filtered by item name or item id.", {
    actionText: z.string().describe("Action text to match, for example Buy 1, Buy, Sell 5"),
    itemName: z.string().optional().describe("Optional item widget name/text substring"),
    itemId: z.number().optional().describe("Optional item id"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
}, async ({ actionText, itemName, itemId, rightClick, instanceId, playerName, port }) => {
    try {
        const target = await clickShopAction(actionText, itemName, itemId, rightClick, { instanceId, playerName, port });
        return { content: [{ type: "text", text: `Clicked shop action at ${target.screenX}, ${target.screenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error clicking shop action: ${e.message}` }] };
    }
});
server.tool("buy_item", "Click a visible shop Buy action for an item, optionally filtered by item name or item id.", {
    quantity: z.string().optional().describe("Quantity suffix to prefer, for example 1, 5, 10, 50. Omit to match any Buy action."),
    itemName: z.string().optional().describe("Optional item widget name/text substring"),
    itemId: z.number().optional().describe("Optional item id"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
}, async ({ quantity, itemName, itemId, rightClick, instanceId, playerName, port }) => {
    try {
        const actionText = quantity ? `Buy ${quantity}` : "Buy";
        const target = await clickShopAction(actionText, itemName, itemId, rightClick, { instanceId, playerName, port });
        return { content: [{ type: "text", text: `Clicked ${actionText} for shop item at ${target.screenX}, ${target.screenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error buying shop item: ${e.message}` }] };
    }
});
server.tool("sell_item", "Click a visible shop Sell action for an item, optionally filtered by item name or item id.", {
    quantity: z.string().optional().describe("Quantity suffix to prefer, for example 1, 5, 10, 50. Omit to match any Sell action."),
    itemName: z.string().optional().describe("Optional item widget name/text substring"),
    itemId: z.number().optional().describe("Optional item id"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
}, async ({ quantity, itemName, itemId, rightClick, instanceId, playerName, port }) => {
    try {
        const actionText = quantity ? `Sell ${quantity}` : "Sell";
        const target = await clickShopAction(actionText, itemName, itemId, rightClick, { instanceId, playerName, port });
        return { content: [{ type: "text", text: `Clicked ${actionText} for shop item at ${target.screenX}, ${target.screenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error selling shop item: ${e.message}` }] };
    }
});
server.tool("get_minimap", "Read minimap bounds and optionally project a world tile to minimap screen coordinates.", {
    worldX: z.number().optional().describe("Optional target world X tile to project"),
    worldY: z.number().optional().describe("Optional target world Y tile to project"),
    plane: z.number().optional().describe("Optional target plane"),
    ...clientTargetSchema(),
}, async ({ worldX, worldY, plane, instanceId, playerName, port }) => {
    try {
        const params = worldX !== undefined && worldY !== undefined ? { worldX, worldY, plane } : undefined;
        const res = await (await apiForTarget({ instanceId, playerName, port })).get("/minimap", { params });
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching minimap", e) }] };
    }
});
server.tool("get_camera", "Read RuneLite camera yaw, pitch, position, map angle, minimap zoom, viewport size, and player orientation context.", {
    ...clientTargetSchema(),
}, async ({ instanceId, playerName, port }) => {
    try {
        const res = await (await apiForTarget({ instanceId, playerName, port })).get("/camera");
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching camera", e) }] };
    }
});
server.tool("get_context_menu", "Read the current RuneLite right-click/context menu entries and row screen coordinates when the menu is open.", {
    ...clientTargetSchema(),
}, async ({ instanceId, playerName, port }) => {
    try {
        const res = await (await apiForTarget({ instanceId, playerName, port })).get("/context_menu");
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching context menu", e) }] };
    }
});
server.tool("invoke_menu_action", "Invoke a RuneLite menu action inside the client on the RuneLite ClientThread. Use params from get_context_menu entries or dryRun first when unsure.", {
    param0: z.number().describe("RuneLite menu action param0, usually scene X, widget child id, or slot depending on action type"),
    param1: z.number().describe("RuneLite menu action param1, usually scene Y, widget packed id, or widget id depending on action type"),
    menuAction: z.string().describe("RuneLite MenuAction enum name, for example GAME_OBJECT_FIRST_OPTION, NPC_FIRST_OPTION, WIDGET_TARGET, or WALK"),
    identifier: z.number().optional().describe("RuneLite menu action identifier. If omitted, id is used."),
    id: z.number().optional().describe("Alias for identifier"),
    itemId: z.number().optional().describe("Item ID for item/widget actions, otherwise -1"),
    option: z.string().optional().describe("Menu option text, for example Chop down, Talk-to, Use, Walk here"),
    target: z.string().optional().describe("Menu target text"),
    dryRun: z.boolean().optional().describe("Validate and echo the action without invoking it in-game"),
    ...clientTargetSchema(),
}, async ({ param0, param1, menuAction, identifier, id, itemId, option, target, dryRun, instanceId, playerName, port }) => {
    try {
        const baseURL = await resolveRuneliteApi({ instanceId, playerName, port });
        const result = await invokeMenuAction(baseURL, {
            param0,
            param1,
            menuAction,
            identifier,
            id,
            itemId,
            option,
            target,
            dryRun,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("invoking menu action", e) }] };
    }
});
server.tool("open_context_menu_for_target", "Right-click a fresh NPC, object, player, or ground item target and return the resulting RuneLite context menu without selecting an option.", {
    entityType: z.enum(["npc", "object", "ground_item", "player"]).describe("Target type to right-click"),
    name: z.string().optional().describe("Optional exact target name"),
    id: z.number().optional().describe("Optional target ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching target to the player"),
    coordinateSource: z.string().optional().describe("Required coordinate source. Defaults to clickbox for objects and convexHull for NPCs/players."),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    menuDelayMs: z.number().optional().describe("Delay after right-click before reading the menu, default 150"),
    ...clientTargetSchema(),
}, async ({ entityType, name, id, nearestToPlayer, coordinateSource, maxAgeMs, menuDelayMs, instanceId, playerName, port }) => {
    try {
        const result = await openContextMenuForTarget({
            entityType,
            name,
            id,
            nearestToPlayer,
            coordinateSource,
            maxAgeMs,
            menuDelayMs,
            instanceId,
            playerName,
            port
        });
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify(result, null, 2)
                }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error opening context menu for target: ${e.message}` }] };
    }
});
server.tool("right_click_npc", "Right-click a fresh NPC convexHull target and return the resulting RuneLite context menu.", {
    name: z.string().optional().describe("NPC name"),
    id: z.number().optional().describe("NPC ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching NPC to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    menuDelayMs: z.number().optional().describe("Delay after right-click before reading the menu, default 150"),
    ...clientTargetSchema(),
}, async ({ name, id, nearestToPlayer, maxAgeMs, menuDelayMs, instanceId, playerName, port }) => {
    try {
        const result = await openContextMenuForTarget({ entityType: "npc", name, id, nearestToPlayer, maxAgeMs, menuDelayMs, instanceId, playerName, port });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error right-clicking NPC: ${e.message}` }] };
    }
});
server.tool("right_click_object", "Right-click a fresh object clickbox target and return the resulting RuneLite context menu.", {
    name: z.string().optional().describe("Object name, for example Tree"),
    id: z.number().optional().describe("Object ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching object to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    menuDelayMs: z.number().optional().describe("Delay after right-click before reading the menu, default 150"),
    ...clientTargetSchema(),
}, async ({ name, id, nearestToPlayer, maxAgeMs, menuDelayMs, instanceId, playerName, port }) => {
    try {
        const result = await openContextMenuForTarget({ entityType: "object", name, id, nearestToPlayer, maxAgeMs, menuDelayMs, instanceId, playerName, port });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error right-clicking object: ${e.message}` }] };
    }
});
server.tool("right_click_ground_item", "Right-click a fresh ground item target and return the resulting RuneLite context menu.", {
    name: z.string().optional().describe("Ground item name"),
    id: z.number().optional().describe("Item ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching item to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    menuDelayMs: z.number().optional().describe("Delay after right-click before reading the menu, default 150"),
    ...clientTargetSchema(),
}, async ({ name, id, nearestToPlayer, maxAgeMs, menuDelayMs, instanceId, playerName, port }) => {
    try {
        const result = await openContextMenuForTarget({ entityType: "ground_item", name, id, nearestToPlayer, maxAgeMs, menuDelayMs, instanceId, playerName, port });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error right-clicking ground item: ${e.message}` }] };
    }
});
server.tool("select_option", "Select an option from the currently open RuneLite right-click/context menu by visible option text.", {
    text: z.string().describe("Visible menu option text, for example Attack, Talk-to, Use, Drop, Deposit-All"),
    exact: z.boolean().optional().describe("Require exact option text instead of substring matching"),
    ...clientTargetSchema(),
}, async ({ text, exact, instanceId, playerName, port }) => {
    try {
        const match = await selectContextMenuOption(text, { instanceId, playerName, port }, exact);
        return { content: [{ type: "text", text: `Selected context option ${match.option ?? ""} ${match.target ?? ""}`.trim() }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error selecting context option: ${e.message}` }] };
    }
});
server.tool("walk_to", "Project a nearby world tile onto the minimap and click it. This is minimum viable navigation for loaded/nearby targets.", {
    worldX: z.number().describe("Target world X tile"),
    worldY: z.number().describe("Target world Y tile"),
    plane: z.number().optional().describe("Target plane, defaults to 0 if omitted"),
    ...clientTargetSchema(),
}, async ({ worldX, worldY, plane, instanceId, playerName, port }) => {
    try {
        const target = await clickMinimapProjection(worldX, worldY, plane, { instanceId, playerName, port });
        return { content: [{ type: "text", text: `Clicked minimap projection for ${worldX}, ${worldY}, ${plane ?? 0} at ${target.screenX}, ${target.screenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error walking to tile: ${e.message}` }] };
    }
});
server.tool("calculate_path_to", "Calculate bounded straight-line minimap steps from the current player tile to a target world tile without clicking.", {
    worldX: z.number().describe("Target world X tile"),
    worldY: z.number().describe("Target world Y tile"),
    plane: z.number().optional().describe("Target plane, defaults to the player's current plane"),
    maxStepTiles: z.number().optional().describe("Maximum tiles per minimap step, default 18"),
    maxSteps: z.number().optional().describe("Maximum steps to return, default 12"),
    ...clientTargetSchema(),
}, async ({ worldX, worldY, plane, maxStepTiles, maxSteps, instanceId, playerName, port }) => {
    try {
        const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port }, true);
        const path = calculateStraightLineSteps(snapshot.state?.location, { worldX, worldY, plane }, maxStepTiles ?? 18, maxSteps ?? 12);
        return { content: [{ type: "text", text: JSON.stringify(path, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error calculating path: ${e.message}` }] };
    }
});
server.tool("walk_path_to", "Calculate a bounded path and click only the next minimap step toward the target world tile.", {
    worldX: z.number().describe("Target world X tile"),
    worldY: z.number().describe("Target world Y tile"),
    plane: z.number().optional().describe("Target plane, defaults to the player's current plane"),
    maxStepTiles: z.number().optional().describe("Maximum tiles per minimap step, default 18"),
    maxAgeMs: z.number().optional().describe("Maximum accepted minimap projection age in milliseconds, default 1000"),
    ...clientTargetSchema(),
}, async ({ worldX, worldY, plane, maxStepTiles, maxAgeMs, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const { snapshot } = await getSnapshotForTarget(targetClient, true);
        const path = calculateStraightLineSteps(snapshot.state?.location, { worldX, worldY, plane }, maxStepTiles ?? 18, 1);
        const step = path.steps[0];
        const clicked = await clickMinimapProjection(step.worldX, step.worldY, step.plane, targetClient, maxAgeMs ?? 1000);
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        clickedStep: step,
                        clickedAt: { screenX: clicked.screenX, screenY: clicked.screenY },
                        path,
                    }, null, 2)
                }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error walking path step: ${e.message}` }] };
    }
});
server.tool("click_minimap_tile", "Project a nearby world tile onto the minimap and click the resulting minimapProjection point.", {
    worldX: z.number().describe("Target world X tile"),
    worldY: z.number().describe("Target world Y tile"),
    plane: z.number().optional().describe("Target plane, defaults to 0 if omitted"),
    maxAgeMs: z.number().optional().describe("Maximum accepted minimap projection age in milliseconds, default 1000"),
    ...clientTargetSchema(),
}, async ({ worldX, worldY, plane, maxAgeMs, instanceId, playerName, port }) => {
    try {
        const target = await clickMinimapProjection(worldX, worldY, plane, { instanceId, playerName, port }, maxAgeMs ?? 1000);
        return { content: [{ type: "text", text: `Clicked minimap tile ${worldX}, ${worldY}, ${plane ?? 0} at ${target.screenX}, ${target.screenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error clicking minimap tile: ${e.message}` }] };
    }
});
server.tool("click_inventory_slot", "Click an inventory slot using slotScreenX/slotScreenY from the live plugin snapshot.", {
    slot: z.number().describe("Inventory slot index 0-27"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    maxAgeMs: z.number().optional().describe("Maximum accepted slot data age in milliseconds, default 1000"),
    ...clientTargetSchema(),
}, async ({ slot, rightClick, maxAgeMs, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
        await assertClientReady(baseURL);
        const inventory = snapshot.inventory ?? [];
        const item = inventory.find((candidate) => candidate.slot === slot);
        if (!item || !Number.isFinite(item.slotScreenX) || !Number.isFinite(item.slotScreenY)) {
            throw new Error(`No click-ready item found in inventory slot ${slot}`);
        }
        if (item.ageMs !== undefined && item.ageMs > (maxAgeMs ?? 1000)) {
            throw new Error(`Inventory slot data is stale: ageMs=${item.ageMs}`);
        }
        await clickPoint(item.slotScreenX, item.slotScreenY, rightClick);
        return { content: [{ type: "text", text: `Clicked inventory slot ${slot} (${item.name ?? item.id}) at ${item.slotScreenX}, ${item.slotScreenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error clicking inventory slot: ${e.message}` }] };
    }
});
server.tool("use_inventory_item", "Left-click the first matching inventory item by name/id, using live slot screen coordinates.", {
    name: z.string().optional().describe("Item name"),
    id: z.number().optional().describe("Item ID"),
    ...clientTargetSchema(),
}, async ({ name, id, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
        await assertClientReady(baseURL);
        const item = findInventoryItem(snapshot, name, id);
        requireFreshInventoryItem(item, 1000);
        await clickPoint(item.slotScreenX, item.slotScreenY);
        return { content: [{ type: "text", text: `Used inventory item ${item.name ?? item.id} in slot ${item.slot}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error using inventory item: ${e.message}` }] };
    }
});
server.tool("use_inventory_item_on_object", "Select Use on a fresh inventory item, then click a fresh object clickbox target.", {
    itemName: z.string().optional().describe("Inventory item name"),
    itemId: z.number().optional().describe("Inventory item ID"),
    slot: z.number().optional().describe("Inventory slot index 0-27"),
    objectName: z.string().optional().describe("Object name, for example Door"),
    objectId: z.number().optional().describe("Object ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching object to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    itemMaxAgeMs: z.number().optional().describe("Maximum accepted inventory item age in milliseconds, default 1000"),
    useRightClickMenu: z.boolean().optional().describe("Right-click the item and select Use first. Defaults to true."),
    ...clientTargetSchema(),
}, async ({ itemName, itemId, slot, objectName, objectId, nearestToPlayer, maxAgeMs, itemMaxAgeMs, useRightClickMenu, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
        await assertClientReady(baseURL);
        const item = findInventoryItem(snapshot, itemName, itemId, slot);
        requireFreshInventoryItem(item, itemMaxAgeMs ?? 1000);
        await selectInventoryItemForUse(item, targetClient, useRightClickMenu ?? true);
        const freshSnapshot = await getSnapshotForBase(baseURL, true);
        const target = selectLiveTarget(freshSnapshot, "object", objectName, objectId, nearestToPlayer ?? true, "clickbox");
        requireFreshClickable(target, maxAgeMs ?? 600, "clickbox");
        await clickPoint(target.screenX, target.screenY);
        return { content: [{ type: "text", text: `Used ${item.name ?? item.id} on object ${target.name ?? target.id} at ${target.screenX}, ${target.screenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error using inventory item on object: ${e.message}` }] };
    }
});
server.tool("withdraw_bank_item", "Click a visible bank Withdraw action for an item, optionally filtered by item name or item id.", {
    quantity: z.string().optional().describe("Quantity suffix to prefer, for example 1, 5, 10, X, All. Omit to match any Withdraw action."),
    itemName: z.string().optional().describe("Optional bank item widget name/text substring"),
    itemId: z.number().optional().describe("Optional item id"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
}, async ({ quantity, itemName, itemId, rightClick, instanceId, playerName, port }) => {
    try {
        const actionText = quantity ? `Withdraw-${quantity}` : "Withdraw";
        const target = await clickBankAction(actionText, itemName, itemId, rightClick, { instanceId, playerName, port });
        return { content: [{ type: "text", text: `Clicked ${actionText} for bank item at ${target.screenX}, ${target.screenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error withdrawing bank item: ${e.message}` }] };
    }
});
server.tool("deposit_inventory_item", "Click a visible bank Deposit action for an inventory item, optionally filtered by item name or item id.", {
    quantity: z.string().optional().describe("Quantity suffix to prefer, for example 1, 5, 10, X, All. Omit to match any Deposit action."),
    itemName: z.string().optional().describe("Optional inventory item widget name/text substring"),
    itemId: z.number().optional().describe("Optional item id"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
}, async ({ quantity, itemName, itemId, rightClick, instanceId, playerName, port }) => {
    try {
        const actionText = quantity ? `Deposit-${quantity}` : "Deposit";
        const target = await clickBankAction(actionText, itemName, itemId, rightClick, { instanceId, playerName, port });
        return { content: [{ type: "text", text: `Clicked ${actionText} for inventory item at ${target.screenX}, ${target.screenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error depositing inventory item: ${e.message}` }] };
    }
});
server.tool("use_inventory_item_on_npc", "Select Use on a fresh inventory item, then click a fresh NPC convexHull target.", {
    itemName: z.string().optional().describe("Inventory item name"),
    itemId: z.number().optional().describe("Inventory item ID"),
    slot: z.number().optional().describe("Inventory slot index 0-27"),
    npcName: z.string().optional().describe("NPC name"),
    npcId: z.number().optional().describe("NPC ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching NPC to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    itemMaxAgeMs: z.number().optional().describe("Maximum accepted inventory item age in milliseconds, default 1000"),
    useRightClickMenu: z.boolean().optional().describe("Right-click the item and select Use first. Defaults to true."),
    ...clientTargetSchema(),
}, async ({ itemName, itemId, slot, npcName, npcId, nearestToPlayer, maxAgeMs, itemMaxAgeMs, useRightClickMenu, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
        await assertClientReady(baseURL);
        const item = findInventoryItem(snapshot, itemName, itemId, slot);
        requireFreshInventoryItem(item, itemMaxAgeMs ?? 1000);
        await selectInventoryItemForUse(item, targetClient, useRightClickMenu ?? true);
        const freshSnapshot = await getSnapshotForBase(baseURL, true);
        const target = selectLiveTarget(freshSnapshot, "npc", npcName, npcId, nearestToPlayer ?? true, "convexHull");
        requireFreshClickable(target, maxAgeMs ?? 600, "convexHull");
        await clickPoint(target.screenX, target.screenY);
        return { content: [{ type: "text", text: `Used ${item.name ?? item.id} on NPC ${target.name ?? target.id} at ${target.screenX}, ${target.screenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error using inventory item on NPC: ${e.message}` }] };
    }
});
server.tool("use_inventory_item_on_inventory_item", "Select Use on one fresh inventory item, then click another fresh inventory item slot.", {
    itemName: z.string().optional().describe("Source inventory item name"),
    itemId: z.number().optional().describe("Source inventory item ID"),
    slot: z.number().optional().describe("Source inventory slot index 0-27"),
    targetItemName: z.string().optional().describe("Target inventory item name"),
    targetItemId: z.number().optional().describe("Target inventory item ID"),
    targetSlot: z.number().optional().describe("Target inventory slot index 0-27"),
    itemMaxAgeMs: z.number().optional().describe("Maximum accepted inventory item age in milliseconds, default 1000"),
    useRightClickMenu: z.boolean().optional().describe("Right-click the source item and select Use first. Defaults to true."),
    ...clientTargetSchema(),
}, async ({ itemName, itemId, slot, targetItemName, targetItemId, targetSlot, itemMaxAgeMs, useRightClickMenu, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
        await assertClientReady(baseURL);
        const item = findInventoryItem(snapshot, itemName, itemId, slot);
        requireFreshInventoryItem(item, itemMaxAgeMs ?? 1000);
        await selectInventoryItemForUse(item, targetClient, useRightClickMenu ?? true);
        const freshSnapshot = await getSnapshotForBase(baseURL, true);
        const target = findInventoryItem(freshSnapshot, targetItemName, targetItemId, targetSlot);
        requireFreshInventoryItem(target, itemMaxAgeMs ?? 1000);
        await clickPoint(target.slotScreenX, target.slotScreenY);
        return { content: [{ type: "text", text: `Used ${item.name ?? item.id} on inventory item ${target.name ?? target.id} in slot ${target.slot}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error using inventory item on inventory item: ${e.message}` }] };
    }
});
server.tool("drop_inventory_item", "Right-click the first matching inventory item and select Drop from the context menu.", {
    name: z.string().optional().describe("Item name"),
    id: z.number().optional().describe("Item ID"),
    ...clientTargetSchema(),
}, async ({ name, id, instanceId, playerName, port }) => {
    try {
        const target = { instanceId, playerName, port };
        const { baseURL, snapshot } = await getSnapshotForTarget(target, true);
        await assertClientReady(baseURL);
        const inventory = snapshot.inventory ?? [];
        const item = inventory.find((candidate) => targetMatches(candidate, name, id) && Number.isFinite(candidate.slotScreenX) && Number.isFinite(candidate.slotScreenY));
        if (!item) {
            throw new Error("No matching inventory item with slot coordinates found");
        }
        await clickPoint(item.slotScreenX, item.slotScreenY, true);
        await new Promise((resolve) => setTimeout(resolve, 120));
        await selectContextMenuOption("Drop", target, false);
        return { content: [{ type: "text", text: `Dropped inventory item ${item.name ?? item.id} from slot ${item.slot}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error dropping inventory item: ${e.message}` }] };
    }
});
server.tool("get_chat_messages", "Read recent RuneLite chat/game messages buffered by the plugin.", {
    limit: z.number().optional().describe("Maximum messages to return, default 20"),
    ...clientTargetSchema(),
}, async ({ limit, instanceId, playerName, port }) => {
    try {
        const res = await (await apiForTarget({ instanceId, playerName, port })).get("/chat", { params: { limit } });
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("fetching chat messages", e) }] };
    }
});
server.tool("wait_until_idle", "Poll fresh snapshots until the player is idle or the timeout elapses.", {
    timeoutMs: z.number().optional().describe("Maximum wait time in milliseconds, default 10000"),
    pollMs: z.number().optional().describe("Polling interval in milliseconds, default 500"),
    stablePolls: z.number().optional().describe("How many consecutive idle polls are required, default 2"),
    ...clientTargetSchema(),
}, async ({ timeoutMs, pollMs, stablePolls, instanceId, playerName, port }) => {
    const startedAt = Date.now();
    const timeout = Math.max(1, timeoutMs ?? 10000);
    const interval = Math.max(100, pollMs ?? 500);
    const requiredStablePolls = Math.max(1, stablePolls ?? 2);
    let idlePolls = 0;
    let lastState = {};
    try {
        while (Date.now() - startedAt <= timeout) {
            const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port }, true);
            lastState = snapshot.state ?? {};
            if (isPlayerIdle(lastState)) {
                idlePolls += 1;
                if (idlePolls >= requiredStablePolls) {
                    return {
                        content: [{
                                type: "text",
                                text: JSON.stringify({ idle: true, waitedMs: Date.now() - startedAt, stablePolls: idlePolls, state: lastState }, null, 2)
                            }]
                    };
                }
            }
            else {
                idlePolls = 0;
            }
            await sleep(interval);
        }
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({ idle: false, waitedMs: Date.now() - startedAt, stablePolls: idlePolls, state: lastState }, null, 2)
                }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error waiting for idle: ${e.message}` }] };
    }
});
server.tool("wait_until_location", "Poll fresh snapshots until the player is within a Chebyshev tile radius of a world location.", {
    worldX: z.number().describe("Target world X tile"),
    worldY: z.number().describe("Target world Y tile"),
    plane: z.number().optional().describe("Required plane, omitted means any plane"),
    radius: z.number().optional().describe("Accepted tile radius, default 1"),
    timeoutMs: z.number().optional().describe("Maximum wait time in milliseconds, default 15000"),
    pollMs: z.number().optional().describe("Polling interval in milliseconds, default 500"),
    ...clientTargetSchema(),
}, async ({ worldX, worldY, plane, radius, timeoutMs, pollMs, instanceId, playerName, port }) => {
    const startedAt = Date.now();
    const timeout = Math.max(1, timeoutMs ?? 15000);
    const interval = Math.max(100, pollMs ?? 500);
    const acceptedRadius = Math.max(0, radius ?? 1);
    let lastLocation = null;
    let lastDistance = Number.MAX_SAFE_INTEGER;
    try {
        while (Date.now() - startedAt <= timeout) {
            const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port }, true);
            lastLocation = snapshot.state?.location;
            lastDistance = tileDistance(lastLocation, worldX, worldY, plane);
            if (lastDistance <= acceptedRadius) {
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify({ reached: true, waitedMs: Date.now() - startedAt, distance: lastDistance, location: lastLocation }, null, 2)
                        }]
                };
            }
            await sleep(interval);
        }
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({ reached: false, waitedMs: Date.now() - startedAt, distance: lastDistance, location: lastLocation }, null, 2)
                }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error waiting for location: ${e.message}` }] };
    }
});
server.tool("wait_for_chat_message", "Poll recent chat/game messages until a fresh message contains the requested text.", {
    text: z.string().describe("Message substring to wait for"),
    type: z.string().optional().describe("Optional RuneLite chat message type filter, for example GAMEMESSAGE or SPAM"),
    caseSensitive: z.boolean().optional().describe("Whether matching is case-sensitive"),
    sinceNow: z.boolean().optional().describe("Ignore old buffered messages and only match messages captured after the tool starts, default true"),
    timeoutMs: z.number().optional().describe("Maximum wait time in milliseconds, default 10000"),
    pollMs: z.number().optional().describe("Polling interval in milliseconds, default 500"),
    limit: z.number().optional().describe("Recent message count to scan per poll, default 50"),
    ...clientTargetSchema(),
}, async ({ text, type, caseSensitive, sinceNow, timeoutMs, pollMs, limit, instanceId, playerName, port }) => {
    const startedAt = Date.now();
    const timeout = Math.max(1, timeoutMs ?? 10000);
    const interval = Math.max(100, pollMs ?? 500);
    const onlyFresh = sinceNow ?? true;
    let lastMessages = [];
    try {
        const api = await apiForTarget({ instanceId, playerName, port });
        while (Date.now() - startedAt <= timeout) {
            const res = await api.get("/chat", { params: { limit: limit ?? 50 } });
            lastMessages = res.data?.messages ?? [];
            const match = lastMessages.find((message) => (!onlyFresh || Number(message.capturedAt ?? 0) >= startedAt) &&
                matchesChatMessage(message, text, caseSensitive, type));
            if (match) {
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify({ matched: true, waitedMs: Date.now() - startedAt, message: match }, null, 2)
                        }]
                };
            }
            await sleep(interval);
        }
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({ matched: false, waitedMs: Date.now() - startedAt, scanned: lastMessages.length, lastMessages }, null, 2)
                }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error waiting for chat message: ${e.message}` }] };
    }
});
server.tool("get_stream_status", "Inspect the MCP server's live /api/stream snapshot cache status for a RuneLite client.", {
    ...clientTargetSchema(),
}, async ({ instanceId, playerName, port }) => {
    try {
        const baseURL = await resolveRuneliteApi({ instanceId, playerName, port });
        if (await ensureSnapshotStreamSupported(baseURL)) {
            startSnapshotStream(baseURL);
        }
        return { content: [{ type: "text", text: JSON.stringify(snapshotStreamStatus(baseURL), null, 2) }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("checking stream status", e) }] };
    }
});
server.tool("list_clients", "List active OSRS MCP RuneLite plugin clients discovered on local ports 8080-8090", {}, async () => {
    try {
        const clients = await discoverClients();
        return {
            content: [{ type: "text", text: JSON.stringify({ selectedBaseUrl: selectedRuneliteApi, clients }, null, 2) }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("listing clients", e) }] };
    }
});
server.tool("select_client", "Select the active RuneLite client by instanceId, playerName, or port. Required when multiple clients are active.", {
    instanceId: z.string().optional(),
    playerName: z.string().optional(),
    port: z.number().optional(),
}, async ({ instanceId, playerName, port }) => {
    try {
        const clients = await discoverClients();
        const matches = clients.filter((client) => (instanceId && client.instanceId === instanceId) ||
            (playerName && String(client.playerName ?? "").toLowerCase() === playerName.toLowerCase()) ||
            (port !== undefined && client.port === port));
        if (matches.length !== 1) {
            return {
                content: [{
                        type: "text",
                        text: `Expected exactly one matching client, found ${matches.length}.\n${JSON.stringify(clients, null, 2)}`
                    }]
            };
        }
        selectedRuneliteApi = matches[0].baseUrl;
        selectedClientInstanceId = matches[0].instanceId;
        return {
            content: [{ type: "text", text: `Selected OSRS MCP client ${matches[0].instanceId} at ${selectedRuneliteApi}` }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: errorText("selecting client", e) }] };
    }
});
server.tool("click_object", "Refresh the newest object snapshot, find a matching object, and click its fresh clickbox-backed screenX/screenY.", {
    name: z.string().optional().describe("Object name, for example Tree"),
    id: z.number().optional().describe("Object ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching object to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
}, async ({ name, id, nearestToPlayer, maxAgeMs, rightClick, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
        await assertClientReady(baseURL);
        const objects = snapshot.objects ?? [];
        const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
        const matches = sortNearestToPlayer(sortByDistance(objects.filter((object) => targetMatches(object, name, id))), playerLocation);
        const target = matches.find((object) => object.coordinateSource === "clickbox" && Number.isFinite(object.screenX) && Number.isFinite(object.screenY));
        requireFreshClickable(target, maxAgeMs ?? 600, "clickbox");
        await clickPoint(target.screenX, target.screenY, rightClick);
        return { content: [{ type: "text", text: `Clicked object ${target.name} (${target.id}) at ${target.screenX}, ${target.screenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error clicking object: ${e.message}` }] };
    }
});
server.tool("hover_object", "Refresh the newest object snapshot, find a matching object, and move the mouse to its fresh clickbox-backed screenX/screenY without clicking.", {
    name: z.string().optional().describe("Object name, for example Tree"),
    id: z.number().optional().describe("Object ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching object to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    ...clientTargetSchema(),
}, async ({ name, id, nearestToPlayer, maxAgeMs, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
        await assertClientReady(baseURL);
        const objects = snapshot.objects ?? [];
        const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
        const matches = sortNearestToPlayer(sortByDistance(objects.filter((object) => targetMatches(object, name, id))), playerLocation);
        const target = matches.find((object) => object.coordinateSource === "clickbox" && Number.isFinite(object.screenX) && Number.isFinite(object.screenY));
        requireFreshClickable(target, maxAgeMs ?? 600, "clickbox");
        await movePoint(target.screenX, target.screenY);
        return { content: [{ type: "text", text: `Moved mouse to object ${target.name} (${target.id}) at ${target.screenX}, ${target.screenY} without clicking.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error hovering object: ${e.message}` }] };
    }
});
server.tool("click_npc", "Refresh the newest NPC snapshot, find a matching NPC, and click its fresh convexHull-backed screenX/screenY.", {
    name: z.string().optional().describe("NPC name"),
    id: z.number().optional().describe("NPC ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching NPC to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
}, async ({ name, id, nearestToPlayer, maxAgeMs, rightClick, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
        await assertClientReady(baseURL);
        const npcs = snapshot.npcs ?? [];
        const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
        const matches = sortNearestToPlayer(sortByDistance(npcs.filter((npc) => targetMatches(npc, name, id))), playerLocation);
        const target = matches.find((npc) => npc.coordinateSource === "convexHull" && Number.isFinite(npc.screenX) && Number.isFinite(npc.screenY));
        requireFreshClickable(target, maxAgeMs ?? 600, "convexHull");
        await clickPoint(target.screenX, target.screenY, rightClick);
        return { content: [{ type: "text", text: `Clicked NPC ${target.name} (${target.id}) at ${target.screenX}, ${target.screenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error clicking NPC: ${e.message}` }] };
    }
});
server.tool("hover_npc", "Refresh the newest NPC snapshot, find a matching NPC, and move the mouse to its fresh convexHull-backed screenX/screenY without clicking.", {
    name: z.string().optional().describe("NPC name"),
    id: z.number().optional().describe("NPC ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching NPC to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    ...clientTargetSchema(),
}, async ({ name, id, nearestToPlayer, maxAgeMs, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
        await assertClientReady(baseURL);
        const npcs = snapshot.npcs ?? [];
        const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
        const matches = sortNearestToPlayer(sortByDistance(npcs.filter((npc) => targetMatches(npc, name, id))), playerLocation);
        const target = matches.find((npc) => npc.coordinateSource === "convexHull" && Number.isFinite(npc.screenX) && Number.isFinite(npc.screenY));
        requireFreshClickable(target, maxAgeMs ?? 600, "convexHull");
        await movePoint(target.screenX, target.screenY);
        return { content: [{ type: "text", text: `Moved mouse to NPC ${target.name} (${target.id}) at ${target.screenX}, ${target.screenY} without clicking.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error hovering NPC: ${e.message}` }] };
    }
});
server.tool("click_ground_item", "Refresh the newest ground-item snapshot, find a matching item, and click its fresh screenX/screenY.", {
    name: z.string().optional().describe("Ground item name"),
    id: z.number().optional().describe("Item ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching item to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
}, async ({ name, id, nearestToPlayer, maxAgeMs, rightClick, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
        await assertClientReady(baseURL);
        const items = snapshot.groundItems ?? [];
        const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
        const matches = sortNearestToPlayer(sortByDistance(items.filter((item) => targetMatches(item, name, id))), playerLocation);
        const target = matches.find((item) => Number.isFinite(item.screenX) && Number.isFinite(item.screenY));
        requireFreshClickable(target, maxAgeMs ?? 600);
        await clickPoint(target.screenX, target.screenY, rightClick);
        return { content: [{ type: "text", text: `Clicked ground item ${target.name} (${target.id}) at ${target.screenX}, ${target.screenY}.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error clicking ground item: ${e.message}` }] };
    }
});
server.tool("hover_ground_item", "Refresh the newest ground-item snapshot, find a matching item, and move the mouse to its fresh screenX/screenY without clicking.", {
    name: z.string().optional().describe("Ground item name"),
    id: z.number().optional().describe("Item ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching item to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    ...clientTargetSchema(),
}, async ({ name, id, nearestToPlayer, maxAgeMs, instanceId, playerName, port }) => {
    try {
        const targetClient = { instanceId, playerName, port };
        const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
        await assertClientReady(baseURL);
        const items = snapshot.groundItems ?? [];
        const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
        const matches = sortNearestToPlayer(sortByDistance(items.filter((item) => targetMatches(item, name, id))), playerLocation);
        const target = matches.find((item) => Number.isFinite(item.screenX) && Number.isFinite(item.screenY));
        requireFreshClickable(target, maxAgeMs ?? 600);
        await movePoint(target.screenX, target.screenY);
        return { content: [{ type: "text", text: `Moved mouse to ground item ${target.name} (${target.id}) at ${target.screenX}, ${target.screenY} without clicking.` }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error hovering ground item: ${e.message}` }] };
    }
});
// --- Action Tools (OS-Level) ---
server.tool("move_mouse", "Moves the hardware mouse to an absolute desktop screen X/Y coordinate without clicking. Use this to verify RuneLite screenX/screenY safely.", {
    x: z.number().describe("The absolute desktop screen X coordinate, usually a screenX value from the RuneLite API"),
    y: z.number().describe("The absolute desktop screen Y coordinate, usually a screenY value from the RuneLite API")
}, async ({ x, y }) => {
    try {
        await movePoint(x, y);
        return {
            content: [{ type: "text", text: `Successfully moved mouse to ${x}, ${y} without clicking.` }]
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: `Error moving mouse: ${e.message}` }] };
    }
});
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
        const normalized = keyName.toLowerCase();
        const keyMap = {
            space: Key.Space,
            escape: Key.Escape,
            esc: Key.Escape,
            enter: Key.Enter,
            return: Key.Enter,
            tab: Key.Tab,
            backspace: Key.Backspace,
            delete: Key.Delete,
            up: Key.Up,
            arrowup: Key.Up,
            down: Key.Down,
            arrowdown: Key.Down,
            left: Key.Left,
            arrowleft: Key.Left,
            right: Key.Right,
            arrowright: Key.Right,
            f1: Key.F1,
            f2: Key.F2,
            f3: Key.F3,
            f4: Key.F4,
            f5: Key.F5,
            f6: Key.F6,
            f7: Key.F7,
            f8: Key.F8,
            f9: Key.F9,
            f10: Key.F10,
            f11: Key.F11,
            f12: Key.F12,
            "0": Key.Num0,
            "1": Key.Num1,
            "2": Key.Num2,
            "3": Key.Num3,
            "4": Key.Num4,
            "5": Key.Num5,
            "6": Key.Num6,
            "7": Key.Num7,
            "8": Key.Num8,
            "9": Key.Num9,
        };
        const k = keyMap[normalized];
        if (k === undefined) {
            return { content: [{ type: "text", text: `Unsupported key: ${keyName}` }] };
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
