import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import { mouse, Point, keyboard, Key } from "@nut-tree-fork/nut-js";

type RuneLiteTarget = {
  id?: number;
  name?: string;
  option?: string;
  target?: string;
  worldX?: number;
  worldY?: number;
  coordinateSource?: string;
  screenX?: number;
  screenY?: number;
  slotScreenX?: number;
  slotScreenY?: number;
  ageMs?: number;
  distanceToPlayer?: number;
  coordinateWarning?: string;
};

type ClientTarget = {
  instanceId?: string;
  playerName?: string;
  port?: number;
};

type RuneLiteSnapshot = {
  state?: any;
  npcs?: RuneLiteTarget[];
  dialogue?: any;
  objects?: RuneLiteTarget[];
  groundItems?: RuneLiteTarget[];
  inventory?: RuneLiteTarget[];
  bank?: RuneLiteTarget[];
  equipment?: RuneLiteTarget[];
  skills?: any;
  ageMs?: number;
};

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
let selectedClientInstanceId: string | undefined;
const configuredApiTimeoutMs = Number(process.env.OSRS_API_TIMEOUT_MS ?? "3000");
const API_TIMEOUT_MS = Number.isFinite(configuredApiTimeoutMs) && configuredApiTimeoutMs > 0
  ? configuredApiTimeoutMs
  : 3000;
const configuredSnapshotCacheTtlMs = Number(process.env.OSRS_SNAPSHOT_CACHE_TTL_MS ?? "250");
const SNAPSHOT_CACHE_TTL_MS = Number.isFinite(configuredSnapshotCacheTtlMs) && configuredSnapshotCacheTtlMs >= 0
  ? configuredSnapshotCacheTtlMs
  : 250;
const snapshotCache = new Map<string, { fetchedAt: number; snapshot: RuneLiteSnapshot; inflight?: Promise<RuneLiteSnapshot> }>();

function runeliteApi(baseURL = selectedRuneliteApi) {
  return axios.create({
    baseURL,
    timeout: API_TIMEOUT_MS,
  });
}

function errorText(action: string, e: any): string {
  const status = e?.response?.status ? ` HTTP ${e.response.status}` : "";
  const responseData = e?.response?.data ? ` ${JSON.stringify(e.response.data)}` : "";
  return `Error ${action}:${status} ${e?.message ?? String(e)}${responseData}`;
}

function apiBaseFromPort(port: number): string {
  return `http://localhost:${port}/api`;
}

function runeliteApiForPort(port?: number) {
  return runeliteApi(port === undefined ? selectedRuneliteApi : apiBaseFromPort(port));
}

async function getSnapshotForBase(baseURL: string, force = false): Promise<RuneLiteSnapshot> {
  const now = Date.now();
  const cached = snapshotCache.get(baseURL);
  if (!force && cached && now - cached.fetchedAt <= SNAPSHOT_CACHE_TTL_MS) {
    return cached.snapshot;
  }
  if (!force && cached?.inflight) {
    return cached.inflight;
  }

  const inflight = runeliteApi(baseURL).get("/snapshot").then((res) => {
    const snapshot = res.data as RuneLiteSnapshot;
    snapshotCache.set(baseURL, { fetchedAt: Date.now(), snapshot });
    return snapshot;
  }).catch((error) => {
    if (cached) {
      snapshotCache.set(baseURL, { fetchedAt: cached.fetchedAt, snapshot: cached.snapshot });
    } else {
      snapshotCache.delete(baseURL);
    }
    throw error;
  });

  snapshotCache.set(baseURL, { fetchedAt: cached?.fetchedAt ?? 0, snapshot: cached?.snapshot ?? {}, inflight });
  return inflight;
}

async function discoverClients() {
  const ports = Array.from({ length: 11 }, (_, index) => 8080 + index);
  const clients = [];
  for (const port of ports) {
    try {
      const baseURL = apiBaseFromPort(port);
      const res = await axios.get(`${baseURL}/identity`, { timeout: 600 });
      clients.push({ ...res.data, baseUrl: baseURL });
    } catch {
      // Ignore closed ports during discovery.
    }
  }
  return clients;
}

