import axios from "axios";
import { apiBaseFromPort } from "./client.js";

export const EXPECTED_PLUGIN_API_VERSION = 8;

export const EXPECTED_PLUGIN_ENDPOINTS = [
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
  "/api/canvas/screenshot",
  "/api/identity",
];

export const EXPECTED_IDENTITY_FLAGS = [
  "supportsConcurrentStreams",
  "supportsEventBuffer",
  "supportsInClientActions",
  "supportsDirectMenuActions",
  "supportsLocalPathfinding",
  "supportsWidgetInspector",
  "supportsCanvasScreenshot",
];

function errorText(action: string, e: any): string {
  const status = e?.response?.status ? ` HTTP ${e.response.status}` : "";
  const responseData = e?.response?.data ? ` ${JSON.stringify(e.response.data)}` : "";
  return `Error ${action}:${status} ${e?.message ?? String(e)}${responseData}`;
}

export async function diagnoseClientRuntime(client: any, apiTimeoutMs: number) {
  const baseURL = client.baseUrl ?? apiBaseFromPort(client.port);
  const report: any = {
    baseURL,
    port: client.port,
    instanceId: client.instanceId,
    playerName: client.playerName,
    apiVersion: client.apiVersion,
    expectedApiVersion: EXPECTED_PLUGIN_API_VERSION,
    loggedInPlayer: client.playerName ?? null,
    status: "ok",
    warnings: [] as string[],
    missingIdentityFlags: [] as string[],
    missingEndpoints: [] as string[],
    staleRuntime: false,
  };

  if ((client.apiVersion ?? 0) < EXPECTED_PLUGIN_API_VERSION) {
    report.staleRuntime = true;
    report.status = "needs_reload";
    report.warnings.push(`Plugin API version ${client.apiVersion ?? "unknown"} is older than expected ${EXPECTED_PLUGIN_API_VERSION}. Rebuild/install is done, but RuneLite must reload the plugin to expose the newest endpoints.`);
  }

  for (const flag of EXPECTED_IDENTITY_FLAGS) {
    if (client[flag] !== true) {
      report.missingIdentityFlags.push(flag);
    }
  }

  try {
    const apiIndex = (await axios.get(baseURL, { timeout: apiTimeoutMs })).data;
    const endpointPaths = new Set((apiIndex?.endpoints ?? []).map((endpoint: any) => String(endpoint.path ?? "").split("?")[0]));
    report.endpointCount = endpointPaths.size;
    report.missingEndpoints = EXPECTED_PLUGIN_ENDPOINTS.filter((endpoint) => !endpointPaths.has(endpoint));
  } catch (error: any) {
    report.warnings.push(errorText("fetching API endpoint index", error));
  }

  if (report.missingIdentityFlags.length > 0 || report.missingEndpoints.length > 0) {
    report.staleRuntime = true;
    report.status = "needs_reload";
    if (report.missingEndpoints.length > 0) {
      report.warnings.push(`Missing endpoints: ${report.missingEndpoints.join(", ")}`);
    }
    if (report.missingIdentityFlags.length > 0) {
      report.warnings.push(`Missing identity flags: ${report.missingIdentityFlags.join(", ")}`);
    }
  }

  return report;
}
