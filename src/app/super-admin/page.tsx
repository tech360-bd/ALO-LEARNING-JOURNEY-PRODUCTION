'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import {
  Plus,
  Trash2,
  Send,
  RefreshCw,
  ShieldCheck,
  Bot,
  User,
  Sparkles,
  Activity,
  Cpu,
  AlertTriangle,
  Wrench,
  CheckCircle2,
  XCircle,
  Loader2,
  PanelRightOpen,
  PanelRightClose,
  MessageSquare,
  Search,
  HeartPulse,
  Network,
  Clock,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';

// ─────────────────────────────────────────────────────────────────────────────
// Types (mirror the /api/super-admin/* responses)
// ─────────────────────────────────────────────────────────────────────────────
interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  lastMessage: string | null;
}
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  provider?: string | null;
  runId?: string | null;
}
// Durable execution timeline for a run (Phase C2).
interface TimelineStep {
  label: string;
  status: 'started' | 'completed' | 'failed';
  detail?: string;
  ms?: number;
}
interface Timeline {
  status: 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  steps: TimelineStep[];
  plan?: string[];
  provider?: string | null;
  model?: string | null;
  approval?: { actionId: string | null; kind: string; title: string } | null;
  error?: string | null;
  persistent: boolean;
}
interface ChatTurn {
  ok: boolean;
  reply: string;
  provider: string;
  intent: string;
  execution?: Record<string, unknown> | null;
  pendingActionId?: string;
}
interface HealthCheck {
  ok: boolean;
  detail: string;
}
interface Health {
  ok: boolean;
  checks: Record<string, HealthCheck>;
  openFindings: number;
  pendingActions: number;
}
interface ProviderInfo {
  provider: string;
  kind?: string;
  configured: boolean;
  model: string;
  reason?: string;
}
interface RouterHealth {
  providerId: string;
  status: string;
  consecutiveFailures: number;
  lastError: string | null;
  lastLatencyMs: number | null;
}
interface RouterStatus {
  preferredProvider: string | null;
  chainOrder: string[];
  external: { enabled: boolean; configured: boolean; providers: ProviderInfo[] };
  local: { model: string; baseUrl: string } | null;
  health: RouterHealth[];
  cooldowns: Array<{ providerId: string; retryAfterMs: number }>;
}
interface Finding {
  id: string;
  kind: string;
  severity: string;
  title: string;
  detail?: string | null;
  url?: string | null;
  fixKind?: string | null;
}
interface PendingAction {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  risk: string;
  status: string;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suggestion chips (ChatGPT-style starter prompts)
// ─────────────────────────────────────────────────────────────────────────────
const SUGGESTIONS: Array<{ label: string; prompt: string; icon: React.ReactNode }> = [
  { label: 'System health check', prompt: 'Run a full system health check', icon: <HeartPulse className="size-4" /> },
  { label: 'Scan for errors', prompt: 'Scan the system and the website for errors', icon: <Search className="size-4" /> },
  { label: 'Auto-fix issues', prompt: 'Apply safe fixes to detected errors', icon: <Wrench className="size-4" /> },
  { label: 'Switch provider', prompt: 'Switch to the next healthy AI provider', icon: <Network className="size-4" /> },
  { label: 'Show analytics', prompt: 'Show the latest analytics summary', icon: <Activity className="size-4" /> },
  { label: 'Which provider is active?', prompt: 'Which AI provider is currently active?', icon: <Cpu className="size-4" /> },
];

function severityColor(s: string): string {
  if (s === 'critical') return 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30';
  if (s === 'error') return 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30';
  if (s === 'warn') return 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30';
  return 'bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30';
}

function healthDot(ok: boolean) {
  return (
    <span
      className={`inline-block size-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`}
      role="status"
      aria-label={ok ? 'ok' : 'problem'}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// Rebuild a timeline from the server's persisted events (refresh path).
function timelineFromServer(data: { run?: any; events?: any[]; persistent?: boolean }): Timeline {
  const steps: TimelineStep[] = [];
  let approval: Timeline['approval'] = null;
  let error: string | null = null;
  let plan: string[] | undefined;
  for (const ev of data.events ?? []) {
    const p = ev.payload ?? {};
    if (ev.type === 'step') {
      const i = steps.findIndex((s) => s.label === p.label);
      if (p.status === 'started' || i < 0) {
        steps.push({ label: p.label, status: (p.status ?? 'started') as TimelineStep['status'], detail: p.detail, ms: p.ms });
      } else {
        steps[i] = { ...steps[i], status: (p.status ?? 'completed') as TimelineStep['status'], detail: p.detail ?? steps[i].detail, ms: p.ms ?? steps[i].ms };
      }
    } else if (ev.type === 'approval') {
      approval = { actionId: p.actionId ?? null, kind: p.kind ?? '', title: p.title ?? '' };
    } else if (ev.type === 'error') {
      error = p.message ?? null;
    } else if (ev.type === 'status' && Array.isArray(p.plan)) {
      plan = p.plan;
    }
  }
  return {
    status: (data.run?.status ?? 'completed') as Timeline['status'],
    steps,
    plan,
    provider: data.run?.provider ?? null,
    model: data.run?.model ?? null,
    approval,
    error,
    persistent: Boolean(data.persistent),
  };
}

// Small execution-timeline card rendered under an assistant message.
function RunTimelineCard({
  runId,
  timeline,
  onCancel,
}: {
  runId: string;
  timeline: Timeline;
  onCancel: (runId: string) => void;
}) {
  const running = timeline.status === 'running';
  const statusColor =
    timeline.status === 'completed'
      ? 'text-green-600'
      : timeline.status === 'awaiting_approval'
        ? 'text-amber-600'
        : timeline.status === 'failed' || timeline.status === 'interrupted'
          ? 'text-red-600'
          : timeline.status === 'cancelled'
            ? 'text-zinc-500'
            : 'text-blue-600';
  const stepIcon = (s: TimelineStep) =>
    s.status === 'completed' ? <CheckCircle2 className="size-3.5 text-green-600" /> : s.status === 'failed' ? <XCircle className="size-3.5 text-red-500" /> : <Loader2 className="size-3.5 animate-spin text-blue-600" />;
  return (
    <div className="mt-2 w-full max-w-xl rounded-lg border border-border bg-card/60 p-2.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
          <Activity className="size-3.5" />
          Execution timeline
          <span className={statusColor}>({timeline.status.replace('_', ' ')})</span>
          {timeline.provider && <span className="text-muted-foreground/70">· {timeline.provider}{timeline.model ? ` · ${timeline.model}` : ''}</span>}
          {!timeline.persistent && <span className="rounded bg-amber-500/10 px-1 text-amber-600">in-memory store</span>}
        </span>
        {running && (
          <button type="button" onClick={() => onCancel(runId)} className="rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:text-foreground">
            Cancel
          </button>
        )}
      </div>
      {timeline.plan && (
        <div className="mt-1 text-muted-foreground/80">plan: {timeline.plan.join(' → ')}</div>
      )}
      {timeline.steps.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {timeline.steps.map((s, i) => (
            <li key={i} className="flex items-center gap-1.5">
              {stepIcon(s)}
              <span className={s.status === 'completed' ? 'text-foreground' : s.status === 'failed' ? 'text-red-600' : 'text-muted-foreground'}>{s.label}</span>
              {s.ms != null && s.status === 'completed' && <span className="text-muted-foreground/60">{s.ms}ms</span>}
              {s.detail && <span className="truncate text-muted-foreground/70">— {String(s.detail).slice(0, 90)}</span>}
            </li>
          ))}
        </ul>
      )}
      {timeline.approval && (
        <a
          href="#system-monitor"
          className="mt-1.5 inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700 hover:bg-amber-500/20"
        >
          <ShieldCheck className="size-3" />
          Approval pending: {timeline.approval.title} — review in System Monitor
        </a>
      )}
      {timeline.error && <div className="mt-1 text-red-600">{timeline.error}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export default function SuperAdminPage() {
  const navRouter = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [panelOpen, setPanelOpen] = useState<boolean>(
    typeof window !== 'undefined' ? window.innerWidth > 1280 : true
  );
  const [authFailed, setAuthFailed] = useState(false);

  // Right-panel data
  const [health, setHealth] = useState<Health | null>(null);
  const [router, setRouter] = useState<RouterStatus | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [scanning, setScanning] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── Run timelines (Phase C2) ─────────────────────────────────────────────
  // runId -> durable timeline state. Restored from the server after refresh.
  const [timelines, setTimelines] = useState<Record<string, Timeline>>({});
  const esRef = useRef<EventSource | null>(null);
  const activeRunRef = useRef<string | null>(null);

  const closeStream = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  // ── Data loaders ──────────────────────────────────────────────────────────
  const loadConversations = useCallback(async () => {
    const res = await fetch('/api/super-admin/conversations', { cache: 'no-store' });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403 || res.status === 503) setAuthFailed(true);
      return;
    }
    const data = await res.json();
    setConversations(data.conversations ?? []);
  }, []);

  const loadPanel = useCallback(async () => {
    const [h, p, s, a] = await Promise.all([
      fetch('/api/super-admin/health', { cache: 'no-store' }),
      fetch('/api/super-admin/providers', { cache: 'no-store' }),
      fetch('/api/super-admin/self-heal', { cache: 'no-store' }),
      fetch('/api/super-admin/actions?status=pending', { cache: 'no-store' }),
    ]);
    if (h.ok) setHealth(await h.json());
    if (p.ok) setRouter((await p.json()).router ?? null);
    if (s.ok) setFindings((await s.json()).findings ?? []);
    if (a.ok) setPendingActions((await a.json()).actions ?? []);
    if ([h.status, p.status, s.status, a.status].some((x) => x === 401 || x === 403 || x === 503)) {
      setAuthFailed(true);
    }
  }, []);

  // Attach the SSE stream for a run. Replays the durable timeline from
  // seq 0, then follows live events; closes on terminal state. EventSource
  // auto-reconnects (Last-Event-ID) if the connection drops mid-run.
  const openRunStream = useCallback((runId: string) => {
    closeStream();
    activeRunRef.current = runId;
    const es = new EventSource(`/api/super-admin/runs/${encodeURIComponent(runId)}/events?afterSeq=0`, { withCredentials: true });
    esRef.current = es;

    const onEvent = (type: string) => (e: MessageEvent) => {
      let payload: any = {};
      try {
        payload = JSON.parse(e.data || '{}');
      } catch {
        /* ignore */
      }
      applyRunEvent(runId, type, payload);
      if (type === 'approval') uiRef.current.toast('An approval is pending — review it in the System Monitor.');
      if (type === 'done') {
        uiRef.current.onDone(runId);
        closeStream();
      }
    };
    for (const t of ['status', 'step', 'token', 'approval', 'error', 'done']) {
      es.addEventListener(t, onEvent(t));
    }
    es.onerror = () => {
      // EventSource retries automatically; if the run is terminal the
      // server closes and the connection ends. Nothing to do here.
    };
  }, [closeStream]);

  // Restore a run's durable timeline (after refresh). A live "running" run
  // is re-streamed so the client catches up and continues live.
  const restoreTimeline = useCallback(async (runId: string) => {
    const res = await fetch(`/api/super-admin/runs/${encodeURIComponent(runId)}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const tl: Timeline = timelineFromServer(data);
    setTimelines((t) => ({ ...t, [runId]: tl }));
    if (tl.status === 'running') {
      openRunStream(runId);
    }
  }, [openRunStream]);

  const loadHistory = useCallback(async (id: string) => {
    const res = await fetch(`/api/super-admin/chat?conversationId=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const msgs: ChatMessage[] = (data.messages ?? []).map((m: any) => ({
      role: m.role,
      content: m.content,
      provider: m.provider,
      runId: m.runId ?? null,
    }));
    setMessages(msgs);
    // Restore timelines for recent assistant turns (capped to stay cheap).
    const runIds = [...new Set(msgs.filter((m) => m.runId).map((m) => m.runId as string))].slice(-12);
    await Promise.all(runIds.map((rid) => restoreTimeline(rid)));
  }, [restoreTimeline]);

  useEffect(() => {
    loadConversations();
    loadPanel();
  }, [loadConversations, loadPanel]);

  // Close any open run stream on unmount.
  useEffect(() => {
    return () => closeStream();
  }, [closeStream]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const startNewChat = useCallback(() => {
    setConversationId(null);
    setMessages([]);
    setInput('');
  }, []);

  const openConversation = useCallback(
    (id: string) => {
      setConversationId(id);
      loadHistory(id);
    },
    [loadHistory]
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      await fetch(`/api/super-admin/conversations?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (conversationId === id) startNewChat();
      loadConversations();
    },
    [conversationId, startNewChat, loadConversations]
  );

  // Fold one SSE run event into the UI state (token -> streamed text,
  // everything else -> timeline state).
  const applyRunEvent = useCallback((runId: string, type: string, p: any) => {
    if (type === 'token' && typeof p.text === 'string') {
      setMessages((ms) => {
        const last = ms[ms.length - 1];
        if (!last || last.role !== 'assistant' || last.runId !== runId) return ms;
        const copy = ms.slice();
        copy[copy.length - 1] = { ...last, content: last.content + p.text };
        return copy;
      });
      return;
    }
    setTimelines((t) => {
      const cur = t[runId] ?? { status: 'running' as const, steps: [] as TimelineStep[], persistent: true };
      const next: Timeline = { ...cur, steps: cur.steps.slice() };
      if (type === 'status') {
        if (p.status) next.status = p.status as Timeline['status'];
        if (Array.isArray(p.plan)) next.plan = p.plan;
      } else if (type === 'step') {
        // The server names the step `step` (legacy payloads used `label`).
        const label = typeof p.step === 'string' ? p.step : p.label;
        const i = next.steps.findIndex((s) => s.label === label);
        if (i >= 0) next.steps[i] = { ...next.steps[i], status: (p.status ?? 'started') as TimelineStep['status'], detail: p.detail ?? next.steps[i].detail, ms: p.ms ?? next.steps[i].ms };
        else next.steps.push({ label, status: (p.status ?? 'started') as TimelineStep['status'], detail: p.detail, ms: p.ms });
      } else if (type === 'approval') {
        next.approval = { actionId: p.actionId ?? null, kind: p.kind ?? '', title: p.title ?? '' };
      } else if (type === 'error') {
        next.error = p.message ?? null;
      } else if (type === 'done') {
        next.status = (p.status ?? next.status) as Timeline['status'];
        if (typeof p.partialContent === 'string' && p.partialContent) next.error = next.error ?? `Cancelled — partial output kept: ${p.partialContent.slice(0, 120)}`;
      }
      return { ...t, [runId]: next };
    });
  }, []);

  // Keep latest UI callbacks reachable from the long-lived stream closure.
  const uiRef = useRef({ toast: (_m: string) => {}, onDone: (_runId: string) => {} });
  const convIdRef = useRef<string | null>(null);
  useEffect(() => {
    convIdRef.current = conversationId;
  }, [conversationId]);
  useEffect(() => {
    uiRef.current = {
      toast: showToast,
      onDone: (runId: string) => {
        setBusy(false); // this run's stream ended — input is free again
        if (convIdRef.current) loadHistory(convIdRef.current); // canonical persisted text
        loadConversations();
        loadPanel(); // system state may have changed (scan/fix/switch)
        setTimelines((t) => {
          if (t[runId]?.approval) uiRef.current.toast('An approval is pending — review it in the System Monitor.');
          return t;
        });
      },
    };
  }, [showToast, loadHistory, loadConversations, loadPanel]);

  const cancelRun = useCallback(async (runId: string) => {
    try {
      await fetch(`/api/super-admin/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
      // The terminal event streams back via SSE; as a fallback, refetch the row.
      window.setTimeout(() => restoreTimeline(runId), 1200);
    } catch {
      uiRef.current.toast('Could not reach the server to cancel the run.');
    }
  }, [restoreTimeline]);

  const send = useCallback(
    async (text?: string) => {
      const msg = (text ?? input).trim();
      if (!msg || busy) return;
      setInput('');
      setMessages((m) => [...m, { role: 'user', content: msg }]);
      setBusy(true);
      // Stays true until the run's SSE stream ends (onDone) — one run at a
      // time in this command center (the UI keeps a single active stream).
      let runStarted = false;
      try {
        // Every turn is a persistent, streamable run (Phase C2).
        const res = await fetch('/api/super-admin/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: conversationId ?? undefined, message: msg }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if ([401, 403, 503].includes(res.status)) setAuthFailed(true);
          setMessages((m) => [...m, { role: 'assistant', content: `⚠️ ${data.error ?? `Request failed (HTTP ${res.status})`}`, provider: 'error' }]);
          return;
        }
        const runId: string = data.runId;
        runStarted = true;
        setConversationId(data.conversationId);
        // Streaming placeholder — tokens land here live (applyRunEvent).
        setMessages((m) => [...m, { role: 'assistant', content: '', provider: null, runId }]);
        setTimelines((t) => ({ ...t, [runId]: { status: 'running', steps: [], persistent: Boolean(data.persistent) } }));
        openRunStream(runId);
        // Note: onDone (via SSE) reloads canonical history + panel and clears busy.
      } catch (err) {
        setMessages((m) => [
          ...m,
          { role: 'assistant', content: `⚠️ Network error: ${err instanceof Error ? err.message : 'unknown'}`, provider: 'error' },
        ]);
      } finally {
        // If the run started, busy stays true until its stream ends (onDone).
        if (!runStarted) setBusy(false);
      }
    },
    [input, busy, conversationId, openRunStream]
  );

  const setPreferredProvider = useCallback(
    async (providerId: string) => {
      const res = await fetch('/api/super-admin/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: providerId === 'auto' ? null : providerId }),
      });
      if (res.ok) {
        setRouter((await res.json()).router ?? null);
        showToast(providerId === 'auto' ? 'Provider set to auto (chain order).' : `Preferred provider: ${providerId}`);
      }
    },
    [showToast]
  );

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await fetch('/api/super-admin/self-heal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'scan' }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const s = await fetch('/api/super-admin/self-heal', { cache: 'no-store' });
        if (s.ok) setFindings((await s.json()).findings ?? []);
        showToast(data.count === 0 ? 'Scan complete — no errors found.' : `Scan complete — ${data.count} finding(s).`);
      } else {
        showToast(`Scan failed: ${data.error ?? res.status}`);
      }
    } finally {
      setScanning(false);
      loadPanel();
    }
  }, [showToast, loadPanel]);

