# Task: Rewrite transport-graph.ts to support DirectedGraph + player-state edge filtering

## Background
The world_graph.json was upgraded from 40 nodes/49 edges to 179 nodes/494 edges.
It now has directed transport modes: teleport_spell, teleport_item, fairy_ring, spirit_tree,
gnome_glider, boat, canoe, minecart, agility_shortcut (all one-way directed).
Walk and stairs are bidirectional (both directions already exist as separate edge pairs in JSON).

## Critical Bug to Fix
The current code uses `UndirectedGraph` from graphology. This is WRONG.
Teleport edges are one-way (lumbridge_spawn → varrock_teleport_dest, not the reverse).
Using UndirectedGraph means it treats them as bidirectional, which is incorrect.
Switch to `DirectedGraph`.

## New edge fields to handle
Each edge now has:
- mode: "walk" | "teleport_spell" | "teleport_item" | "fairy_ring" | "spirit_tree" | "gnome_glider" | "boat" | "canoe" | "minecart" | "agility_shortcut" | "stairs"
- cost: number (walk steps or transport "ticks")
- risk: "none" | "low" | "medium" | "high"
- f2p?: boolean
- members?: boolean
- requirements?: string[]  (e.g. ["Magic level 25", "Runes: 3 Air 1 Fire 1 Law"])
- action?: string

## New feature: PlayerState-aware edge filtering
Add a `PlayerState` type and filter edges at route time based on player capabilities.

```typescript
export type PlayerState = {
  magicLevel?: number;        // for teleport_spell edges
  agilityLevel?: number;      // for agility_shortcut edges
  woodcuttingLevel?: number;  // for canoe edges
  miningLevel?: number;       // for mining guild door
  members?: boolean;          // filter out members-only edges if false
  f2pOnly?: boolean;          // alias: only allow f2p edges
  availableItems?: string[];  // e.g. ["Amulet of Glory (charged)", "Ring of Dueling (charged)"]
  completedQuests?: string[]; // e.g. ["Tree Gnome Village", "The Grand Tree"]
  maxRisk?: "none" | "low" | "medium" | "high"; // filter out edges above this risk
  wildernessAllowed?: boolean; // default false — blocks risk:"high" edges
};
```

Add `filterEdgeForPlayer(edge: TransportEdge, state: PlayerState): boolean` which returns true if the player CAN use this edge. Rules:
- If state.members === false or state.f2pOnly: block edges where members === true
- If state.wildernessAllowed === false (default): block edges where risk === "high"
- For teleport_spell: check state.magicLevel >= required level (parse from requirements like "Magic level 25")
- For agility_shortcut: check state.agilityLevel >= required (parse from "Agility level N")
- For canoe: check state.woodcuttingLevel >= required (parse from "Woodcutting level N")  
- For stairs with Mining requirement: check state.miningLevel >= required
- For teleport_item: check state.availableItems includes the required item (from requirements[0])
- For fairy_ring: check state.completedQuests includes "Fairytale II - Cure a Queen" (partial)
- For spirit_tree: check state.completedQuests includes "Tree Gnome Village"
- For gnome_glider: check state.completedQuests includes "The Grand Tree"
- maxRisk: map "none"=0, "low"=1, "medium"=2, "high"=3; block if edge risk level > maxRisk level
- Unknown/unparseable requirements: allow edge (fail open, not closed)

## planTransportRoute changes
Add optional `playerState?: PlayerState` parameter.
When provided, filter graph edges using filterEdgeForPlayer before Dijkstra.
Update return type to include `playerStateApplied: boolean`.

## buildGraph changes
Accept optional playerState. When filtering, only add edges that pass filterEdgeForPlayer.
Use `DirectedGraph` instead of `UndirectedGraph`.
Dijkstra must use `graph.forEachOutboundNeighbor` instead of `graph.forEachNeighbor` since graph is now directed.

## edgeBetween changes
Since graph is directed, edgeBetween(a, b) should only match edge where from===a AND to===b.
Remove the reversed fallback (from===b && to===a).

## Keep all existing exports:
- transportGraphSummary()
- findTransportNode(query)
- nearestTransportNode(location)
- planTransportRoute(args) — add optional playerState
- nextRouteWaypoint(route, currentLocation, reachedRadius)
- TransportNode, TransportEdge, TransportRouteStep types

## Add new exports:
- PlayerState type
- filterEdgeForPlayer(edge, state): boolean
- getEdgesFromNode(nodeId): TransportEdge[]  (all outbound edges from a node)
- getTransportModes(): string[]  (unique modes in the graph)

## File to rewrite
H:\runelite-mcp\osrs-mcp-server\src\transport-graph.ts

Write the complete file. Use graphology's DirectedGraph. Keep the custom Dijkstra implementation
(don't use graphology-shortest-path — it may not handle directed graphs with our custom weights correctly).
For DirectedGraph: use graph.addDirectedEdgeWithKey(), graph.forEachOutboundNeighbor().
Import DirectedGraph from graphology.

The file should compile cleanly with the existing tsconfig.json (ES2022, NodeNext modules).
Use .js extensions on local imports.
