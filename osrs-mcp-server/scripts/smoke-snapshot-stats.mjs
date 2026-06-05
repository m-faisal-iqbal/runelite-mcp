#!/usr/bin/env node
import axios from "axios";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) {
    return fallback;
  }
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

const port = Number(arg("port", process.env.OSRS_VERIFY_PORT ?? 8080));
const seconds = Number(arg("seconds", 30));
const intervalMs = Number(arg("interval-ms", 250));
const minHits = Number(arg("min-hits", 50));
const maxMisses = Number(arg("max-misses", 5));
const baseUrl = `http://127.0.0.1:${port}/api`;
const api = axios.create({ baseURL: baseUrl, timeout: 3000 });

const before = (await api.get("/debug/snapshot-stats")).data;
let ok = 0;
let failed = 0;
const deadline = Date.now() + seconds * 1000;
while (Date.now() < deadline) {
  try {
    await api.get("/snapshot");
    ok += 1;
  } catch {
    failed += 1;
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
const after = (await api.get("/debug/snapshot-stats")).data;
const deltaHits = Number(after.cache_hits ?? 0) - Number(before.cache_hits ?? 0);
const deltaMisses = Number(after.cache_misses ?? 0) - Number(before.cache_misses ?? 0);
const deltaTimeouts = Number(after.client_thread_timeouts ?? 0) - Number(before.client_thread_timeouts ?? 0);
const result = {
  ok: deltaHits > minHits && deltaMisses < maxMisses && deltaTimeouts === 0,
  baseUrl,
  polling: { ok, failed, seconds, intervalMs },
  thresholds: { minHits, maxMisses, requiredNewTimeouts: 0 },
  before,
  after,
  deltas: {
    cache_hits: deltaHits,
    cache_misses: deltaMisses,
    client_thread_timeouts: deltaTimeouts,
  },
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  process.exitCode = 1;
}
