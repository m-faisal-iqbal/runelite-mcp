import axios from "axios";
import { apiBaseFromPort } from "./client.js";
export async function discoverClients(apiTimeoutMs) {
    const ports = Array.from({ length: 11 }, (_, index) => 8080 + index);
    const results = await Promise.all(ports.map(async (port) => {
        try {
            const baseURL = apiBaseFromPort(port);
            const res = await axios.get(`${baseURL}/identity`, { timeout: Math.min(apiTimeoutMs, 2000) });
            return { ...res.data, baseUrl: baseURL };
        }
        catch {
            return null;
        }
    }));
    return results.filter(Boolean);
}
export function selectDiscoveredClient(clients, target = {}, selectedBaseUrl, selectedInstanceId) {
    const matches = clients.filter((client) => (target.port !== undefined && client.port === target.port) ||
        (target.instanceId && client.instanceId === target.instanceId) ||
        (target.playerName && String(client.playerName ?? "").toLowerCase() === target.playerName.toLowerCase()));
    if (target.port !== undefined || target.instanceId || target.playerName) {
        return matches[0];
    }
    return clients.find((candidate) => candidate.baseUrl === selectedBaseUrl ||
        candidate.instanceId === selectedInstanceId) ?? (clients.length === 1 ? clients[0] : undefined);
}
