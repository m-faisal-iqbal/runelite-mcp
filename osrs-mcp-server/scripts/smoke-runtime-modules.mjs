#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { selectDiscoveredClient } from "../build/client-discovery.js";
import { diagnoseClientRuntime, EXPECTED_PLUGIN_API_VERSION } from "../build/runtime-diagnostics.js";

const clients = [
  { baseUrl: "http://localhost:8080/api", port: 8080, instanceId: "a", playerName: "Main" },
  { baseUrl: "http://localhost:8081/api", port: 8081, instanceId: "b", playerName: "Alt" },
];

assert.equal(selectDiscoveredClient(clients, { port: 8081 })?.instanceId, "b");
assert.equal(selectDiscoveredClient(clients, { playerName: "main" })?.instanceId, "a");
assert.equal(selectDiscoveredClient(clients, {}, "http://localhost:8081/api")?.instanceId, "b");
assert.equal(selectDiscoveredClient(clients, {}, undefined, "a")?.port, 8080);
assert.equal(selectDiscoveredClient(clients, {})?.instanceId, undefined);

const endpoints = [
  "/api/action/menu",
  "/api/action/walk",
  "/api/action/widget",
  "/api/state",
  "/api/snapshot",
  "/api/stream",
  "/api/events",
  "/api/path",
  "/api/path/status",
  "/api/widgets",
  "/api/identity",
];

const server = http.createServer((req, res) => {
  if (req.url === "/api") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ endpoints: endpoints.map((path) => ({ path })) }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}/api`;

try {
  const report = await diagnoseClientRuntime({
    baseUrl,
    port: address.port,
    instanceId: "runtime-test",
    playerName: "agent-test",
    apiVersion: EXPECTED_PLUGIN_API_VERSION,
    supportsConcurrentStreams: true,
    supportsEventBuffer: true,
    supportsInClientActions: true,
    supportsDirectMenuActions: true,
    supportsLocalPathfinding: true,
    supportsWidgetInspector: true,
  }, 1000);

  assert.equal(report.status, "ok");
  assert.equal(report.staleRuntime, false);
  assert.deepEqual(report.missingEndpoints, []);
  assert.deepEqual(report.missingIdentityFlags, []);

  const stale = await diagnoseClientRuntime({
    baseUrl,
    port: address.port,
    instanceId: "runtime-test",
    apiVersion: EXPECTED_PLUGIN_API_VERSION - 1,
  }, 1000);

  assert.equal(stale.status, "needs_reload");
  assert.equal(stale.staleRuntime, true);
  assert(stale.missingIdentityFlags.includes("supportsInClientActions"));
  assert(stale.missingIdentityFlags.includes("supportsDirectMenuActions"));

  console.log(JSON.stringify({
    ok: true,
    selectedByPort: "b",
    diagnosticStatus: report.status,
    staleStatus: stale.status,
    endpointCount: report.endpointCount,
  }, null, 2));
} finally {
  server.close();
}
