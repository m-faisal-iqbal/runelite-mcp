import axios from "axios";

export type RuneLiteTarget = {
  id?: number;
  name?: string;
  option?: string;
  target?: string;
  identifier?: number;
  param0?: number;
  param1?: number;
  type?: string;
  itemId?: number;
  worldX?: number;
  worldY?: number;
  coordinateSource?: string;
  screenX?: number;
  screenY?: number;
  slotScreenX?: number;
  slotScreenY?: number;
  slot?: number;
  ageMs?: number;
  distanceToPlayer?: number;
  coordinateWarning?: string;
};

export type ClientTarget = {
  instanceId?: string;
  playerName?: string;
  port?: number;
};

export type RuneLiteSnapshot = {
  state?: any;
  npcs?: RuneLiteTarget[];
  dialogue?: any;
  objects?: RuneLiteTarget[];
  groundItems?: RuneLiteTarget[];
  players?: RuneLiteTarget[];
  inventory?: RuneLiteTarget[];
  bank?: RuneLiteTarget[];
  equipment?: RuneLiteTarget[];
  skills?: any;
  prayers?: any;
  combat?: any;
  chat?: any;
  interfaceSummary?: any;
  ageMs?: number;
};

export type PathStep = {
  worldX: number;
  worldY: number;
  plane?: number;
  sceneX?: number;
  sceneY?: number;
  final?: boolean;
};

export type LocalPathResult = {
  success?: boolean;
  error?: string;
  collisionAware?: boolean;
  scope?: string;
  start?: PathStep;
  target?: PathStep;
  distance?: number;
  stepsCount?: number;
  steps?: PathStep[];
  waypoints?: PathStep[];
  [key: string]: any;
};

type SnapshotCacheEntry = {
  fetchedAt: number;
  snapshot: RuneLiteSnapshot;
  inflight?: Promise<RuneLiteSnapshot>;
  streamSupportChecked?: boolean;
  streamSupported?: boolean;
  streamStarted?: boolean;
  streamActive?: boolean;
  streamLastEventAt?: number;
  streamError?: string;
  recentEvents?: any;
};

export function apiBaseFromPort(port: number): string {
  return `http://localhost:${port}/api`;
}

export class StateCache {
  private readonly entries = new Map<string, SnapshotCacheEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly apiTimeoutMs: number,
    private readonly snapshotFetcher: (baseURL: string) => Promise<RuneLiteSnapshot>,
  ) {}

  status(baseURL: string) {
    const entry = this.entries.get(baseURL);
    return {
      baseURL,
      cached: Boolean(entry && entry.fetchedAt > 0),
      fetchedAt: entry?.fetchedAt ?? 0,
      cacheAgeMs: entry?.fetchedAt ? Date.now() - entry.fetchedAt : null,
      streamStarted: Boolean(entry?.streamStarted),
      streamSupported: Boolean(entry?.streamSupported),
      streamSupportChecked: Boolean(entry?.streamSupportChecked),
      streamActive: Boolean(entry?.streamActive),
      streamLastEventAt: entry?.streamLastEventAt ?? 0,
      streamAgeMs: entry?.streamLastEventAt ? Date.now() - entry.streamLastEventAt : null,
      streamError: entry?.streamError,
    };
  }

  async ensureStreamSupported(baseURL: string): Promise<boolean> {
    const entry = this.entryFor(baseURL);
    if (entry.streamSupportChecked) {
      return Boolean(entry.streamSupported);
    }

    try {
      const identity = (await axios.get(`${baseURL}/identity`, { timeout: Math.min(this.apiTimeoutMs, 900) })).data;
      entry.streamSupported = identity?.supportsConcurrentStreams === true;
    } catch (error: any) {
      entry.streamSupported = false;
      entry.streamError = error?.message ?? String(error);
    }
    entry.streamSupportChecked = true;
    return Boolean(entry.streamSupported);
  }

  startStream(baseURL: string) {
    const entry = this.entryFor(baseURL);
    if (entry.streamStarted) {
      return;
    }

    entry.streamStarted = true;
    void (async () => {
      let retryDelayMs = 750;
      while (entry.streamStarted) {
        try {
          const response = await fetch(`${baseURL}/stream`);
          if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status}`);
          }

          entry.streamActive = true;
          entry.streamError = undefined;
          retryDelayMs = 750;

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (entry.streamStarted) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            let separatorIndex = buffer.search(/\r?\n\r?\n/);
            while (separatorIndex >= 0) {
              const block = buffer.slice(0, separatorIndex);
              buffer = buffer.slice(separatorIndex + (buffer[separatorIndex] === "\r" ? 4 : 2));
              this.handleSseBlock(baseURL, block);
              separatorIndex = buffer.search(/\r?\n\r?\n/);
            }
          }
        } catch (error: any) {
          entry.streamError = error?.message ?? String(error);
        } finally {
          entry.streamActive = false;
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        retryDelayMs = Math.min(retryDelayMs * 2, 5000);
      }
    })();
  }

  async get(baseURL: string, force = false): Promise<RuneLiteSnapshot> {
    if (!force && await this.ensureStreamSupported(baseURL)) {
      this.startStream(baseURL);
    }

    const now = Date.now();
    const cached = this.entries.get(baseURL);
    if (!force && cached && now - cached.fetchedAt <= this.ttlMs) {
      return cached.snapshot;
    }
    if (!force && cached?.inflight) {
      return cached.inflight;
    }

    const inflight = this.snapshotFetcher(baseURL).then((snapshot) => {
      this.update(baseURL, snapshot);
      return snapshot;
    }).catch((error) => {
      if (cached) {
        cached.inflight = undefined;
      } else {
        this.entries.delete(baseURL);
      }
      throw error;
    });

    this.entryFor(baseURL).inflight = inflight;
    return inflight;
  }

  private entryFor(baseURL: string): SnapshotCacheEntry {
    const existing = this.entries.get(baseURL);
    if (existing) {
      return existing;
    }

    const entry: SnapshotCacheEntry = { fetchedAt: 0, snapshot: {} };
    this.entries.set(baseURL, entry);
    return entry;
  }

  private update(baseURL: string, snapshot: RuneLiteSnapshot) {
    const entry = this.entryFor(baseURL);
    entry.fetchedAt = Date.now();
    entry.snapshot = snapshot;
    entry.inflight = undefined;
  }

  private handleSseBlock(baseURL: string, block: string) {
    const eventName = block
      .split(/\r?\n/)
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());

    if (dataLines.length === 0) {
      return;
    }

    const parsed = JSON.parse(dataLines.join("\n"));
    const entry = this.entryFor(baseURL);
    if (!eventName || eventName === "snapshot") {
      this.update(baseURL, parsed as RuneLiteSnapshot);
    } else if (eventName === "events") {
      entry.recentEvents = parsed;
    }
    entry.streamLastEventAt = Date.now();
  }
}
