import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyToken } from '@/lib/auth';
import { emitEvent } from '@/lib/events';
import { createApprovedZai } from '@/lib/approved-zai';
import { getExternalAiStatus, primeExternalAiConfig } from '@/lib/external-ai';
export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'No token' }, { status: 401 });
    const payload = await verifyToken(token);
    if (!payload?.companyId) return NextResponse.json({ error: 'Invalid' }, { status: 401 });
    const avatars = await db.aiAgent.findMany({ where: { companyId: payload.companyId, type: 'avatar' }, orderBy: { createdAt: 'desc' } });
    return NextResponse.json({ data: avatars.map(a => ({ id: a.id, name: a.name, description: a.description, config: JSON.parse(a.config || '{}'), isEnabled: a.isEnabled })) });
  } catch { return NextResponse.json({ error: 'Failed' }, { status: 500 }); }
}
export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'No token' }, { status: 401 });
    const payload = await verifyToken(token);
    if (!payload?.companyId) return NextResponse.json({ error: 'Invalid' }, { status: 401 });
    const body = await req.json();
    const name = String(body.name || '').trim();
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
    // Avatar creation is a portrait generation. If the approved image provider
    // is unavailable there is no avatar to create, so fail loudly instead of
    // persisting a nameless portrait-less row with a random `voiceId`.
    let faceImageUrl: string | null = null;
    let imageError: string | null = null;
    try {
      const zai = await createApprovedZai();
      const result = await zai.images.generations.create({ prompt: `Professional portrait of a ${body.ethnicity || 'asian'} ${body.gender || 'female'}, ${body.age || 'young adult'}, ${body.style || 'professional'}`, size: '1024x1024' });
      if (result.data?.[0]?.base64) faceImageUrl = `data:image/png;base64,${result.data[0].base64}`;
      else imageError = 'The image provider returned no portrait for this prompt.';
    } catch (error) {
      imageError = error instanceof Error ? error.message : String(error);
    }
    if (!faceImageUrl) {
      return NextResponse.json(
        {
          error: 'avatar_portrait_unavailable',
          message: imageError ?? 'Portrait generation is not configured on this server.',
          // Which providers the payment guard currently allows — never keys.
          providers: getExternalAiStatus().providers.map((p) => ({ provider: p.provider, configured: p.configured })),
        },
        { status: 503 },
      );
    }
    const voiceId = `voice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const avatar = await db.aiAgent.create({ data: { name, type: 'avatar', description: body.description || '', config: JSON.stringify({ faceImageUrl, voiceId, ethnicity: body.ethnicity || 'asian', gender: body.gender || 'female', age: body.age || 'young adult', style: body.style || 'professional' }), isEnabled: true, companyId: payload.companyId } });
    await emitEvent({ companyId: payload.companyId, userId: payload.userId, type: 'ai.avatar_created', title: `Avatar "${name}" created`, description: '', resourceType: 'avatar', resourceId: avatar.id });
    return NextResponse.json({ data: { id: avatar.id, name, faceImageUrl, voiceId } }, { status: 201 });
  } catch { return NextResponse.json({ error: 'Failed' }, { status: 500 }); }
}
