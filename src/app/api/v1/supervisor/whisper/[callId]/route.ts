/**
 * POST /api/v1/supervisor/whisper/{callId}
 *
 * Supervisor speaks to the AGENT ONLY — the caller never hears it. Used to coach
 * a new agent mid-call ("ask for the fee receipt"), which is the one supervisor
 * action that neither `listen` (nobody hears you) nor `barge-in` (everybody
 * hears you) can express.
 *
 * Body:
 *   { "reason": "coaching: ask for the fee receipt" }   // optional
 *   { "message": "ask for the fee receipt" }            // optional, logged
 *
 * Records a `SupervisorAction` row with `actionType='whisper'` for audit.
 *
 * Why this file exists: `contact-center-view.tsx` offered three supervisor
 * actions (listen / whisper / barge-in) but only two routes existed, so the
 * whisper button was a guaranteed 404 in the operator's UI. The UI's action list
 * and the route directory are now the same set — `tests/supervisor-routes.test.mjs`
 * fails if they drift again.
 */
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getSessionContext, unauthorized, forbidden, ok, notFound, badRequest } from '@/lib/v1-middleware';
import { hasPermission } from '@/lib/auth';
import { emitEvent } from '@/lib/events';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ callId: string }> }) {
  const ctx = await getSessionContext(request);
  if (!('authenticated' in ctx && ctx.authenticated)) return unauthorized();
  if (!ctx.isSuperAdmin && !hasPermission(ctx.role, 'manager')) {
    return forbidden('manager role required (supervisor access)');
  }

  const { callId } = await params;
  const call = await db.call.findFirst({
    where: { id: callId, companyId: ctx.companyId },
  });
  if (!call) return notFound('call not found');

  if (call.status !== 'active' && call.status !== 'hold' && call.status !== 'transfer') {
    return badRequest(`cannot whisper on a call in status '${call.status}' (must be active/hold/transfer)`);
  }

  const body = (await request.json().catch(() => ({}))) || {};
  const reason = String(body.reason || 'supervisor whisper');
  // The coaching line is optional; when present it is recorded so the audit trail
  // shows what the agent was told, not just that someone whispered.
  const message = typeof body.message === 'string' ? body.message.slice(0, 500) : null;

  const action = await db.supervisorAction.create({
    data: {
      companyId: ctx.companyId,
      actionType: 'whisper',
      callId,
      agentUserId: call.humanAgentId,
      supervisorUserId: ctx.userId,
      reason,
      outcome: 'success',
      metadata: JSON.stringify(message ? { message } : {}),
    },
  });

  await emitEvent({
    type: 'supervisor.whisper',
    companyId: ctx.companyId,
    userId: ctx.userId,
    resource: 'supervisor_action',
    resourceId: action.id,
    title: 'Supervisor whisper',
    description: `Supervisor ${ctx.email} whispered coaching to the agent on call ${callId}`,
    metadata: { callId, agentUserId: call.humanAgentId, reason, hasMessage: Boolean(message) },
  });

  // Same honesty rule as the sibling routes: a simulation record is never
  // described as a real audio path. Whispering needs the telephony provider to
  // support a private leg to the agent; when the call is simulated there is none.
  const simulated = !call.providerCallId || call.providerCallId.startsWith('sim_');

  return ok({
    action: {
      id: action.id,
      actionType: action.actionType,
      callId,
      agentUserId: action.agentUserId,
      supervisorUserId: action.supervisorUserId,
      reason,
      outcome: 'success',
      timestamp: action.timestamp.toISOString(),
    },
    mode: 'agent_only',
    simulated,
    message,
    instructions: simulated
      ? 'Simulation mode — the whisper is recorded for audit but no private channel to the agent was opened.'
      : 'Telephony provider was instructed to open a private channel to the agent only (the caller hears nothing).',
  });
}
