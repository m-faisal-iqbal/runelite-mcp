import axios from "axios";
export function apiBaseFromPort(port) {
    return `http://localhost:${port}/api`;
}
export class StateCache {
    ttlMs;
    apiTimeoutMs;
    snapshotFetcher;
    entries = new Map();
    constructor(ttlMs, apiTimeoutMs, snapshotFetcher) {
        this.ttlMs = ttlMs;
        this.apiTimeoutMs = apiTimeoutMs;
        this.snapshotFetcher = snapshotFetcher;
    }
    status(baseURL) {
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
    async ensureStreamSupported(baseURL) {
        const entry = this.entryFor(baseURL);
        if (entry.streamSupportChecked) {
            return Boolean(entry.streamSupported);
        }
        try {
            const identity = (await axios.get(`${baseURL}/identity`, { timeout: Math.min(this.apiTimeoutMs, 900) })).data;
            entry.streamSupported = identity?.supportsConcurrentStreams === true;
        }
        catch (error) {
            entry.streamSupported = false;
            entry.streamError = error?.message ?? String(error);
        }
        entry.streamSupportChecked = true;
        return Boolean(entry.streamSupported);
    }
    startStream(baseURL) {
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
                }
                catch (error) {
                    entry.streamError = error?.message ?? String(error);
                }
                finally {
                    entry.streamActive = false;
                }
                await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
                retryDelayMs = Math.min(retryDelayMs * 2, 5000);
            }
        })();
    }
    async get(baseURL, force = false) {
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
            }
            else {
                this.entries.delete(baseURL);
            }
            throw error;
        });
        this.entryFor(baseURL).inflight = inflight;
        return inflight;
    }
    entryFor(baseURL) {
        const existing = this.entries.get(baseURL);
        if (existing) {
            return existing;
        }
        const entry = { fetchedAt: 0, snapshot: {} };
        this.entries.set(baseURL, entry);
        return entry;
    }
    update(baseURL, snapshot) {
        const entry = this.entryFor(baseURL);
        entry.fetchedAt = Date.now();
        entry.snapshot = snapshot;
        entry.inflight = undefined;
    }
    handleSseBlock(baseURL, block) {
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
            this.update(baseURL, parsed);
        }
        else if (eventName === "events") {
            entry.recentEvents = parsed;
        }
        entry.streamLastEventAt = Date.now();
    }
}
