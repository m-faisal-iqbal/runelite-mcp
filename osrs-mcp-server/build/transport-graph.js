import { UndirectedGraph } from "graphology";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tileDistance } from "./navigation.js";
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const graphPathCandidates = [
    path.join(moduleDir, "world_graph.json"),
    path.join(moduleDir, "..", "src", "world_graph.json"),
];
const graphPath = graphPathCandidates.find((candidate) => existsSync(candidate));
if (!graphPath) {
    throw new Error(`world_graph.json not found. Checked: ${graphPathCandidates.join(", ")}`);
}
const worldGraphData = JSON.parse(readFileSync(graphPath, "utf8"));
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
export function findTransportNode(query) {
    const normalized = normalize(query);
    return data.nodes.find((node) => normalize(node.id) === normalized ||
        normalize(node.name) === normalized ||
        (node.tags ?? []).some((tag) => normalize(tag) === normalized)) ?? data.nodes.find((node) => normalize(node.id).includes(normalized) ||
        normalize(node.name).includes(normalized) ||
        (node.tags ?? []).some((tag) => normalize(tag).includes(normalized)));
}
export function nearestTransportNode(location) {
    if (!location || !Number.isFinite(location.x) || !Number.isFinite(location.y)) {
        return undefined;
    }
    return [...data.nodes].sort((a, b) => tileDistance(location, a.worldX, a.worldY, a.plane) - tileDistance(location, b.worldX, b.worldY, b.plane))[0];
}
export function planTransportRoute(args) {
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
            } : undefined,
        };
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
function dijkstra(graph, source, target) {
    const distances = new Map();
    const previous = new Map();
    const unsettled = new Set();
    graph.forEachNode((node) => {
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
        graph.forEachNeighbor(current, (neighbor) => {
            if (!unsettled.has(neighbor)) {
                return;
            }
            const edgeAttributes = graph.getEdgeAttributes(current, neighbor);
            const alternate = (distances.get(current) ?? Infinity) + (edgeAttributes.weight ?? 1);
            if (alternate < (distances.get(neighbor) ?? Infinity)) {
                distances.set(neighbor, alternate);
                previous.set(neighbor, current);
            }
        });
    }
    return source === target ? [source] : undefined;
}
function unwindPath(previous, target) {
    const path = [target];
    let current = target;
    while (previous.has(current)) {
        current = previous.get(current);
        path.unshift(current);
    }
    return path;
}
function nodeById(id) {
    const node = data.nodes.find((candidate) => candidate.id === id);
    if (!node) {
        throw new Error(`Unknown transport node: ${id}`);
    }
    return node;
}
function edgeBetween(a, b) {
    return data.edges.find((edge) => (edge.from === a && edge.to === b) ||
        (edge.from === b && edge.to === a));
}
function edgeCost(a, b) {
    return Math.max(Math.abs(a.worldX - b.worldX), Math.abs(a.worldY - b.worldY));
}
function normalize(value) {
    return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}
