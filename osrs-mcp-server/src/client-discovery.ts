import axios from "axios";
import { apiBaseFromPort, type ClientTarget } from "./client.js";

export type DiscoveredClient = {
  baseUrl: string;
  port?: number;
  instanceId?: string;
  playerName?: string;
  [key: string]: any;
};

export async function discoverClients(apiTimeoutMs: number): Promise<DiscoveredClient[]> {
  const ports = Array.from({ length: 11 }, (_, index) => 8080 + index);
  const results = await Promise.all(ports.map(async (port) => {
    try {
      const baseURL = apiBaseFromPort(port);
      const res = await axios.get(`${baseURL}/identity`, { timeout: Math.min(apiTimeoutMs, 2000) });
      return { ...res.data, baseUrl: baseURL };
    } catch {
      return null;
    }
  }));
  return results.filter(Boolean) as DiscoveredClient[];
}

export function selectDiscoveredClient(
  clients: DiscoveredClient[],
  target: ClientTarget = {},
  selectedBaseUrl?: string,
  selectedInstanceId?: string,
) {
  const matches = clients.filter((client: any) =>
    (target.port !== undefined && client.port === target.port) ||
    (target.instanceId && client.instanceId === target.instanceId) ||
    (target.playerName && String(client.playerName ?? "").toLowerCase() === target.playerName.toLowerCase())
  );

  if (target.port !== undefined || target.instanceId || target.playerName) {
    return matches[0];
  }

  return clients.find((candidate: any) =>
    candidate.baseUrl === selectedBaseUrl ||
    candidate.instanceId === selectedInstanceId
  ) ?? (clients.length === 1 ? clients[0] : undefined);
}