async function resolveRuneliteApi(target: ClientTarget = {}) {
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
  const matches = clients.filter((client: any) =>
    (target.instanceId && client.instanceId === target.instanceId) ||
    (target.playerName && String(client.playerName ?? "").toLowerCase() === target.playerName.toLowerCase()) ||
    (!target.instanceId && !target.playerName && selectedClientInstanceId && client.instanceId === selectedClientInstanceId)
  );

  if (matches.length !== 1) {
    throw new Error(`Expected exactly one matching RuneLite client, found ${matches.length}. Clients: ${JSON.stringify(clients)}`);
  }

  selectedRuneliteApi = matches[0].baseUrl;
  selectedClientInstanceId = matches[0].instanceId;
  return selectedRuneliteApi;
}

async function apiForTarget(target: ClientTarget = {}) {
  return runeliteApi(await resolveRuneliteApi(target));
}

async function getSnapshotForTarget(target: ClientTarget = {}, force = false) {
  const baseURL = await resolveRuneliteApi(target);
  return {
    baseURL,
    snapshot: await getSnapshotForBase(baseURL, force),
  };
}

async function assertClientReady(baseURL: string) {
  const identity = (await runeliteApi(baseURL).get("/identity")).data;
  if (identity?.windowMinimized) {
    throw new Error(`RuneLite client ${identity.instanceId ?? baseURL} is minimized`);
  }
  if (identity?.canvasShowing === false) {
    throw new Error(`RuneLite client ${identity.instanceId ?? baseURL} canvas is not visible`);
  }
  return identity;
}

function targetMatches(entity: any, name?: string, id?: number) {
  if (id !== undefined && entity.id !== id) {
    return false;
  }
  if (name && String(entity.name ?? "").toLowerCase() !== name.toLowerCase()) {
    return false;
  }
  return true;
}

function requireFreshClickable(target: RuneLiteTarget | undefined, maxAgeMs: number, coordinateSource?: string): asserts target is RuneLiteTarget & { screenX: number; screenY: number } {
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

async function clickPoint(x: number, y: number, rightClick?: boolean) {
  await mouse.setPosition(new Point(x, y));
  if (rightClick) {
    await mouse.rightClick();
  } else {
    await mouse.leftClick();
  }
}

async function getPlayerLocation(target: ClientTarget = {}) {
  const { snapshot } = await getSnapshotForTarget(target);
  return snapshot.state?.location;
}

function sortNearestToPlayer<T extends RuneLiteTarget>(items: T[], playerLocation: any): T[] {
  if (!playerLocation) {
    return items;
  }
  return items.slice().sort((a, b) => {
    const da = Math.abs((a.worldX ?? 0) - playerLocation.x) + Math.abs((a.worldY ?? 0) - playerLocation.y);
    const db = Math.abs((b.worldX ?? 0) - playerLocation.x) + Math.abs((b.worldY ?? 0) - playerLocation.y);
    return da - db;
  });
}

function sortByDistance<T extends RuneLiteTarget>(items: T[]): T[] {
  return items.slice().sort((a, b) => (a.distanceToPlayer ?? Number.MAX_SAFE_INTEGER) - (b.distanceToPlayer ?? Number.MAX_SAFE_INTEGER));
}

function formatTarget(target: RuneLiteTarget | undefined): string {
  if (!target) {
    return "No matching target found";
  }
  return JSON.stringify(target, null, 2);
}

function freshEnough(target: RuneLiteTarget, maxAgeMs: number): boolean {
  return target.ageMs === undefined || target.ageMs <= maxAgeMs;
}

function hasScreenPoint(target: RuneLiteTarget): boolean {
  return Number.isFinite(target.screenX) && Number.isFinite(target.screenY);
}

function clientTargetSchema() {
  return {
    instanceId: z.string().optional().describe("Optional RuneLite plugin instanceId to target"),
    playerName: z.string().optional().describe("Optional player name to target"),
    port: z.number().optional().describe("Optional RuneLite API port to target, for example 8081"),
  };
}

async function selectContextMenuOption(text: string, target: ClientTarget = {}, exact?: boolean) {
  const baseURL = await resolveRuneliteApi(target);
  await assertClientReady(baseURL);
  const menu = (await runeliteApi(baseURL).get("/context_menu")).data;
  if (!menu?.isOpen) {
    throw new Error("Context menu is not open");
  }

  const needle = text.toLowerCase();
  const entries = (menu.entries ?? []) as RuneLiteTarget[];
  const match = entries.find((entry: RuneLiteTarget) => {
    const optionText = `${entry.option ?? ""} ${entry.target ?? ""}`.trim().toLowerCase();
    return exact ? optionText === needle || String(entry.option ?? "").toLowerCase() === needle : optionText.includes(needle);
  });

  requireFreshClickable(match, 1000);
  await clickPoint(match.screenX, match.screenY);
  return match;
}

// --- State Reading Tools ---

server.tool("get_game_state", "Get current player state, location, and health", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.state ?? {}, null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching state", e) }] };
  }
});

