import { MultiDirectedGraph } from "graphology";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tileDistance } from "./navigation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransportNode = {
  id: string;
  name: string;
  worldX: number;
  worldY: number;
  plane?: number;
  tags?: string[];
};

export type TransportEdge = {
  from: string;
  to: string;
  mode: string;
  cost?: number;
  requirements?: string[];
  risk?: string;
  members?: boolean;
  f2p?: boolean;
  action?: string;
};

export type TransportRouteStep = {
  id: string;
  name: string;
  worldX: number;
  worldY: number;
  plane: number;
  edgeFromPrevious?: {
    mode: string;
    cost: number;
    requirements?: string[];
    risk?: string;
    members?: boolean;
    f2p?: boolean;
    action?: string;
  };
};

export type PlayerState = {
  magicLevel?: number;
  agilityLevel?: number;
  woodcuttingLevel?: number;
  miningLevel?: number;
  members?: boolean;
  f2pOnly?: boolean;
  availableItems?: string[];
  completedQuests?: string[];
  maxRisk?: "none" | "low" | "medium" | "high";
  wildernessAllowed?: boolean;
};

type TransportGraphData = {
  version: number;
  scope: string;
  nodes: TransportNode[];
  edges: TransportEdge[];
};

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const graphPathCandidates = [
  path.join(moduleDir, "world_graph.json"),
  path.join(moduleDir, "..", "src", "world_graph.json"),
];
const graphPath = graphPathCandidates.find((candidate) => existsSync(candidate));
if (!graphPath) {
  throw new Error(`world_graph.json not found. Checked: ${graphPathCandidates.join(", ")}`);
}
const worldGraphData = JSON.parse(readFileSync(graphPath, "utf8")) as TransportGraphData;
const data = worldGraphData;

// ---------------------------------------------------------------------------
// Risk helpers
// ---------------------------------------------------------------------------

const RISK_LEVEL: Record<string, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

// ---------------------------------------------------------------------------
// Requirement parsing helpers
// ---------------------------------------------------------------------------

