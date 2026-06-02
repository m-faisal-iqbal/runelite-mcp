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
        return {
            status: this.loadError ? "DEGRADED" : "READY",
            dbPath: this.dbPath,
            sessionCount: sessions,
            eventCount: events,
            journalCount: journal,
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
      create index if not exists idx_sessions_updated_at on sessions(updated_at);
      create index if not exists idx_events_session_at on events(session_id, at);
      create index if not exists idx_journal_kind_at on journal(kind, at);
      create index if not exists idx_journal_session_at on journal(session_id, at);
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
}
