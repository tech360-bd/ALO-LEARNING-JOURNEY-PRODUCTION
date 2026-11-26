// ALO Learning Journey — durable run-timeline store (server-only).
//
// Phase C2 contract: every Super Admin turn is a persistent "run" with a
// durable, monotonically sequenced event timeline. The store interface is
// small on purpose so the engine (runs.ts) can be exercised against an
// in-memory implementation in unit tests while production uses PrismaRunStore.
//
// PrismaRunStore degrades gracefully: when the database is unreachable
// (pre-migration / local fallback) it falls back to an in-memory store so
// the command center still works, and reports `persistent: false` so the UI
// can say "timeline is not durable on this server" instead of lying.

import { db } from "@/lib/db";

/** Normalize an event payload to a JSON string (null stays null). */
function normalizePayload(payload: unknown): string | null {
  if (payload == null) return null;
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

export type RunStatus =
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type RunEventType = "status" | "step" | "token" | "approval" | "error" | "done";

export interface RunRow {
  id: string;
  ownerId: string;
  conversationId: string;
  command: string;
  intent: string;
  status: RunStatus;
  provider: string | null;
  model: string | null;
  plan: string | null; // JSON
  result: string | null; // JSON
  partialContent: string | null;
  pendingActionId: string | null;
  error: string | null;
  seq: number;
  startedAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunEventRow {
  id: string;
  runId: string;
  seq: number;
  type: RunEventType;
  payload: string | null; // JSON
  createdAt: Date;
}

export interface RunStore {
  /** True when rows survive a process restart. */
  readonly persistent: boolean;
  createRun(input: { ownerId: string; conversationId: string; command: string }): Promise<RunRow>;
  getRun(runId: string): Promise<RunRow | null>;
  listRuns(ownerId: string, limit?: number): Promise<RunRow[]>;
  /** Persisted timeline for a run, ascending seq. afterSeq filters to seq > afterSeq. */
  listEvents(runId: string, afterSeq?: number): Promise<RunEventRow[]>;
  /**
   * Atomically append one event at seq = run.seq + 1 and apply the run
   * patch. Payload is normalized to a JSON string. Returns the persisted
   * event. Throws when the run is unknown.
   */
  appendEvent(
    runId: string,
    type: RunEventType,
    payload: unknown,
    runPatch?: Partial<Pick<RunRow, "status" | "intent" | "provider" | "model" | "plan" | "result" | "partialContent" | "pendingActionId" | "error" | "finishedAt" | "startedAt" | "updatedAt">>
  ): Promise<RunEventRow>;
  /** Find runs awaiting approval for a given pending action. */
  findRunsByAction(actionId: string): Promise<RunRow[]>;
  /** Stale "running" runs (server died mid-run). */
  findStaleRuns(olderThanMs: number): Promise<RunRow[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory implementation (unit tests + degraded fallback)
// ─────────────────────────────────────────────────────────────────────────────
export class MemoryRunStore implements RunStore {
  readonly persistent = false;
  private runs = new Map<string, RunRow>();
  private events = new Map<string, RunEventRow[]>();

  private cloneRun(r: RunRow): RunRow {
    return { ...r };
  }

  async createRun(input: { ownerId: string; conversationId: string; command: string }): Promise<RunRow> {
    const now = new Date();
    const row: RunRow = {
      id: `mem-run-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      command: input.command,
      intent: "chat",
      status: "running",
      provider: null,
      model: null,
      plan: null,
      result: null,
      partialContent: null,
      pendingActionId: null,
      error: null,
      seq: 0,
      startedAt: now,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(row.id, row);
    this.events.set(row.id, []);
    return this.cloneRun(row);
  }

  async getRun(runId: string): Promise<RunRow | null> {
    const r = this.runs.get(runId);
    return r ? this.cloneRun(r) : null;
  }

  async listRuns(ownerId: string, limit = 20): Promise<RunRow[]> {
    return [...this.runs.values()]
      .filter((r) => r.ownerId === ownerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((r) => this.cloneRun(r));
  }

  async listEvents(runId: string, afterSeq = 0): Promise<RunEventRow[]> {
    return (this.events.get(runId) ?? [])
      .filter((e) => e.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .map((e) => ({ ...e }));
  }

  async appendEvent(
    runId: string,
    type: RunEventType,
    payload: unknown,
    runPatch?: Partial<Pick<RunRow, "status" | "intent" | "provider" | "model" | "plan" | "result" | "partialContent" | "pendingActionId" | "error" | "finishedAt" | "startedAt" | "updatedAt">>
  ): Promise<RunEventRow> {
    const r = this.runs.get(runId);
    if (!r) throw new Error(`run not found: ${runId}`);
    const ev: RunEventRow = {
      id: `mem-ev-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
      runId,
      seq: r.seq + 1,
      type,
      payload: normalizePayload(payload),
      createdAt: new Date(),
    };
    const list = this.events.get(runId) ?? [];
    list.push(ev);
    this.events.set(runId, list);
    r.seq = ev.seq;
    r.updatedAt = new Date();
    if (runPatch) Object.assign(r, runPatch);
    return { ...ev };
  }

  async findRunsByAction(actionId: string): Promise<RunRow[]> {
    return [...this.runs.values()]
      .filter((r) => r.pendingActionId === actionId)
      .map((r) => this.cloneRun(r));
  }

  async findStaleRuns(olderThanMs: number): Promise<RunRow[]> {
    const cutoff = Date.now() - olderThanMs;
    return [...this.runs.values()]
      .filter((r) => r.status === "running" && r.updatedAt.getTime() < cutoff)
      .map((r) => this.cloneRun(r));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prisma implementation (production)
// ─────────────────────────────────────────────────────────────────────────────
function rowToRun(row: any): RunRow {
  return {
    id: row.id,
    ownerId: row.ownerId,
    conversationId: row.conversationId,
    command: row.command,
    intent: row.intent,
    status: row.status,
    provider: row.provider ?? null,
    model: row.model ?? null,
    plan: row.plan ?? null,
    result: row.result ?? null,
    partialContent: row.partialContent ?? null,
    pendingActionId: row.pendingActionId ?? null,
    error: row.error ?? null,
    seq: row.seq,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToEvent(row: any): RunEventRow {
  return { id: row.id, runId: row.runId, seq: row.seq, type: row.type, payload: row.payload ?? null, createdAt: row.createdAt };
}

class PrismaRunStore implements RunStore {
  readonly persistent = true;

  async createRun(input: { ownerId: string; conversationId: string; command: string }): Promise<RunRow> {
    const row = await db.superAdminRun.create({
      data: { ownerId: input.ownerId, conversationId: input.conversationId, command: input.command },
    });
    return rowToRun(row);
  }

  async getRun(runId: string): Promise<RunRow | null> {
    const row = await db.superAdminRun.findUnique({ where: { id: runId } });
    return row ? rowToRun(row) : null;
  }

  async listRuns(ownerId: string, limit = 20): Promise<RunRow[]> {
    const rows = await db.superAdminRun.findMany({
      where: { ownerId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(rowToRun);
  }

  async listEvents(runId: string, afterSeq = 0): Promise<RunEventRow[]> {
    const rows = await db.superAdminRunEvent.findMany({
      where: { runId, ...(afterSeq > 0 ? { seq: { gt: afterSeq } } : {}) },
      orderBy: { seq: "asc" },
      take: 2000,
    });
    return rows.map(rowToEvent);
  }

  async appendEvent(
    runId: string,
    type: RunEventType,
    payload: unknown,
    runPatch?: Partial<Pick<RunRow, "status" | "intent" | "provider" | "model" | "plan" | "result" | "partialContent" | "pendingActionId" | "error" | "finishedAt" | "startedAt" | "updatedAt">>
  ): Promise<RunEventRow> {
    return db.$transaction(async (tx) => {
      const run = await tx.superAdminRun.findUnique({ where: { id: runId } });
      if (!run) throw new Error(`run not found: ${runId}`);
      const ev = await tx.superAdminRunEvent.create({
        data: { runId, seq: run.seq + 1, type, payload: normalizePayload(payload) },
      });
      if (runPatch) {
        const data: Record<string, unknown> = { seq: ev.seq };
        for (const [k, v] of Object.entries(runPatch)) if (v !== undefined) data[k] = v;
        await tx.superAdminRun.update({ where: { id: runId }, data });
      } else {
        await tx.superAdminRun.update({ where: { id: runId }, data: { seq: ev.seq } });
      }
      return rowToEvent(ev);
    });
  }

  async findRunsByAction(actionId: string): Promise<RunRow[]> {
    const rows = await db.superAdminRun.findMany({ where: { pendingActionId: actionId } });
    return rows.map(rowToRun);
  }

  async findStaleRuns(olderThanMs: number): Promise<RunRow[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await db.superAdminRun.findMany({
      where: { status: "running", updatedAt: { lt: cutoff } },
      take: 50,
    });
    return rows.map(rowToRun);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory: Prisma when the database answers, memory when it does not.
// Probes lazily on first use and remembers the outcome per process.
// ─────────────────────────────────────────────────────────────────────────────
let _store: RunStore | null = null;
let _probing: Promise<RunStore> | null = null;

export function getRunStore(): Promise<RunStore> {
  if (_store) return Promise.resolve(_store);
  if (!_probing) {
    _probing = (async () => {
      try {
        await db.$queryRaw`SELECT 1`;
        _store = new PrismaRunStore();
        return _store;
      } catch {
        _store = new MemoryRunStore();
        return _store;
      }
    })();
  }
  return _probing;
}

/** Test hook: reset the cached store (unit tests). */
export function _resetRunStore(): void {
  _store = null;
  _probing = null;
}