/** Extract a numeric level from a requirement string like "Magic level 25". */
function parseLevelRequirement(requirements: string[] | undefined, skill: string): number | undefined {
  if (!requirements) return undefined;
  const pattern = new RegExp(`${skill}\\s+level\\s+(\\d+)`, "i");
  for (const req of requirements) {
    const match = req.match(pattern);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/** Check if any requirement string mentions a specific item name (case-insensitive). */
function findItemRequirement(requirements: string[] | undefined): string | undefined {
  if (!requirements || requirements.length === 0) return undefined;
  // The first requirement for teleport_item edges is typically the item name
  return requirements[0];
}

// ---------------------------------------------------------------------------
// Player-state edge filtering
// ---------------------------------------------------------------------------

export function filterEdgeForPlayer(edge: TransportEdge, state: PlayerState): boolean {
  // --- Membership filtering ---
  if ((state.members === false || state.f2pOnly === true) && edge.members === true) {
    return false;
  }

  // --- Wilderness / high-risk filtering ---
  if (state.wildernessAllowed !== true && edge.risk === "high") {
    return false;
  }

  // --- Max risk filtering ---
  if (state.maxRisk !== undefined && edge.risk !== undefined) {
    const edgeLevel = RISK_LEVEL[edge.risk] ?? 0;
    const maxLevel = RISK_LEVEL[state.maxRisk] ?? 3;
    if (edgeLevel > maxLevel) {
      return false;
    }
  }

  // --- Mode-specific requirement checks ---
  switch (edge.mode) {
    case "teleport_spell": {
      const required = parseLevelRequirement(edge.requirements, "Magic");
      if (required !== undefined && (state.magicLevel ?? 0) < required) {
        return false;
      }
      break;
    }

    case "agility_shortcut": {
      const required = parseLevelRequirement(edge.requirements, "Agility");
      if (required !== undefined && (state.agilityLevel ?? 0) < required) {
        return false;
      }
      break;
    }

    case "canoe": {
      const required = parseLevelRequirement(edge.requirements, "Woodcutting");
      if (required !== undefined && (state.woodcuttingLevel ?? 0) < required) {
        return false;
      }
      break;
    }

    case "stairs": {
      // Some stairs have a Mining requirement (e.g. Mining Guild door)
      const required = parseLevelRequirement(edge.requirements, "Mining");
      if (required !== undefined && (state.miningLevel ?? 0) < required) {
        return false;
      }
      break;
    }

    case "teleport_item": {
      const requiredItem = findItemRequirement(edge.requirements);
      if (requiredItem !== undefined) {
        const normalizedRequired = requiredItem.toLowerCase().trim();
        const hasItem = (state.availableItems ?? []).some(
          (item) => item.toLowerCase().trim() === normalizedRequired,
        );
        if (!hasItem) {
          return false;
        }
      }
      break;
    }

    case "fairy_ring": {
      if (state.completedQuests !== undefined) {
        const hasQuest = state.completedQuests.some(
          (q) => q.toLowerCase().includes("fairytale ii") || q.toLowerCase().includes("cure a queen"),
        );
        if (!hasQuest) {
          return false;
        }
      }
      break;
    }

    case "spirit_tree": {
      if (state.completedQuests !== undefined) {
        const hasQuest = state.completedQuests.some(
          (q) => q.toLowerCase().includes("tree gnome village"),
        );
        if (!hasQuest) {
          return false;
        }
      }
      break;
    }

    case "gnome_glider": {
      if (state.completedQuests !== undefined) {
        const hasQuest = state.completedQuests.some(
          (q) => q.toLowerCase().includes("the grand tree"),
        );
        if (!hasQuest) {
          return false;
        }
      }
      break;
    }

    // walk, boat, minecart â€” no extra level/item checks
    default:
      break;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Public query helpers
// ---------------------------------------------------------------------------

export function transportGraphSummary() {
  return {
    version: data.version,
    scope: data.scope,
    nodeCount: data.nodes.length,
    edgeCount: data.edges.length,
    nodes: data.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      worldX: node.worldX,
      worldY: node.worldY,
      plane: node.plane ?? 0,
      tags: node.tags ?? [],
    })),
  };
}

export function findTransportNode(query: string): TransportNode | undefined {
  const normalized = normalize(query);
  return (
    data.nodes.find(
      (node) =>
        normalize(node.id) === normalized ||
        normalize(node.name) === normalized ||
        (node.tags ?? []).some((tag) => normalize(tag) === normalized),
    ) ??
    data.nodes.find(
      (node) =>
        normalize(node.id).includes(normalized) ||
        normalize(node.name).includes(normalized) ||
        (node.tags ?? []).some((tag) => normalize(tag).includes(normalized)),
    )
  );
}

export function nearestTransportNode(location: any): TransportNode | undefined {
  if (!location || !Number.isFinite(location.x) || !Number.isFinite(location.y)) {
    return undefined;
  }
  return [...data.nodes].sort(
    (a, b) =>
      tileDistance(location, a.worldX, a.worldY, a.plane) -
      tileDistance(location, b.worldX, b.worldY, b.plane),
  )[0];
}

/** Return all outbound edges from a given node. */
export function getEdgesFromNode(nodeId: string): TransportEdge[] {
  return data.edges.filter((edge) => edge.from === nodeId);
}

/** Return all unique transport modes present in the graph. */
export function getTransportModes(): string[] {
  const modes = new Set<string>();
  for (const edge of data.edges) {
    modes.add(edge.mode);
  }
  return [...modes].sort();
}

// ---------------------------------------------------------------------------
// Route planning
// ---------------------------------------------------------------------------

export function planTransportRoute(args: {
  from?: string;
  to: string;
  currentLocation?: any;
  playerState?: PlayerState;
}) {
  const fromNode = args.from
    ? findTransportNode(args.from)
    : nearestTransportNode(args.currentLocation);
  const toNode = findTransportNode(args.to);

  if (!fromNode || !toNode) {
    return {
      status: "ROUTE_NOT_FOUND",
      from: args.from,
      to: args.to,
      fromResolved: fromNode,
      toResolved: toNode,
      graph: transportGraphSummary(),
      playerStateApplied: args.playerState !== undefined,
      stopReason: !fromNode
        ? "Could not resolve start node."
        : "Could not resolve destination node.",
    };
  }

  const graph = buildGraph(args.playerState);
  const routeIds = dijkstra(graph, fromNode.id, toNode.id);
  if (!routeIds) {
    return {
      status: "ROUTE_NOT_FOUND",
      fromResolved: fromNode,
      toResolved: toNode,
      graph: transportGraphSummary(),
      playerStateApplied: args.playerState !== undefined,
      stopReason: "No connected route exists in the current transport graph.",
    };
  }

  const steps = routeIds.map((id, index) => {
    const node = nodeById(id);
    const previous = index > 0 ? routeIds[index - 1] : undefined;
    const edge = previous ? edgeBetween(previous, id) : undefined;
    return {
      id: node.id,
      name: node.name,
      worldX: node.worldX,
      worldY: node.worldY,
      plane: node.plane ?? 0,
      edgeFromPrevious: edge
        ? {
            mode: edge.mode,
            cost: edge.cost ?? edgeCost(nodeById(edge.from), nodeById(edge.to)),
            requirements: edge.requirements,
            risk: edge.risk,
            members: edge.members,
            f2p: edge.f2p,
            action: edge.action,
          }
        : undefined,
    } satisfies TransportRouteStep;
  });

  return {
    status: "ROUTE_PLANNED",
    provider: "graphology_transport_graph",
    callsLlm: false,
    fromResolved: fromNode,
    toResolved: toNode,
    totalCost: steps
      .slice(1)
      .reduce((sum, step) => sum + (step.edgeFromPrevious?.cost ?? 0), 0),
    steps,
    finalTile: {
      worldX: toNode.worldX,
      worldY: toNode.worldY,
      plane: toNode.plane ?? 0,
    },
    playerStateApplied: args.playerState !== undefined,
    graph: {
      version: data.version,
      scope: data.scope,
      nodeCount: data.nodes.length,
      edgeCount: data.edges.length,
    },
  };
}

export function nextRouteWaypoint(
  route: any,
  currentLocation?: any,
  reachedRadius = 8,
): TransportRouteStep | undefined {
  const steps = Array.isArray(route?.steps)
    ? (route.steps as TransportRouteStep[])
    : [];
  if (steps.length === 0) {
    return undefined;
  }

  if (
    !currentLocation ||
    !Number.isFinite(currentLocation.x) ||
    !Number.isFinite(currentLocation.y)
  ) {
    return steps[1] ?? steps[0];
  }

  const distances = steps.map((step, index) => ({
    index,
    distance: tileDistance(currentLocation, step.worldX, step.worldY, step.plane),
  }));
  const nearest = distances.sort((a, b) => a.distance - b.distance)[0];
  if (!nearest) {
    return steps[0];
  }

  const safeRadius = Math.max(0, reachedRadius);
  if (nearest.distance <= safeRadius) {
    return steps[Math.min(nearest.index + 1, steps.length - 1)];
  }

  return steps[nearest.index];
}

// ---------------------------------------------------------------------------
// Graph construction (DirectedGraph)
// ---------------------------------------------------------------------------

function buildGraph(playerState?: PlayerState) {
  const graph = new MultiDirectedGraph();
  for (const node of data.nodes) {
    graph.addNode(node.id, node);
  }
  for (const edge of data.edges) {
    // When a playerState is provided, only add edges the player can use
    if (playerState !== undefined && !filterEdgeForPlayer(edge, playerState)) {
      continue;
    }
    graph.addDirectedEdgeWithKey(`${edge.from}:${edge.to}:${edge.mode}`, edge.from, edge.to, {
      ...edge,
      weight: effectiveCost(edge),
    });
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Dijkstra (custom implementation for DirectedGraph)
// ---------------------------------------------------------------------------

function dijkstra(
  graph: InstanceType<typeof MultiDirectedGraph>,
  source: string,
  target: string,
): string[] | undefined {
  const distances = new Map<string, number>();
  const previous = new Map<string, string>();
  const unsettled = new Set<string>();

  graph.forEachNode((node: string) => {
    distances.set(node, node === source ? 0 : Number.POSITIVE_INFINITY);
    unsettled.add(node);
  });

  while (unsettled.size > 0) {
    const current = [...unsettled].sort(
      (a, b) => (distances.get(a) ?? Infinity) - (distances.get(b) ?? Infinity),
    )[0];
    if (!current || (distances.get(current) ?? Infinity) === Infinity) {
      break;
    }
    unsettled.delete(current);
    if (current === target) {
      return unwindPath(previous, target);
    }

    // Iterate edges (not neighbors) — MultiGraph can have multiple edges per pair
    const currentDist = distances.get(current) ?? Infinity;
    graph.forEachOutboundEdge(current, (edge: string) => {
      const neighbor = graph.target(edge);
      if (!unsettled.has(neighbor)) return;
      const edgeAttrs = graph.getEdgeAttributes(edge) as { weight?: number };
      const alternate = currentDist + (edgeAttrs.weight ?? 1);
      if (alternate < (distances.get(neighbor) ?? Infinity)) {
        distances.set(neighbor, alternate);
        previous.set(neighbor, current);
      }
    });
  }

  return source === target ? [source] : undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function unwindPath(previous: Map<string, string>, target: string) {
  const path = [target];
  let current = target;
  while (previous.has(current)) {
    current = previous.get(current) as string;
    path.unshift(current);
  }
  return path;
}

function nodeById(id: string) {
  const node = data.nodes.find((candidate) => candidate.id === id);
  if (!node) {
    throw new Error(`Unknown transport node: ${id}`);
  }
  return node;
}

/** Directed: only match edge where from===a AND to===b. */
function edgeBetween(a: string, b: string) {
  return data.edges.find((edge) => edge.from === a && edge.to === b);
}

const MODE_BASE_COST: Record<string, number> = {
  walk: 1, stairs: 5, agility_shortcut: 10, canoe: 20, boat: 30,
  teleport_spell: 40, teleport_item: 50, fairy_ring: 25, spirit_tree: 25,
  gnome_glider: 35, minecart: 30,
};

function effectiveCost(edge: TransportEdge): number {
  const rawCost = edge.cost ?? edgeCost(nodeById(edge.from), nodeById(edge.to));
  if (edge.mode === "walk" || edge.mode === "stairs") return rawCost;
  return (MODE_BASE_COST[edge.mode] ?? 20) + Math.max(0, rawCost - 1) * 2;
}

function edgeCost(a: TransportNode, b: TransportNode) {
  return Math.max(Math.abs(a.worldX - b.worldX), Math.abs(a.worldY - b.worldY));
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}




