import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { getRunStore, type RunEventRow } from "@/lib/super-admin/run-store";
import { subscribeRun, recoverStaleRuns } from "@/lib/super-admin/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

function sseFrame(seq: number, type: string, payload: unknown): string {
  return `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
}

/**
 * GET /api/super-admin/runs/:id/events — Server-Sent Events timeline.
 *
 * Reconnection protocol (gap-free, duplicate-free):
 *  1. The client sends Last-Event-ID (auto on reconnect) or ?afterSeq=N.
 *  2. The server SUBSCRIBES to the live bus first (so nothing emitted after
 *     we start is ever missed), buffering live events by seq.
 *  3. It replays persisted events with seq > afterSeq, merging in any live
 *     events that landed during the read, and delivers strictly ascending
 *     by seq (duplicates dropped).
 *  4. The stream closes when the run reaches a terminal state
 *     (completed/failed/cancelled/interrupted). "awaiting_approval" keeps
 *     the stream open so the owner's decision streams in live.
 *
 * A 15s heartbeat comment keeps proxies from idling the connection.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireOwner();
  } catch (err: any) {
    const status = err?.statusCode ?? 401;
    return NextResponse.json({ error: status === 503 ? "auth_not_configured" : "unauthorized" }, { status });
  }
  const { id } = await params;

  const store = await getRunStore();
  const run = await store.getRun(id);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const headerLast = Number(req.headers.get("last-event-id") ?? "0") || 0;
  const queryAfter = Number(req.nextUrl.searchParams.get("afterSeq") ?? "0");
  const lastSeq = Math.max(headerLast, Number.isFinite(queryAfter) ? queryAfter : 0);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      // A reconnecting client (Last-Event-ID / afterSeq) has already seen
      // everything up to `floor`; seqs below it can never be new (seq only
      // increases).
      const floor = lastSeq;
      // Buffer of undelivered events (live or persisted). Delivery is strict
      // contiguous from `nextSeq`: an event is only sent once every earlier
      // seq has been delivered, so the client never sees out-of-order frames
      // (which would corrupt streamed token text) and never sees duplicates.
      const buffer = new Map<number, { type: string; payload: unknown }>();
      let nextSeq = floor + 1;
      let deliveredDone = false;
      let draining = false;
      let drainScheduled = false;
      let recheckTimer: ReturnType<typeof setTimeout> | null = null;

      const enqueue = (value: string) => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(value));
          } catch {
            closed = true;
          }
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        if (recheckTimer) {
          clearTimeout(recheckTimer);
          recheckTimer = null;
        }
        try {
          unsubscribe();
        } catch {
          // ignore
        }
        clearInterval(hb);
        req.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Deliver the contiguous run starting at nextSeq (synchronous).
      const drain = () => {
        if (draining || closed) return;
        draining = true;
        try {
          for (;;) {
            const ev = buffer.get(nextSeq);
            if (!ev) break;
            buffer.delete(nextSeq);
            if (ev.type === "done") deliveredDone = true;
            enqueue(sseFrame(nextSeq, ev.type, ev.payload));
            nextSeq++;
          }
        } finally {
          draining = false;
        }
      };

      // Schedule a catch-up read of the persisted timeline + drain.
      const scheduleCatchUp = () => {
        if (closed || drainScheduled) return;
        drainScheduled = true;
        void (async () => {
          try {
            if (closed) return;
            let persisted: RunEventRow[] = [];
            try {
              persisted = await store.listEvents(id, floor);
            } catch {
              persisted = [];
            }
            for (const p of persisted) {
              if (p.seq >= nextSeq && !buffer.has(p.seq)) {
                buffer.set(p.seq, { type: p.type, payload: safeParse(p.payload) });
              }
            }
            drain();
            const current = await store.getRun(id).catch(() => null);
            if (closed) return;
            if (current && TERMINAL.has(current.status)) {
              if (deliveredDone) {
                close();
              } else if (!recheckTimer) {
                // Terminal row but the done event hasn't been delivered yet
                // (it is persisted a few ms after the final status patch).
                // Give it one recheck; if it's still missing, close with a
                // synthetic frame — the durable timeline is authoritative.
                recheckTimer = setTimeout(async () => {
                  recheckTimer = null;
                  if (closed) return;
                  try {
                    const persisted = await store.listEvents(id, floor);
                    for (const p of persisted) {
                      if (p.seq >= nextSeq && !buffer.has(p.seq)) {
                        buffer.set(p.seq, { type: p.type, payload: safeParse(p.payload) });
                      }
                    }
                  } catch {
                    // store unavailable — fall through to synthetic close
                  }
                  drain();
                  if (closed || deliveredDone) {
                    if (!closed) close();
                    return;
                  }
                  const cur = await store.getRun(id).catch(() => null);
                  if (cur && TERMINAL.has(cur.status)) {
                    enqueue(sseFrame(nextSeq, "done", { status: cur.status, recovered: true }));
                    close();
                  }
                }, 200);
                (recheckTimer as { unref?: () => void }).unref?.();
              }
            }
          } finally {
            drainScheduled = false;
          }
        })();
      };

      const unsubscribe = subscribeRun(id, (ev) => {
        if (closed || ev.seq <= floor || ev.seq < nextSeq) return;
        if (!buffer.has(ev.seq)) buffer.set(ev.seq, { type: ev.type, payload: ev.payload });
        drain();
        scheduleCatchUp();
      });

      const onAbort = () => close();
      const hb = setInterval(() => {
        if (!closed) enqueue(": hb\n\n");
      }, 15_000);

      req.signal.addEventListener("abort", onAbort);

      // Recover any run stuck "running" by a previous process incarnation,
      // then perform the initial catch-up (persisted replay + live drain).
      void recoverStaleRuns(store).catch(() => undefined);
      scheduleCatchUp();
    },
    cancel() {
      // Client left; close() runs via the abort path. Nothing to do here.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