server.tool("get_inventory", "Get the items currently in the player's inventory", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.inventory ?? [], null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching inventory", e) }] };
  }
});

server.tool("get_npcs", "Get a list of nearby NPCs with canvas coordinates and absolute desktop screen coordinates", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.npcs ?? [], null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching NPCs", e) }] };
  }
});

server.tool("get_dialogue", "Check for open NPC dialogues, player dialogues, or dialogue options with absolute desktop screen coordinates when clickable", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.dialogue ?? {}, null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching dialogue", e) }] };
  }
});

server.tool("get_game_objects", "Get a list of interactable game objects (trees, doors, rocks) with names and absolute desktop screen coordinates", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.objects ?? [], null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching game objects", e) }] };
  }
});

server.tool("get_ground_items", "Get a list of items dropped on the ground with names and absolute desktop screen coordinates", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.groundItems ?? [], null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching ground items", e) }] };
  }
});

server.tool("get_bank", "Get all items currently in the player's bank (if the bank interface is open)", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.bank ?? [], null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching bank", e) }] };
  }
});

server.tool("get_equipment", "Get all items currently equipped by the player", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.equipment ?? [], null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching equipment", e) }] };
  }
});

server.tool("get_skills", "Get the player's level, boosted level, and XP for all 23 skills", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot.skills ?? {}, null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching skills", e) }] };
  }
});

server.tool("get_coordinate_debug", "Get RuneLite canvas origin, canvas size, DPI transform, mouse position, and player coordinate debug data", { ...clientTargetSchema() }, async ({ instanceId, playerName, port }) => {
  try {
    const res = await (await apiForTarget({ instanceId, playerName, port })).get("/debug/coordinates");
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("fetching coordinate debug", e) }] };
  }
});

server.tool(
  "get_latest_snapshot",
  "Get the latest cached RuneLite snapshot with state, NPCs, dialogue, objects, ground items, tick, capturedAt, and ageMs.",
  {
    ...clientTargetSchema(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port }, true);
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching latest snapshot", e) }] };
    }
  }
);

server.tool(
  "get_player_location",
  "Get the current player name, world location, health, run energy, tick, capturedAt, and ageMs.",
  {
    ...clientTargetSchema(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const { snapshot } = await getSnapshotForTarget({ instanceId, playerName, port });
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot.state ?? {}, null, 2) }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching player location", e) }] };
    }
  }
);

