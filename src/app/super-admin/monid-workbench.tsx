'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Loader2,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// ─────────────────────────────────────────────────────────────────────────────
// Monid Workbench — the owner's screen for a *paid* tool marketplace.
//
// Three rules shape this UI, and they are the same rules the server enforces
// (src/lib/monid.ts), so the screen can never promise more than the API allows:
//
//  1. FREE FIRST. Browsing the catalogue and pricing a call costs nothing, so
//     they are the default view. Nothing here bills until the owner approves.
//  2. THE PRICE IS ALWAYS VISIBLE. A paid call is only proposed with its quoted
//     price (from `inspect`) and the local estimate side by side — never a bare
//     "run" button.
//  3. APPROVAL IS EXPLICIT. The dialog names the provider#endpoint and the cost,
//     and the confirm button is worded as a purchase ("Approve $0.0220 call"),
//     not as a generic "OK".
//
// The activity log keeps the raw JSON of every response. That is deliberate:
// when a vendor changes their shape, the owner sees the change instead of a
// confident but wrong summary.
// ─────────────────────────────────────────────────────────────────────────────

interface MonidStatusView {
  enabled: boolean;
  keyConfigured: boolean;
  paymentGuardOpen: boolean;
  baseUrl: string | null;
  freeOperations: string[];
  billedOperations: string[];
  ready: { discover: boolean; run: boolean };
  reason: string;
}

interface MonidProposal {
  provider: string;
  endpoint: string;
  quotedPrice: string | null;
  estimatedUsd: number | null;
  estimateText: string;
  billed: true;
  warnings: string[];
}

interface LogEntry {
  id: number;
  at: string;
  label: string;
  ok: boolean;
  billed: boolean;
  text: string;
}

