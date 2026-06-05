import { UndirectedGraph } from "graphology";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tileDistance } from "./navigation.js";

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

type TransportGraphData = {
  version: number;
  scope: string;
  nodes: TransportNode[];
  edges: TransportEdge[];
};

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
  return data.nodes.find((node) =>
    normalize(node.id) === normalized ||
    normalize(node.name) === normalized ||
    (node.tags ?? []).some((tag) => normalize(tag) === normalized)
  ) ?? data.nodes.find((node) =>
    normalize(node.id).includes(normalized) ||
    normalize(node.name).includes(normalized) ||
    (node.tags ?? []).some((tag) => normalize(tag).includes(normalized))
  );
}

export function nearestTransportNode(location: any): TransportNode | undefined {
  if (!location || !Number.isFinite(location.x) || !Number.isFinite(location.y)) {
    return undefined;
  }
  return [...data.nodes].sort((a, b) =>
    tileDistance(location, a.worldX, a.worldY, a.plane) - tileDistance(location, b.worldX, b.worldY, b.plane)
  )[0];
}

export function planTransportRoute(args: {
  from?: string;
  to: string;
  currentLocation?: any;
}) {
  const fromNode = args.from ? findTransportNode(args.from) : nearestTransportNode(args.currentLocation);
  const toNode = findTransportNode(args.to);

  if (!fromNode || !toNode) {
    return {
      status: "ROUTE_NOT_FOUND",
      from: args.from,
      to: args.to,
      fromResolved: fromNode,
      toResolved: toNode,
      graph: transportGraphSummary(),
      stopReason: !fromNode ? "Could not resolve start node." : "Could not resolve destination node.",
    };
  }

  const graph = buildGraph();
  const routeIds = dijkstra(graph, fromNode.id, toNode.id);
  if (!routeIds) {
    return {
      status: "ROUTE_NOT_FOUND",
      fromResolved: fromNode,
      toResolved: toNode,
      graph: transportGraphSummary(),
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
      edgeFromPrevious: edge ? {
        mode: edge.mode,
        cost: edge.cost ?? edgeCost(nodeById(edge.from), nodeById(edge.to)),
        requirements: edge.requirements,
        risk: edge.risk,
        members: edge.members,
        f2p: edge.f2p,
        action: edge.action,
      } : undefined,
    } satisfies TransportRouteStep;
  });

  return {
    status: "ROUTE_PLANNED",
    provider: "graphology_transport_graph",
    callsLlm: false,
    fromResolved: fromNode,
    toResolved: toNode,
    totalCost: steps.slice(1).reduce((sum, step) => sum + (step.edgeFromPrevious?.cost ?? 0), 0),
    steps,
    finalTile: {
      worldX: toNode.worldX,
      worldY: toNode.worldY,
      plane: toNode.plane ?? 0,
    },
    graph: {
      version: data.version,
      scope: data.scope,
      nodeCount: data.nodes.length,
      edgeCount: data.edges.length,
    },
  };
}

export function nextRouteWaypoint(route: any, currentLocation?: any, reachedRadius = 8): TransportRouteStep | undefined {
  const steps = Array.isArray(route?.steps) ? route.steps as TransportRouteStep[] : [];
  if (steps.length === 0) {
    return undefined;
  }

  if (!currentLocation || !Number.isFinite(currentLocation.x) || !Number.isFinite(currentLocation.y)) {
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

function buildGraph() {
  const graph = new UndirectedGraph();
  for (const node of data.nodes) {
    graph.addNode(node.id, node);
  }
  for (const edge of data.edges) {
    graph.addUndirectedEdgeWithKey(`${edge.from}:${edge.to}`, edge.from, edge.to, {
      ...edge,
      weight: edge.cost ?? edgeCost(nodeById(edge.from), nodeById(edge.to)),
    });
  }
  return graph;
}

function dijkstra(graph: InstanceType<typeof UndirectedGraph>, source: string, target: string): string[] | undefined {
  const distances = new Map<string, number>();
  const previous = new Map<string, string>();
  const unsettled = new Set<string>();

  graph.forEachNode((node: string) => {
    distances.set(node, node === source ? 0 : Number.POSITIVE_INFINITY);
    unsettled.add(node);
  });

  while (unsettled.size > 0) {
    const current = [...unsettled].sort((a, b) => (distances.get(a) ?? Infinity) - (distances.get(b) ?? Infinity))[0];
    if (!current || (distances.get(current) ?? Infinity) === Infinity) {
      break;
    }
    unsettled.delete(current);
    if (current === target) {
      return unwindPath(previous, target);
    }

    graph.forEachNeighbor(current, (neighbor: string) => {
      if (!unsettled.has(neighbor)) {
        return;
      }
      const edgeAttributes = graph.getEdgeAttributes(current, neighbor) as { weight?: number };
      const alternate = (distances.get(current) ?? Infinity) + (edgeAttributes.weight ?? 1);
      if (alternate < (distances.get(neighbor) ?? Infinity)) {
        distances.set(neighbor, alternate);
        previous.set(neighbor, current);
      }
    });
  }

  return source === target ? [source] : undefined;
}

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

function edgeBetween(a: string, b: string) {
  return data.edges.find((edge) =>
    (edge.from === a && edge.to === b) ||
    (edge.from === b && edge.to === a)
  );
}

function edgeCost(a: TransportNode, b: TransportNode) {
  return Math.max(Math.abs(a.worldX - b.worldX), Math.abs(a.worldY - b.worldY));
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}
