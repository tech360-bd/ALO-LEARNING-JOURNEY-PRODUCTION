// ALO Learning Journey — Super Admin chat orchestration (server-only).
//
// One owner message = one persistent run (Phase C2). The run engine
// (runs.ts) is the SINGLE execution path for every command: deterministic
// intent parsing (Bengali + English), allowlisted execution, a durable event
// timeline, and — for free-form chat — the omni-router (local Ollama first,
// then ONE free provider at a time). The AI never performs system changes
// directly; only the allowlisted run plans do.
//
// This module is the synchronous facade used by POST /api/super-admin/chat.
// It creates a run, awaits the pipeline, and maps the final run row onto the
// classic response shape. The streaming UI uses POST /api/super-admin/runs
// + SSE directly and gets the same records.

import { db } from "@/lib/db";
import { getRunStore } from "@/lib/super-admin/run-store";
import { createRun, executeRunPipeline } from "@/lib/super-admin/runs";

export interface ChatTurn {
  ok: boolean;
  reply: string;
  provider: string;
  degraded: boolean;
  intent: string;
  execution?: Record<string, unknown>;
  pendingActionId?: string;
  /** Persistent run id — the turn's durable execution timeline. */
  runId: string;
}

export async function handleSuperAdminMessage(
  conversationId: string,
  message: string,
  ownerId: string
): Promise<ChatTurn> {
  const store = await getRunStore();
  const run = await createRun(ownerId, conversationId, message, store);

  // The pipeline persists the user + assistant messages itself (tagged with
  // runId, so history restores the timeline). We capture the assistant reply
  // for the synchronous response.
  let reply: string | null = null;
  await executeRunPipeline(run.id, {
    store,
    persistMessage: async (m) => {
      if (m.role === "assistant") reply = m.content;
      await db.superAdminMessage
        .create({
          data: {
            conversationId,
            role: m.role,
            content: m.content.slice(0, 8000),
            provider: m.provider ?? null,
            runId: m.runId,
          },
        })
        .catch(() => undefined);
    },
  }).catch(() => undefined);

  const final = (await store.getRun(run.id).catch(() => null)) ?? run;
  const awaiting = final.status === "awaiting_approval";

  let execution: Record<string, unknown> | undefined;
  try {
    if (final.result) execution = JSON.parse(final.result) as Record<string, unknown>;
  } catch {
    execution = undefined;
  }
  const degraded = Boolean(
    execution && typeof execution === "object" && (execution as Record<string, unknown>).degraded === true
  );

  return {
    ok: final.status === "completed" || awaiting,
    reply:
      reply ??
      (awaiting
        ? "This action needs your approval. Review the pending action in the System Monitor."
        : final.error
          ? `⚠️ ${final.error}`
          : "(no reply recorded)"),
    provider: final.intent === "chat" ? (final.provider ?? "unavailable") : "executor",
    degraded,
    intent: final.intent ?? "chat",
    execution,
    pendingActionId: final.pendingActionId ?? undefined,
    runId: run.id,
  };
}