server.tool(
  "find_nearest_object",
  "Refresh object data and return the nearest matching object without clicking.",
  {
    name: z.string().optional().describe("Object name, for example Tree"),
    id: z.number().optional().describe("Object ID"),
    requireClickable: z.boolean().optional().describe("Only return objects with screenX/screenY"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 1000"),
    ...clientTargetSchema(),
  },
  async ({ name, id, requireClickable, maxAgeMs, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { snapshot } = await getSnapshotForTarget(targetClient, true);
      const objects = snapshot.objects ?? [];
      const playerLocation = snapshot.state?.location;
      const matches = sortNearestToPlayer(
        sortByDistance(objects.filter((object: any) => targetMatches(object, name, id))),
        playerLocation
      ).filter((object) => freshEnough(object, maxAgeMs ?? 1000))
        .filter((object) => !requireClickable || hasScreenPoint(object));
      return { content: [{ type: "text", text: formatTarget(matches[0]) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("finding nearest object", e) }] };
    }
  }
);

server.tool(
  "find_nearest_npc",
  "Refresh NPC data and return the nearest matching NPC without clicking.",
  {
    name: z.string().optional().describe("NPC name"),
    id: z.number().optional().describe("NPC ID"),
    requireClickable: z.boolean().optional().describe("Only return NPCs with screenX/screenY"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 1000"),
    ...clientTargetSchema(),
  },
  async ({ name, id, requireClickable, maxAgeMs, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { snapshot } = await getSnapshotForTarget(targetClient, true);
      const npcs = snapshot.npcs ?? [];
      const playerLocation = snapshot.state?.location;
      const matches = sortNearestToPlayer(
        sortByDistance(npcs.filter((npc: any) => targetMatches(npc, name, id))),
        playerLocation
      ).filter((npc) => freshEnough(npc, maxAgeMs ?? 1000))
        .filter((npc) => !requireClickable || hasScreenPoint(npc));
      return { content: [{ type: "text", text: formatTarget(matches[0]) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("finding nearest NPC", e) }] };
    }
  }
);

server.tool(
  "find_nearest_ground_item",
  "Refresh ground-item data and return the nearest matching item without clicking.",
  {
    name: z.string().optional().describe("Ground item name"),
    id: z.number().optional().describe("Item ID"),
    requireClickable: z.boolean().optional().describe("Only return items with screenX/screenY"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 1000"),
    ...clientTargetSchema(),
  },
  async ({ name, id, requireClickable, maxAgeMs, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { snapshot } = await getSnapshotForTarget(targetClient, true);
      const items = snapshot.groundItems ?? [];
      const playerLocation = snapshot.state?.location;
      const matches = sortNearestToPlayer(
        sortByDistance(items.filter((item: any) => targetMatches(item, name, id))),
        playerLocation
      ).filter((item) => freshEnough(item, maxAgeMs ?? 1000))
        .filter((item) => !requireClickable || hasScreenPoint(item));
      return { content: [{ type: "text", text: formatTarget(matches[0]) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("finding nearest ground item", e) }] };
    }
  }
);

server.tool(
  "get_minimap",
  "Read minimap bounds and optionally project a world tile to minimap screen coordinates.",
  {
    worldX: z.number().optional().describe("Optional target world X tile to project"),
    worldY: z.number().optional().describe("Optional target world Y tile to project"),
    plane: z.number().optional().describe("Optional target plane"),
    ...clientTargetSchema(),
  },
  async ({ worldX, worldY, plane, instanceId, playerName, port }) => {
    try {
      const params = worldX !== undefined && worldY !== undefined ? { worldX, worldY, plane } : undefined;
      const res = await (await apiForTarget({ instanceId, playerName, port })).get("/minimap", { params });
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching minimap", e) }] };
    }
  }
);

server.tool(
  "get_context_menu",
  "Read the current RuneLite right-click/context menu entries and row screen coordinates when the menu is open.",
  {
    ...clientTargetSchema(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const res = await (await apiForTarget({ instanceId, playerName, port })).get("/context_menu");
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching context menu", e) }] };
    }
  }
);

server.tool(
  "select_option",
  "Select an option from the currently open RuneLite right-click/context menu by visible option text.",
  {
    text: z.string().describe("Visible menu option text, for example Attack, Talk-to, Use, Drop, Deposit-All"),
    exact: z.boolean().optional().describe("Require exact option text instead of substring matching"),
    ...clientTargetSchema(),
  },
  async ({ text, exact, instanceId, playerName, port }) => {
    try {
      const match = await selectContextMenuOption(text, { instanceId, playerName, port }, exact);
      return { content: [{ type: "text", text: `Selected context option ${match.option ?? ""} ${match.target ?? ""}`.trim() }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error selecting context option: ${e.message}` }] };
    }
  }
);

server.tool(
  "walk_to",
  "Project a nearby world tile onto the minimap and click it. This is minimum viable navigation for loaded/nearby targets.",
  {
    worldX: z.number().describe("Target world X tile"),
    worldY: z.number().describe("Target world Y tile"),
    plane: z.number().optional().describe("Target plane, defaults to 0 if omitted"),
    ...clientTargetSchema(),
  },
  async ({ worldX, worldY, plane, instanceId, playerName, port }) => {
    try {
      const api = await apiForTarget({ instanceId, playerName, port });
      await assertClientReady(api.defaults.baseURL ?? selectedRuneliteApi);
      const res = await api.get("/minimap", { params: { worldX, worldY, plane } });
      const target = res.data?.target as RuneLiteTarget | undefined;
      requireFreshClickable(target, 1000, "minimapProjection");
      await clickPoint(target.screenX, target.screenY);
      return { content: [{ type: "text", text: `Clicked minimap projection for ${worldX}, ${worldY}, ${plane ?? 0} at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error walking to tile: ${e.message}` }] };
    }
  }
);

server.tool(
  "click_inventory_slot",
  "Click an inventory slot using slotScreenX/slotScreenY from the live plugin snapshot.",
  {
    slot: z.number().describe("Inventory slot index 0-27"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    maxAgeMs: z.number().optional().describe("Maximum accepted slot data age in milliseconds, default 1000"),
    ...clientTargetSchema(),
  },
  async ({ slot, rightClick, maxAgeMs, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const inventory = snapshot.inventory ?? [];
      const item = inventory.find((candidate: any) => candidate.slot === slot);
      if (!item || !Number.isFinite(item.slotScreenX) || !Number.isFinite(item.slotScreenY)) {
        throw new Error(`No click-ready item found in inventory slot ${slot}`);
      }
      if (item.ageMs !== undefined && item.ageMs > (maxAgeMs ?? 1000)) {
        throw new Error(`Inventory slot data is stale: ageMs=${item.ageMs}`);
      }
      await clickPoint(item.slotScreenX!, item.slotScreenY!, rightClick);
      return { content: [{ type: "text", text: `Clicked inventory slot ${slot} (${item.name ?? item.id}) at ${item.slotScreenX}, ${item.slotScreenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error clicking inventory slot: ${e.message}` }] };
    }
  }
);

server.tool(
  "use_inventory_item",
  "Left-click the first matching inventory item by name/id, using live slot screen coordinates.",
  {
    name: z.string().optional().describe("Item name"),
    id: z.number().optional().describe("Item ID"),
    ...clientTargetSchema(),
  },
  async ({ name, id, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const inventory = snapshot.inventory ?? [];
      const item = inventory.find((candidate: any) => targetMatches(candidate, name, id) && Number.isFinite(candidate.slotScreenX) && Number.isFinite(candidate.slotScreenY));
      if (!item) {
        throw new Error("No matching inventory item with slot coordinates found");
      }
      if (item.ageMs !== undefined && item.ageMs > 1000) {
        throw new Error(`Inventory item data is stale: ageMs=${item.ageMs}`);
      }
      await clickPoint(item.slotScreenX!, item.slotScreenY!);
      return { content: [{ type: "text", text: `Used inventory item ${item.name ?? item.id} in slot ${(item as any).slot}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error using inventory item: ${e.message}` }] };
    }
  }
);

server.tool(
  "drop_inventory_item",
  "Right-click the first matching inventory item and select Drop from the context menu.",
  {
    name: z.string().optional().describe("Item name"),
    id: z.number().optional().describe("Item ID"),
    ...clientTargetSchema(),
  },
  async ({ name, id, instanceId, playerName, port }) => {
    try {
      const target = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(target, true);
      await assertClientReady(baseURL);
      const inventory = snapshot.inventory ?? [];
      const item = inventory.find((candidate: any) => targetMatches(candidate, name, id) && Number.isFinite(candidate.slotScreenX) && Number.isFinite(candidate.slotScreenY));
      if (!item) {
        throw new Error("No matching inventory item with slot coordinates found");
      }
      await clickPoint(item.slotScreenX!, item.slotScreenY!, true);
      await new Promise((resolve) => setTimeout(resolve, 120));
      await selectContextMenuOption("Drop", target, false);
      return { content: [{ type: "text", text: `Dropped inventory item ${item.name ?? item.id} from slot ${(item as any).slot}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error dropping inventory item: ${e.message}` }] };
    }
  }
);

server.tool(
  "get_chat_messages",
  "Read recent RuneLite chat/game messages buffered by the plugin.",
  {
    limit: z.number().optional().describe("Maximum messages to return, default 20"),
    ...clientTargetSchema(),
  },
  async ({ limit, instanceId, playerName, port }) => {
    try {
      const res = await (await apiForTarget({ instanceId, playerName, port })).get("/chat", { params: { limit } });
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("fetching chat messages", e) }] };
    }
  }
);

server.tool("list_clients", "List active OSRS MCP RuneLite plugin clients discovered on local ports 8080-8090", {}, async () => {
  try {
    const clients = await discoverClients();
    return {
      content: [{ type: "text", text: JSON.stringify({ selectedBaseUrl: selectedRuneliteApi, clients }, null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: errorText("listing clients", e) }] };
  }
});

server.tool(
  "select_client",
  "Select the active RuneLite client by instanceId, playerName, or port. Required when multiple clients are active.",
  {
    instanceId: z.string().optional(),
    playerName: z.string().optional(),
    port: z.number().optional(),
  },
  async ({ instanceId, playerName, port }) => {
    try {
      const clients = await discoverClients();
      const matches = clients.filter((client: any) =>
        (instanceId && client.instanceId === instanceId) ||
        (playerName && String(client.playerName ?? "").toLowerCase() === playerName.toLowerCase()) ||
        (port !== undefined && client.port === port)
      );

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
    } catch (e: any) {
      return { content: [{ type: "text", text: errorText("selecting client", e) }] };
    }
  }
);

server.tool(
  "click_object",
  "Refresh the newest object snapshot, find a matching object, and click its fresh clickbox-backed screenX/screenY.",
  {
    name: z.string().optional().describe("Object name, for example Tree"),
    id: z.number().optional().describe("Object ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching object to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
  },
  async ({ name, id, nearestToPlayer, maxAgeMs, rightClick, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const objects = snapshot.objects ?? [];
      const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
      const matches = sortNearestToPlayer(
        sortByDistance(objects.filter((object: any) => targetMatches(object, name, id))),
        playerLocation
      );
      const target = matches.find((object: any) => object.coordinateSource === "clickbox" && Number.isFinite(object.screenX) && Number.isFinite(object.screenY));
      requireFreshClickable(target, maxAgeMs ?? 600, "clickbox");
      await clickPoint(target.screenX, target.screenY, rightClick);
      return { content: [{ type: "text", text: `Clicked object ${target.name} (${target.id}) at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error clicking object: ${e.message}` }] };
    }
  }
);

server.tool(
  "click_npc",
  "Refresh the newest NPC snapshot, find a matching NPC, and click its fresh convexHull-backed screenX/screenY.",
  {
    name: z.string().optional().describe("NPC name"),
    id: z.number().optional().describe("NPC ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching NPC to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
  },
  async ({ name, id, nearestToPlayer, maxAgeMs, rightClick, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const npcs = snapshot.npcs ?? [];
      const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
      const matches = sortNearestToPlayer(
        sortByDistance(npcs.filter((npc: any) => targetMatches(npc, name, id))),
        playerLocation
      );
      const target = matches.find((npc: any) => npc.coordinateSource === "convexHull" && Number.isFinite(npc.screenX) && Number.isFinite(npc.screenY));
      requireFreshClickable(target, maxAgeMs ?? 600, "convexHull");
      await clickPoint(target.screenX, target.screenY, rightClick);
      return { content: [{ type: "text", text: `Clicked NPC ${target.name} (${target.id}) at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error clicking NPC: ${e.message}` }] };
    }
  }
);

server.tool(
  "click_ground_item",
  "Refresh the newest ground-item snapshot, find a matching item, and click its fresh screenX/screenY.",
  {
    name: z.string().optional().describe("Ground item name"),
    id: z.number().optional().describe("Item ID"),
    nearestToPlayer: z.boolean().optional().describe("Prefer the nearest matching item to the player"),
    maxAgeMs: z.number().optional().describe("Maximum accepted target age in milliseconds, default 600"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click"),
    ...clientTargetSchema(),
  },
  async ({ name, id, nearestToPlayer, maxAgeMs, rightClick, instanceId, playerName, port }) => {
    try {
      const targetClient = { instanceId, playerName, port };
      const { baseURL, snapshot } = await getSnapshotForTarget(targetClient, true);
      await assertClientReady(baseURL);
      const items = snapshot.groundItems ?? [];
      const playerLocation = nearestToPlayer ? snapshot.state?.location : null;
      const matches = sortNearestToPlayer(
        sortByDistance(items.filter((item: any) => targetMatches(item, name, id))),
        playerLocation
      );
      const target = matches.find((item: any) => Number.isFinite(item.screenX) && Number.isFinite(item.screenY));
      requireFreshClickable(target, maxAgeMs ?? 600);
      await clickPoint(target.screenX, target.screenY, rightClick);
      return { content: [{ type: "text", text: `Clicked ground item ${target.name} (${target.id}) at ${target.screenX}, ${target.screenY}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error clicking ground item: ${e.message}` }] };
    }
  }
);

// --- Action Tools (OS-Level) ---

server.tool(
  "move_mouse_and_click",
  "Moves the hardware mouse to an absolute desktop screen X/Y coordinate and clicks. Use screenX/screenY from RuneLite API results, not canvasX/canvasY.",
  {
    x: z.number().describe("The absolute desktop screen X coordinate, usually a screenX value from the RuneLite API"),
    y: z.number().describe("The absolute desktop screen Y coordinate, usually a screenY value from the RuneLite API"),
    rightClick: z.boolean().optional().describe("Whether to right click instead of left click")
  },
  async ({ x, y, rightClick }) => {
    try {
      await mouse.setPosition(new Point(x, y));
      if (rightClick) {
        await mouse.rightClick();
      } else {
        await mouse.leftClick();
      }
      return {
        content: [{ type: "text", text: `Successfully moved mouse to ${x}, ${y} and clicked.` }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error moving mouse: ${e.message}` }] };
    }
  }
);

server.tool(
  "type_text",
  "Types text using the hardware keyboard. Useful for naming character, entering bank pins, or chatting.",
  {
    text: z.string().describe("The text to type"),
    pressEnter: z.boolean().optional().describe("Whether to press Enter after typing")
  },
  async ({ text, pressEnter }) => {
    try {
      await keyboard.type(text);
      if (pressEnter) {
        await keyboard.type(Key.Enter);
      }
      return {
        content: [{ type: "text", text: `Successfully typed: "${text}"` }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error typing text: ${e.message}` }] };
    }
  }
);

server.tool(
  "press_key",
  "Press a specific key on the keyboard, like 'Space' (often used to continue dialogue) or 'Escape'.",
  {
    keyName: z.string().describe("The name of the key to press (e.g., 'Space', 'Escape', 'Enter')")
  },
  async ({ keyName }) => {
    try {
      const normalized = keyName.toLowerCase();
      const keyMap: Record<string, any> = {
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
      if (!k) {
        return { content: [{ type: "text", text: `Unsupported key: ${keyName}` }] };
      }
      await keyboard.type(k);
      return {
        content: [{ type: "text", text: `Successfully pressed key: ${keyName}` }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error pressing key: ${e.message}` }] };
    }
  }
);

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