  const runFix = useCallback(async () => {
    setFixing(true);
    try {
      const res = await fetch('/api/super-admin/self-heal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'fix' }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast(
          data.results?.length
            ? `Applied ${data.results.filter((r: any) => r.ok).length}/${data.results.length} safe fix(es).`
            : 'No safe auto-fixes available.'
        );
      } else {
        showToast(`Fix failed: ${data.error ?? res.status}`);
      }
    } finally {
      setFixing(false);
      loadPanel();
    }
  }, [showToast, loadPanel]);

  const decideAction = useCallback(
    async (id: string, decision: 'approve' | 'reject') => {
      const res = await fetch('/api/super-admin/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, decision }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast(data.note ?? (decision === 'approve' ? 'Action approved.' : 'Action rejected.'));
      } else {
        showToast(`Action ${decision} failed: ${data.error ?? res.status}`);
      }
      loadPanel();
    },
    [showToast, loadPanel]
  );

  const knownProviders = useMemo(() => {
    if (!router) return [];
    return router.external.providers.map((p) => p.provider);
  }, [router]);

  if (authFailed) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center">
        <ShieldCheck className="size-10 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Super Admin access required</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          This command center is restricted to the owner account. Sign in from the dashboard to continue.
        </p>
        <Button onClick={() => navRouter.push('/dashboard')}>Go to dashboard</Button>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* ── Left sidebar (ChatGPT-style) ─────────────────────────────── */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/30">
        <div className="flex items-center gap-2 px-4 pt-4">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">ALO Super Admin</p>
            <p className="text-[11px] leading-tight text-muted-foreground">System command center</p>
          </div>
        </div>

        <div className="px-3 pt-4">
          <Button variant="outline" size="sm" className="w-full justify-start" onClick={startNewChat}>
            <Plus className="size-4" /> New chat
          </Button>
        </div>

        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <p className="px-4 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Chats</p>
          <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
            <div className="flex flex-col gap-0.5">
              {conversations.length === 0 && (
                <p className="px-2 py-3 text-xs text-muted-foreground">No conversations yet.</p>
              )}
              {conversations.map((c) => (
                <div
                  key={c.id}
                  className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent ${
                    conversationId === c.id ? 'bg-accent' : ''
                  }`}
                  onClick={() => openConversation(c.id)}
                >
                  <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate leading-tight">{c.title}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {c.lastMessage ?? new Date(c.updatedAt).toLocaleString()}
                    </p>
                  </div>
                  <button
                    className="hidden shrink-0 rounded p-1 text-muted-foreground hover:text-destructive group-hover:block"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConversation(c.id);
                    }}
                    aria-label="Delete conversation"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>

        <div className="border-t border-border p-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              {healthDot(health?.ok ?? false)} {health ? (health.ok ? 'System healthy' : 'Attention needed') : 'Checking…'}
            </span>
            <button
              className="rounded p-1 hover:text-foreground"
              onClick={() => navRouter.push('/dashboard')}
              aria-label="Open dashboard"
            >
              <ExternalLink className="size-3.5" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main chat column ────────────────────────────────────────── */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-muted-foreground" />
            <h1 className="text-sm font-medium">
              {messages.length ? conversationId ?? 'Conversation' : 'Super Admin Assistant'}
            </h1>
            {router && (
              <Badge variant="outline" className="hidden gap-1 md:inline-flex">
                <Cpu className="size-3" />
                {router.preferredProvider ?? router.chainOrder[0] ?? 'no provider'}
              </Badge>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={() => setPanelOpen((v) => !v)} aria-label="Toggle system monitor">
            {panelOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
          </Button>
        </header>

        {/* Messages */}
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center pt-16 text-center">
                <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Sparkles className="size-7" />
                </div>
                <h2 className="mt-4 text-xl font-semibold">What would you like to manage?</h2>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  Describe a change in plain language — the assistant will check system health, scan for errors,
                  switch AI providers, and draft announcements. Risky changes always wait for your approval.
                </p>
                <div className="mt-6 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s.label}
                      className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-left text-sm shadow-xs transition-colors hover:bg-accent"
                      onClick={() => send(s.prompt)}
                    >
                      <span className="text-primary">{s.icon}</span>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Bot className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    {m.content ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none [&_p]:m-0 [&_p]:leading-relaxed [&_p]:text-sm [&_ul]:my-1 [&_ol]:my-1 [&_li]:text-sm [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h4]:text-sm [&_code]:text-xs [&_pre]:rounded-lg [&_pre]:bg-muted/50 [&_blockquote]:border-l-2 [&_blockquote]:border-orange-500/50 [&_blockquote]:pl-3 [&_blockquote]:italic [&_a]:text-orange-400">
                        <ReactMarkdown>{m.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" /> Running…
                      </p>
                    )}
                    {m.provider && m.provider !== 'error' && (
                      <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Cpu className="size-3" /> via {m.provider}
                      </p>
                    )}
                    {m.runId && timelines[m.runId] && (
                      <RunTimelineCard runId={m.runId} timeline={timelines[m.runId]} onCancel={cancelRun} />
                    )}
                  </div>
                </div>
              )
            )}

            {busy && (
              <div className="flex gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Bot className="size-4" />
                </div>
                <div className="flex items-center gap-1.5 pt-2 text-sm text-muted-foreground">
                  <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-current" />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>

        {/* Composer (ChatGPT-style) */}
        <div className="shrink-0 border-t border-border bg-background px-4 py-4">
          <div className="mx-auto max-w-3xl">
            <div className="flex items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-xs focus-within:ring-2 focus-within:ring-ring/40">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="Ask the system to do something…"
                rows={1}
                className="max-h-40 min-h-[44px] flex-1 resize-none border-0 bg-transparent px-2 py-2.5 shadow-none focus-visible:ring-0"
              />
              <Button size="icon" className="size-10 shrink-0 rounded-xl" onClick={() => send()} disabled={busy || !input.trim()} aria-label="Send">
                <Send className="size-4" />
              </Button>
            </div>
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              The assistant can make system changes. Destructive actions are blocked; risky changes require approval.
            </p>
          </div>
        </div>
      </main>

      {/* ── Right panel: System Monitor ─────────────────────────────── */}
      {panelOpen && (
        <aside id="system-monitor" className="flex w-[340px] shrink-0 flex-col border-l border-border bg-muted/20">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <Activity className="size-4 text-primary" /> System Monitor
            </h2>
            <Button variant="ghost" size="icon" onClick={loadPanel} aria-label="Refresh">
              <RefreshCw className="size-4" />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-4">
              {/* Health */}
              <section className="rounded-xl border border-border bg-card p-3">
                <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <HeartPulse className="size-3.5" /> Health
                </h3>
                {!health ? (
                  <p className="text-xs text-muted-foreground">Loading…</p>
                ) : (
                  <ul className="flex flex-col gap-1.5 text-xs">
                    {Object.entries(health.checks).map(([name, c]) => (
                      <li key={name} className="flex items-start gap-2">
                        <span className="mt-0.5">{healthDot(c.ok)}</span>
                        <span className="flex-1">
                          <span className="font-medium capitalize">{name.replace(/([A-Z])/g, ' $1')}</span>
                          <span className="block text-muted-foreground">{c.detail}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Providers */}
              <section className="rounded-xl border border-border bg-card p-3">
                <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Network className="size-3.5" /> AI Providers (single-active)
                </h3>
                {!router ? (
                  <p className="text-xs text-muted-foreground">Loading…</p>
                ) : (
                  <>
                    <div className="mb-2 flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground">Preferred:</span>
                      <Select value={router.preferredProvider ?? 'auto'} onValueChange={setPreferredProvider}>
                        <SelectTrigger className="h-8 flex-1 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">Auto (chain order)</SelectItem>
                          {knownProviders.map((p) => (
                            <SelectItem key={p} value={p}>
                              {p}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="mb-2 text-[11px] text-muted-foreground">
                      Chain: {router.chainOrder.length ? router.chainOrder.join(' → ') : 'none configured'}
                    </p>
                    <ul className="flex flex-col gap-1 text-xs">
                      {router.external.providers.map((p) => (
                        <li key={p.provider} className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5">
                            {healthDot(p.configured)} {p.provider}
                          </span>
                          <span className="truncate text-muted-foreground" title={p.model}>
                            {p.reason === 'ready' ? p.model : p.reason ?? '—'}
                          </span>
                        </li>
                      ))}
                      {router.health
                        .filter((h) => h.status === 'cooldown' || h.status === 'degraded' || h.status === 'down')
                        .map((h) => (
                          <li key={h.providerId} className="flex items-center justify-between gap-2 text-amber-600 dark:text-amber-400">
                            <span className="flex items-center gap-1.5">
                              <AlertTriangle className="size-3" /> {h.providerId}
                            </span>
                            <span className="text-[11px]">{h.status}</span>
                          </li>
                        ))}
                    </ul>
                  </>
                )}
              </section>

              {/* Self-heal */}
              <section className="rounded-xl border border-border bg-card p-3">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <Wrench className="size-3.5" /> Self-Healing
                  </h3>
                  <div className="flex gap-1">
                    <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={runScan} disabled={scanning}>
                      {scanning ? <RefreshCw className="size-3 animate-spin" /> : <Search className="size-3" />} Scan
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={runFix} disabled={fixing}>
                      {fixing ? <RefreshCw className="size-3 animate-spin" /> : <Wrench className="size-3" />} Auto-fix
                    </Button>
                  </div>
                </div>
                {findings.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No open findings. Run a scan to check providers, database, pages & logs.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {findings.map((f) => (
                      <li key={f.id} className="rounded-lg border border-border p-2">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-xs font-medium leading-snug">{f.title}</p>
                          <Badge variant="outline" className={`shrink-0 text-[10px] ${severityColor(f.severity)}`}>
                            {f.severity}
                          </Badge>
                        </div>
                        {f.detail && <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{f.detail}</p>}
                        {f.fixKind && <p className="mt-1 text-[11px] text-primary">Safe fix: {f.fixKind}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Pending actions */}
              <section className="rounded-xl border border-border bg-card p-3">
                <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Clock className="size-3.5" /> Pending Approvals
                </h3>
                {pendingActions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nothing waiting for your approval.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {pendingActions.map((a) => (
                      <li key={a.id} className="rounded-lg border border-border p-2">
                        <p className="text-xs font-medium">{a.title}</p>
                        {a.detail && <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{a.detail}</p>}
                        <div className="mt-2 flex gap-1.5">
                          <Button size="sm" className="h-7 flex-1 text-[11px]" onClick={() => decideAction(a.id, 'approve')}>
                            <CheckCircle2 className="size-3" /> Approve
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 flex-1 text-[11px]" onClick={() => decideAction(a.id, 'reject')}>
                            <XCircle className="size-3" /> Reject
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </ScrollArea>
        </aside>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