function usd(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(4)}`;
}

function Step({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-start gap-2 text-[11px]">
      <span className="mt-0.5 shrink-0">
        {ok ? <CheckCircle2 className="size-3.5 text-emerald-600" /> : <XCircle className="size-3.5 text-destructive" />}
      </span>
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        <span className="block break-words text-muted-foreground">{detail}</span>
      </span>
    </li>
  );
}

export function MonidWorkbench({ onToast }: { onToast: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<MonidStatusView | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const [results, setResults] = useState<Record<string, unknown>[]>([]);
  const [discovered, setDiscovered] = useState(false);

  // The call being priced/approved. `inputText` is the raw JSON the owner (or
  // the agent) will send, so what is approved is exactly what is sent.
  const [provider, setProvider] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [inputText, setInputText] = useState('{}');
  const [inspectText, setInspectText] = useState<string | null>(null);
  const [quotedPrice, setQuotedPrice] = useState<string | null>(null);
  const [proposal, setProposal] = useState<MonidProposal | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [approvalId, setApprovalId] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);

  const addLog = useCallback((label: string, ok: boolean, billed: boolean, text: string) => {
    setLog((entries) =>
      [{ id: Date.now() + Math.random(), at: new Date().toLocaleTimeString(), label, ok, billed, text }, ...entries].slice(0, 25),
    );
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/super-admin/monid', { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (res.ok) setStatus(body.status ?? null);
      else addLog('status', false, false, body?.message ?? `HTTP ${res.status}`);
    } catch (e) {
      addLog('status', false, false, (e as Error).message);
    }
  }, [addLog]);

  useEffect(() => {
    if (open) void loadStatus();
  }, [open, loadStatus]);

  const post = useCallback(
    async (payload: Record<string, unknown>) => {
      const res = await fetch('/api/super-admin/monid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, body } as const;
    },
    [],
  );

  const parseInput = useCallback((): Record<string, unknown> | null => {
    const raw = inputText.trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      onToast('Input must be a JSON object like {"body":{"numResults":10}}.');
      return null;
    } catch (e) {
      onToast(`Input is not valid JSON: ${(e as Error).message}`);
      return null;
    }
  }, [inputText, onToast]);

  const discover = useCallback(async () => {
    if (query.trim().length < 3) {
      onToast('Type at least 3 characters to search the catalogue.');
      return;
    }
    setBusy('discover');
    try {
      const { ok, body, status: code } = await post({ action: 'discover', query, limit: 12 });
      if (ok) {
        const rows = Array.isArray(body.result?.results) ? body.result.results : [];
        setResults(rows);
        setDiscovered(true);
        addLog('discover (free)', true, false, `${rows.length} candidate(s) for “${query}”`);
      } else {
        addLog('discover (free)', false, false, body?.message ?? `HTTP ${code}`);
      }
    } catch (e) {
      addLog('discover (free)', false, false, (e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [post, query, addLog, onToast]);

  const inspect = useCallback(
    async (p = provider, e = endpoint) => {
      if (!p || !e) {
        onToast('Pick a provider and an endpoint first.');
        return;
      }
      setBusy('inspect');
      try {
        const { ok, body, status: code } = await post({ action: 'inspect', provider: p, endpoint: e });
        if (ok) {
          setInspectText(body.text ?? '');
          const price =
            (typeof body.result?.price === 'string' && body.result.price) ||
            (typeof body.result?.pricing?.display === 'string' && body.result.pricing.display) ||
            null;
          setQuotedPrice(price);
          setProposal(null);
          addLog(`inspect ${p}#${e} (free)`, true, false, price ? `quoted ${price}` : 'no price field in the response');
        } else {
          addLog(`inspect ${p}#${e} (free)`, false, false, body?.message ?? `HTTP ${code}`);
        }
      } catch (err) {
        addLog(`inspect ${p}#${e} (free)`, false, false, (err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [post, provider, endpoint, addLog, onToast],
  );

  const propose = useCallback(async () => {
    if (!provider || !endpoint) {
      onToast('Pick a provider and an endpoint first.');
      return;
    }
    const input = parseInput();
    if (input === null && inputText.trim()) return;
    setBusy('propose');
    try {
      const { ok, body, status: code } = await post({ action: 'propose', provider, endpoint, input, quotedPrice });
      if (ok) {
        setProposal(body.proposal as MonidProposal);
        addLog(`propose ${provider}#${endpoint}`, true, false, `estimate ${usd(body.proposal?.estimatedUsd)}`);
      } else {
        addLog(`propose ${provider}#${endpoint}`, false, false, body?.message ?? `HTTP ${code}`);
      }
    } catch (e) {
      addLog('propose', false, false, (e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [post, provider, endpoint, parseInput, inputText, quotedPrice, addLog, onToast]);

  const copyPrompt = useCallback(async () => {
    if (!proposal) return;
    const input = parseInput();
    const prompt =
      `Run the Monid endpoint ${proposal.provider}#${proposal.endpoint} once` +
      (input ? ` with input ${JSON.stringify(input)}` : '') +
      `. It is billed${proposal.quotedPrice ? ` (quoted ${proposal.quotedPrice}` : proposal.estimatedUsd !== null ? ` (estimate ${usd(proposal.estimatedUsd)}` : ''}` +
      `${proposal.quotedPrice || proposal.estimatedUsd !== null ? ')' : ''} — show me the price and wait for my approval before running it.`;
    try {
      await navigator.clipboard.writeText(prompt);
      onToast('Approval prompt copied — paste it into the chat to have the agent propose it.');
    } catch {
      onToast('Could not copy. Select the prompt text and copy it manually.');
    }
  }, [proposal, parseInput, onToast]);

  const preflight = useMemo(() => {
    if (!proposal) return [];
    const steps: { ok: boolean; label: string; detail: string }[] = [
      {
        ok: Boolean(status?.ready.run),
        label: 'Server will accept a billed run',
        detail: status?.ready.run
          ? 'Integration on, key set and both AI switches are on.'
          : status?.enabled
            ? 'Blocked: ' + (status?.reason ?? 'unknown reason')
            : 'Integration is off (ALO_MONID_ENABLED).',
      },
      {
        ok: Boolean(proposal.quotedPrice),
        label: 'Price was quoted by inspect',
        detail: proposal.quotedPrice ?? 'No quote yet — the approval would be for an unknown cost.',
      },
      {
        ok: proposal.estimatedUsd !== null,
        label: 'Local estimate available',
        detail: proposal.estimateText,
      },
    ];
    return steps;
  }, [proposal, status]);

  return (
    <section className="rounded-xl border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <ShieldAlert className="size-3.5" /> Monid Tools
        </h3>
        <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Open'}
        </Button>
      </div>

      {!open ? (
        <p className="text-xs text-muted-foreground">
          Search 2,000+ paid tools, price a call, and approve it — searching and pricing are free; a run spends your
          balance and always needs approval.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Status */}
          <div className="rounded-lg border border-border p-2 text-[11px]">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">Status</span>
              <Button variant="ghost" size="icon" className="size-6" onClick={loadStatus} aria-label="Refresh status">
                <RefreshCw className="size-3" />
              </Button>
            </div>
            {!status ? (
              <p className="text-muted-foreground">Loading…</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1 text-muted-foreground">
                <li className="flex items-center gap-1.5">
                  {status.enabled ? <ShieldCheck className="size-3.5 text-emerald-600" /> : <ShieldAlert className="size-3.5 text-amber-600" />}
                  Integration {status.enabled ? 'on' : 'off'} · key {status.keyConfigured ? 'set' : 'missing'}
                </li>
                <li>
                  Free: <span className="font-mono">{status.freeOperations.join(', ')}</span>
                </li>
                <li>
                  Billed: <span className="font-mono">{status.billedOperations.join(', ')}</span> ·{' '}
                  {status.ready.run ? (
                    <span className="text-emerald-600">allowed with approval</span>
                  ) : (
                    <span className="text-amber-600">blocked</span>
                  )}
                </li>
                <li className="break-words">{status.reason}</li>
              </ul>
            )}
          </div>

          {/* Discover */}
          <div className="rounded-lg border border-border p-2">
            <p className="mb-1 text-[11px] font-medium">
              Search the catalogue <Badge variant="outline" className="ml-1 text-[10px]">free</Badge>
            </p>
            <div className="flex gap-1.5">
              <input
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-[11px]"
                placeholder="e.g. company funding data"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void discover();
                }}
                autoComplete="off"
              />
              <Button size="sm" className="h-7 px-2 text-[11px]" onClick={discover} disabled={busy === 'discover'}>
                {busy === 'discover' ? <Loader2 className="size-3 animate-spin" /> : <Search className="size-3" />}
              </Button>
            </div>

            {discovered && results.length === 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">No candidates returned. Try different words.</p>
            )}
            {results.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {results.map((row, i) => {
                  const rp = String((row as Record<string, unknown>).provider ?? '');
                  const re = String((row as Record<string, unknown>).endpoint ?? '');
                  const price =
                    (row as Record<string, unknown>).price ?? (row as Record<string, unknown>).pricing ?? null;
                  return (
                    <li key={`${rp}-${re}-${i}`} className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1 text-[11px]">
                      <span className="min-w-0">
                        <span className="font-mono">
                          {rp}#{re}
                        </span>
                        {price !== null && (
                          <span className="ml-1 text-muted-foreground">
                            {typeof price === 'string' ? price : JSON.stringify(price)}
                          </span>
                        )}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 shrink-0 px-1.5 text-[10px]"
                        onClick={() => {
                          setProvider(rp);
                          setEndpoint(re);
                          setProposal(null);
                          void inspect(rp, re);
                        }}
                      >
                        Inspect
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Price + propose */}
          <div className="rounded-lg border border-border p-2">
            <p className="mb-1 text-[11px] font-medium">Price a call</p>
            <div className="flex gap-1.5">
              <input
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-[11px]"
                placeholder="provider"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setProposal(null);
                }}
                autoComplete="off"
              />
              <input
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-[11px]"
                placeholder="endpoint"
                value={endpoint}
                onChange={(e) => {
                  setEndpoint(e.target.value);
                  setProposal(null);
                }}
                autoComplete="off"
              />
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void inspect()} disabled={busy === 'inspect'}>
                {busy === 'inspect' ? <Loader2 className="size-3 animate-spin" /> : 'Inspect'}
              </Button>
            </div>

            <label className="mt-2 block text-[11px] font-medium" htmlFor="monid-input">
              Input (JSON object, optional)
            </label>
            <textarea
              id="monid-input"
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1 font-mono text-[11px]"
              rows={3}
              placeholder='{"body":{"numResults":10}}'
              value={inputText}
              onChange={(e) => {
                setInputText(e.target.value);
                setProposal(null);
              }}
            />

            {inspectText && (
              <details className="mt-2 rounded border border-border p-2 text-[11px]">
                <summary className="cursor-pointer text-muted-foreground">Inspect response (raw)</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px]">{inspectText}</pre>
              </details>
            )}

            <div className="mt-2 flex items-center gap-1.5">
              <Button size="sm" className="h-7 text-[11px]" onClick={propose} disabled={busy === 'propose' || !provider || !endpoint}>
                {busy === 'propose' ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />} Propose (no charge)
              </Button>
              <span className="text-[11px] text-muted-foreground">
                Quoted: {quotedPrice ?? 'not quoted — inspect first'}
              </span>
            </div>

            {proposal && (
              <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[11px]">
                <p className="font-medium text-amber-700 dark:text-amber-300">
                  <span className="font-mono">
                    {proposal.provider}#{proposal.endpoint}
                  </span>{' '}
                  · billed {proposal.quotedPrice ?? 'unquoted'} · estimate {usd(proposal.estimatedUsd)}
                </p>
                <p className="mt-1 text-muted-foreground">{proposal.estimateText}</p>
                {proposal.warnings.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                    {proposal.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
                <ul className="mt-2 flex flex-col gap-1">
                  {preflight.map((s) => (
                    <Step key={s.label} {...s} />
                  ))}
                </ul>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button size="sm" className="h-7 text-[11px]" onClick={() => setConfirmOpen(true)}>
                    Approve &amp; run
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={copyPrompt}>
                    <Copy className="size-3" /> Copy chat prompt
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* How a run is actually executed */}
          <div className="rounded-lg border border-border p-2 text-[11px] text-muted-foreground">
            <p className="font-medium text-foreground">How a paid run happens</p>
            <ol className="mt-1 list-decimal pl-4">
              <li>Approve here (and paste the approval id below).</li>
              <li>
                Ask the chat: “run <span className="font-mono">{provider || 'provider'}#{endpoint || 'endpoint'}</span> with
                approval id …
              </li>
              <li>The agent calls the billed tool; the result, cost and any error land in the chat.</li>
            </ol>
            <p className="mt-1">
              There is no button here that spends money silently: the server refuses a billed call without an approval id
              for that exact provider#endpoint.
            </p>
          </div>

          {/* Activity */}
          <div className="rounded-lg border border-border p-2">
            <p className="mb-1 flex items-center justify-between text-[11px] font-medium">
              <span>Activity</span>
              {log.length > 0 && (
                <button type="button" className="text-[10px] text-muted-foreground underline" onClick={() => setLog([])}>
                  clear
                </button>
              )}
            </p>
            {log.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">Nothing yet. Searches and inspections appear here.</p>
            ) : (
              <ul className="flex max-h-52 flex-col gap-1 overflow-auto">
                {log.map((entry) => (
                  <li key={entry.id} className="rounded border border-border px-2 py-1 text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono">{entry.label}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {entry.billed && <Badge variant="outline" className="mr-1 text-[10px]">billed</Badge>}
                        {entry.at}
                      </span>
                    </div>
                    <p className="break-words text-muted-foreground">{entry.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Approval dialog — the confirm button is worded as the purchase it is. */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve a billed Monid call?</DialogTitle>
            <DialogDescription>
              This spends your Monid balance. The approval is for this exact endpoint only.
            </DialogDescription>
          </DialogHeader>
          {proposal && (
            <div className="flex flex-col gap-2 text-sm">
              <div className="rounded border border-border p-2 font-mono text-xs">
                {proposal.provider}#{proposal.endpoint}
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <p className="text-muted-foreground">Quoted by inspect</p>
                  <p className="font-medium">{proposal.quotedPrice ?? 'not quoted'}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Local estimate</p>
                  <p className="font-medium">{usd(proposal.estimatedUsd)}</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{proposal.estimateText}</p>
              <Separator />
              <label className="text-xs font-medium" htmlFor="monid-approval-id">
                Approval id
              </label>
              <input
                id="monid-approval-id"
                className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
                placeholder="the id from the Actions panel"
                value={approvalId}
                onChange={(e) => setApprovalId(e.target.value)}
                autoComplete="off"
              />
              <p className="text-[11px] text-muted-foreground">
                The server will reject the run without it — that is the guard, not a formality.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmOpen(false);
                void copyPrompt();
              }}
            >
              Copy chat prompt instead
            </Button>
            <Button
              onClick={() => {
                if (!proposal) return;
                const input = parseInput();
                const prompt =
                  `Run the Monid endpoint ${proposal.provider}#${proposal.endpoint} once` +
                  (input ? ` with input ${JSON.stringify(input)}` : '') +
                  ` using approval id ${approvalId.trim() || '<paste approval id>'}.` +
                  ` Quoted price: ${proposal.quotedPrice ?? 'unknown'} (estimate ${usd(proposal.estimatedUsd)}).`;
                setConfirmOpen(false);
                void navigator.clipboard
                  .writeText(prompt)
                  .then(() => onToast('Run request copied — paste it into the chat to execute the approved call.'))
                  .catch(() => onToast('Could not copy the run request; copy it manually from the Activity log.'));
                addLog(
                  `approved ${proposal.provider}#${proposal.endpoint}`,
                  true,
                  true,
                  `approval id ${approvalId.trim() || '(none given)'} · quoted ${proposal.quotedPrice ?? 'unknown'}`,
                );
              }}
              disabled={!approvalId.trim()}
            >
              Approve {proposal?.quotedPrice ? proposal.quotedPrice : usd(proposal?.estimatedUsd ?? null)} call
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
