import initSqlJs from "sql.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
function moduleRoot() {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(moduleDir, "..");
}
function defaultDbPath() {
    return process.env.OSRS_AGENT_DB_PATH ?? path.join(moduleRoot(), "data", "agent-memory.sqlite");
}
function toJson(value) {
    return value === undefined ? null : JSON.stringify(value);
}
function fromJson(value) {
    if (typeof value !== "string" || value.length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
function rowValue(row, key) {
    return row[key] === null ? undefined : row[key];
}
export function strategyCacheKey(args) {
    const goal = normalizeKeyPart(args.goal);
    const method = normalizeKeyPart(args.method ?? "default");
    return `${goal}::${method}`;
}
function normalizeKeyPart(value) {
    return String(value ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 120) || "unknown";
}
function tokenize(value) {
    return String(value ?? "")
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter((token) => token.length >= 3);
}
function textForJournalRow(row) {
    return [
        row.goal,
        row.kind,
        row.data_json,
    ].filter(Boolean).join(" ");
}
export class AgentMemoryStore {
    dbPath;
    db;
    initialized;
    writeQueue = Promise.resolve();
    loadError;
    constructor(dbPath = defaultDbPath()) {
        this.dbPath = dbPath;
    }
    async ensureReady() {
        if (!this.initialized) {
            this.initialized = this.initialize();
        }
        await this.initialized;
    }
    async status() {
        await this.flush();
        const sessions = this.count("select count(*) as count from sessions");
        const events = this.count("select count(*) as count from events");
        const journal = this.count("select count(*) as count from journal");
        const strategyCache = this.count("select count(*) as count from strategy_cache");
        return {
            status: this.loadError ? "DEGRADED" : "READY",
            dbPath: this.dbPath,
            sessionCount: sessions,
            eventCount: events,
            journalCount: journal,
            strategyCacheCount: strategyCache,
            loadError: this.loadError,
        };
    }
    async upsertSession(session) {
        return this.enqueue(async () => {
            const db = await this.readyDb();
            db.run(`insert into sessions (
          id, goal, status, execution_mode, created_at, updated_at, selected_client_json,
          step_count, stop_reason, goal_state_json, last_selected_step_json,
          last_verification_json, last_result_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          goal = excluded.goal,
          status = excluded.status,
          execution_mode = excluded.execution_mode,
          updated_at = excluded.updated_at,
          selected_client_json = excluded.selected_client_json,
          step_count = excluded.step_count,
          stop_reason = excluded.stop_reason,
          goal_state_json = excluded.goal_state_json,
          last_selected_step_json = excluded.last_selected_step_json,
          last_verification_json = excluded.last_verification_json,
          last_result_json = excluded.last_result_json`, [
                session.id,
                session.goal,
                session.status,
                session.executionMode,
                session.createdAt,
                session.updatedAt,
                toJson(session.selectedClient),
                session.stepCount,
                session.stopReason ?? null,
                toJson(session.goalState),
                toJson(session.lastSelectedStep),
                toJson(session.lastVerification),
                toJson(session.lastResult),
            ]);
            await this.save();
        });
    }
    async appendEvent(event) {
        return this.enqueue(async () => {
            const db = await this.readyDb();
            db.run("insert into events (session_id, at, type, data_json) values (?, ?, ?, ?)", [event.sessionId, event.at, event.type, toJson(event.data)]);
            await this.save();
        });
    }
    async listSessions(args = {}) {
        await this.flush();
        const limit = Math.max(1, Math.min(200, args.limit ?? 50));
        const where = [];
        const params = [];
        if (args.status) {
            where.push("status = ?");
            params.push(args.status);
        }
        if (args.goalContains) {
            where.push("lower(goal) like ?");
            params.push(`%${args.goalContains.toLowerCase()}%`);
        }
        params.push(limit);
        const sql = `select * from sessions ${where.length ? `where ${where.join(" and ")}` : ""} order by updated_at desc limit ?`;
        return this.rows(sql, params).map((row) => this.sessionFromRow(row));
    }
    async getSession(sessionId) {
        await this.flush();
        const row = this.rows("select * from sessions where id = ? limit 1", [sessionId])[0];
        return row ? this.sessionFromRow(row) : undefined;
    }
    async getEvents(sessionId, limit = 50) {
        await this.flush();
        const max = Math.max(1, Math.min(500, limit));
        return this.rows("select * from events where session_id = ? order by at desc, id desc limit ?", [sessionId, max]).reverse().map((row) => ({
            id: Number(row.id),
            sessionId: String(row.session_id),
            at: Number(row.at),
            type: String(row.type),
            data: fromJson(row.data_json),
        }));
    }
    async getProfile() {
        await this.flush();
        const row = this.rows("select * from profile where id = 1 limit 1")[0];
        return row ? { updatedAt: Number(row.updated_at), data: fromJson(row.data_json) ?? {} } : undefined;
    }
    async updateProfile(data) {
        const updatedAt = Date.now();
        await this.enqueue(async () => {
            const db = await this.readyDb();
            db.run(`insert into profile (id, updated_at, data_json) values (1, ?, ?)
        on conflict(id) do update set updated_at = excluded.updated_at, data_json = excluded.data_json`, [updatedAt, toJson(data)]);
            await this.save();
        });
        return { updatedAt, data };
    }
    async appendJournal(entry) {
        return this.enqueue(async () => {
            const db = await this.readyDb();
            db.run("insert into journal (at, kind, session_id, goal, data_json) values (?, ?, ?, ?, ?)", [
                entry.at,
                entry.kind,
                entry.sessionId ?? null,
                entry.goal ?? null,
                toJson(entry.data),
            ]);
            await this.save();
        });
    }
    async listJournal(args = {}) {
        await this.flush();
        const limit = Math.max(1, Math.min(500, args.limit ?? 50));
        const where = [];
        const params = [];
        if (args.kind) {
            where.push("kind = ?");
            params.push(args.kind);
        }
        if (args.sessionId) {
            where.push("session_id = ?");
            params.push(args.sessionId);
        }
        if (args.goalContains) {
            where.push("lower(goal) like ?");
            params.push(`%${args.goalContains.toLowerCase()}%`);
        }
        params.push(limit);
        const sql = `select * from journal ${where.length ? `where ${where.join(" and ")}` : ""} order by at desc, id desc limit ?`;
        return this.rows(sql, params).map((row) => ({
            id: Number(row.id),
            at: Number(row.at),
            kind: String(row.kind),
            sessionId: rowValue(row, "session_id"),
            goal: rowValue(row, "goal"),
            data: fromJson(row.data_json),
        }));
    }
    async searchLessons(args) {
        await this.flush();
        const limit = Math.max(1, Math.min(100, args.limit ?? 10));
        const queryTokens = new Set(tokenize(args.query));
        const rows = this.rows(`select * from journal ${args.kind ? "where kind = ?" : ""} order by at desc, id desc limit 500`, args.kind ? [args.kind] : []);
        return rows
            .map((row) => {
            const data = fromJson(row.data_json);
            const text = textForJournalRow(row);
            const rowTokens = new Set(tokenize(text));
            const overlap = [...queryTokens].filter((token) => rowTokens.has(token));
            const failureSignal = hasFailureSignal(data) || /fail|blocked|death|died|risk|lesson|avoid|need/i.test(text);
            const score = overlap.length * 3 + (failureSignal ? 2 : 0);
            return {
                id: Number(row.id),
                at: Number(row.at),
                kind: String(row.kind),
                sessionId: rowValue(row, "session_id"),
                goal: rowValue(row, "goal"),
                score,
                matchedTokens: overlap,
                failureSignal,
                data,
            };
        })
            .filter((entry) => entry.score >= (args.minScore ?? 1))
            .filter((entry) => args.onlyFailures ? entry.failureSignal : true)
            .sort((a, b) => b.score - a.score || b.at - a.at)
            .slice(0, limit);
    }
    async upsertStrategyCache(entry) {
        const now = Date.now();
        const key = entry.key ?? strategyCacheKey({ goal: entry.goal, method: entry.method });
        await this.enqueue(async () => {
            const db = await this.readyDb();
            db.run(`insert into strategy_cache (
          key, goal, method, source, status, created_at, updated_at,
          success_count, failure_count, last_used_at, policy_json,
          context_summary_json, metadata_json
        ) values (?, ?, ?, ?, ?, ?, ?, 0, 0, null, ?, ?, ?)
        on conflict(key) do update set
          goal = excluded.goal,
          method = excluded.method,
          source = excluded.source,
          status = excluded.status,
          updated_at = excluded.updated_at,
          policy_json = excluded.policy_json,
          context_summary_json = excluded.context_summary_json,
          metadata_json = excluded.metadata_json`, [
                key,
                entry.goal,
                entry.method ?? null,
                entry.source ?? null,
                entry.status ?? "READY",
                now,
                now,
                toJson(entry.policy),
                toJson(entry.contextSummary),
                toJson(entry.metadata),
            ]);
            await this.save();
        });
        return this.getStrategyCache(key);
    }
    async getStrategyCache(keyOrGoal, method) {
        await this.flush();
        const key = method === undefined && keyOrGoal.includes("::")
            ? keyOrGoal
            : strategyCacheKey({ goal: keyOrGoal, method });
        const row = this.rows("select * from strategy_cache where key = ? limit 1", [key])[0];
        return row ? this.strategyCacheFromRow(row) : undefined;
    }
    async listStrategyCache(args = {}) {
        await this.flush();
        const limit = Math.max(1, Math.min(200, args.limit ?? 25));
        const where = [];
        const params = [];
        if (args.goalContains) {
            where.push("lower(goal) like ?");
            params.push(`%${args.goalContains.toLowerCase()}%`);
        }
        if (args.method) {
            where.push("lower(coalesce(method, '')) like ?");
            params.push(`%${args.method.toLowerCase()}%`);
        }
        if (args.status) {
            where.push("status = ?");
            params.push(args.status);
        }
        params.push(limit);
        const sql = `select * from strategy_cache ${where.length ? `where ${where.join(" and ")}` : ""} order by updated_at desc limit ?`;
        return this.rows(sql, params).map((row) => this.strategyCacheFromRow(row));
    }
    async recordStrategyCacheOutcome(keyOrGoal, args) {
        const key = args.method === undefined && keyOrGoal.includes("::")
            ? keyOrGoal
            : strategyCacheKey({ goal: keyOrGoal, method: args.method });
        const now = Date.now();
        await this.enqueue(async () => {
            const db = await this.readyDb();
            db.run(`update strategy_cache set
          updated_at = ?,
          last_used_at = ?,
          success_count = success_count + ?,
          failure_count = failure_count + ?,
          metadata_json = case
            when ? is null then metadata_json
            else ?
          end
        where key = ?`, [
                now,
                now,
                args.success ? 1 : 0,
                args.success ? 0 : 1,
                args.metadata === undefined ? null : "metadata",
                toJson(args.metadata),
                key,
            ]);
            await this.save();
        });
        return this.getStrategyCache(key);
    }
    async flush() {
        await this.writeQueue;
        await this.ensureReady();
        await this.writeQueue;
    }
    async initialize() {
        const SQL = await initSqlJs({
            locateFile: (file) => path.join(moduleRoot(), "node_modules", "sql.js", "dist", file),
        });
        let bytes;
        try {
            bytes = await readFile(this.dbPath);
        }
        catch (error) {
            if (error?.code !== "ENOENT") {
                this.loadError = error?.message ?? String(error);
            }
        }
        this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
        this.db.run(`
      create table if not exists sessions (
        id text primary key,
        goal text not null,
        status text not null,
        execution_mode text not null,
        created_at integer not null,
        updated_at integer not null,
        selected_client_json text,
        step_count integer not null default 0,
        stop_reason text,
        goal_state_json text,
        last_selected_step_json text,
        last_verification_json text,
        last_result_json text
      );
      create table if not exists events (
        id integer primary key autoincrement,
        session_id text not null,
        at integer not null,
        type text not null,
        data_json text,
        foreign key(session_id) references sessions(id)
      );
      create table if not exists profile (
        id integer primary key check(id = 1),
        updated_at integer not null,
        data_json text not null
      );
      create table if not exists journal (
        id integer primary key autoincrement,
        at integer not null,
        kind text not null,
        session_id text,
        goal text,
        data_json text
      );
      create table if not exists strategy_cache (
        key text primary key,
        goal text not null,
        method text,
        source text,
        status text,
        created_at integer not null,
        updated_at integer not null,
        success_count integer not null default 0,
        failure_count integer not null default 0,
        last_used_at integer,
        policy_json text,
        context_summary_json text,
        metadata_json text
      );
      create index if not exists idx_sessions_updated_at on sessions(updated_at);
      create index if not exists idx_events_session_at on events(session_id, at);
      create index if not exists idx_journal_kind_at on journal(kind, at);
      create index if not exists idx_journal_session_at on journal(session_id, at);
      create index if not exists idx_strategy_cache_goal on strategy_cache(goal);
      create index if not exists idx_strategy_cache_updated on strategy_cache(updated_at);
    `);
        await this.save();
    }
    async readyDb() {
        await this.ensureReady();
        if (!this.db) {
            throw new Error("Agent memory database did not initialize.");
        }
        return this.db;
    }
    enqueue(work) {
        this.writeQueue = this.writeQueue.then(work, work);
        return this.writeQueue;
    }
    async save() {
        if (!this.db) {
            return;
        }
        await mkdir(path.dirname(this.dbPath), { recursive: true });
        await writeFile(this.dbPath, Buffer.from(this.db.export()));
    }
    rows(sql, params = []) {
        if (!this.db) {
            throw new Error("Agent memory database is not ready.");
        }
        const stmt = this.db.prepare(sql);
        try {
            stmt.bind(params);
            const rows = [];
            while (stmt.step()) {
                rows.push(stmt.getAsObject());
            }
            return rows;
        }
        finally {
            stmt.free();
        }
    }
    count(sql) {
        const row = this.rows(sql)[0];
        return Number(row?.count ?? 0);
    }
    sessionFromRow(row) {
        return {
            id: String(row.id),
            goal: String(row.goal),
            status: String(row.status),
            executionMode: row.execution_mode === "execute" ? "execute" : "dry_run",
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            selectedClient: fromJson(row.selected_client_json),
            stepCount: Number(row.step_count ?? 0),
            stopReason: rowValue(row, "stop_reason"),
            goalState: fromJson(row.goal_state_json),
            lastSelectedStep: fromJson(row.last_selected_step_json),
            lastVerification: fromJson(row.last_verification_json),
            lastResult: fromJson(row.last_result_json),
        };
    }
    strategyCacheFromRow(row) {
        return {
            key: String(row.key),
            goal: String(row.goal),
            method: rowValue(row, "method"),
            source: rowValue(row, "source"),
            status: rowValue(row, "status"),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            successCount: Number(row.success_count ?? 0),
            failureCount: Number(row.failure_count ?? 0),
            lastUsedAt: rowValue(row, "last_used_at") === undefined ? undefined : Number(row.last_used_at),
            policy: fromJson(row.policy_json),
            contextSummary: fromJson(row.context_summary_json),
            metadata: fromJson(row.metadata_json),
        };
    }
}
function hasFailureSignal(data) {
    if (!data || typeof data !== "object") {
        return false;
    }
    const status = String(data.status ?? data.result?.status ?? data.result?.stopReason ?? "").toLowerCase();
    const lesson = String(data.lesson ?? data.note ?? "").toLowerCase();
    return Boolean(data.success === false ||
        data.result?.success === false ||
        status.includes("fail") ||
        status.includes("blocked") ||
        lesson.includes("avoid") ||
        lesson.includes("need") ||
        lesson.includes("failed"));
}
