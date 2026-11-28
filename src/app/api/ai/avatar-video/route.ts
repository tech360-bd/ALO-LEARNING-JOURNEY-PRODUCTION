import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyToken } from '@/lib/auth';
import { emitEvent } from '@/lib/events';
import { createApprovedZai } from '@/lib/approved-zai';
export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'No token' }, { status: 401 });
    const payload = await verifyToken(token);
    if (!payload?.companyId) return NextResponse.json({ error: 'Invalid' }, { status: 401 });
    const body = await req.json();
    if (!body.avatarId || !body.script) return NextResponse.json({ error: 'avatarId and script required' }, { status: 400 });
    const avatar = await db.aiAgent.findFirst({ where: { id: body.avatarId, companyId: payload.companyId, type: 'avatar' } });
    if (!avatar) return NextResponse.json({ error: 'Avatar not found' }, { status: 404 });
    const config = JSON.parse(avatar.config || '{}');
    let videoTaskId: string | null = null, videoStatus = 'pending';
    let videoError: string | null = null, audioError: string | null = null;
    try {
      const zai = await createApprovedZai();
      const videoBody: any = { prompt: body.script.slice(0, 500), quality: 'quality', with_audio: true, size: '1920x1080', duration: body.duration || 15 };
      if (config.faceImageUrl && !config.faceImageUrl.startsWith('data:')) videoBody.image_url = config.faceImageUrl;
      const result = await zai.video.generations.create(videoBody);
      videoTaskId = result.id; videoStatus = result.task_status || 'PROCESSING';
    } catch (error) {
      // Record why the cloud render refused (payment guard, quota, network)
      // instead of labelling everything "rate_limited".
      videoStatus = 'failed';
      videoError = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    }
    let audioUrl: string | null = null;
    try {
      const zai = await createApprovedZai();
      const tts = await zai.audio.tts.create({ input: body.script, voice: config.voiceId || 'default' });
      audioUrl = tts.url || null;
      if (!audioUrl) audioError = 'The speech provider returned no audio URL.';
    } catch (error) {
      audioError = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    }
    // No media of any kind means nothing was produced: report it instead of
    // returning a content id that points at an empty draft.
    if (!videoTaskId && !audioUrl) {
      return NextResponse.json(
        {
          error: 'avatar_render_unavailable',
          message: 'Neither the avatar video renderer nor the speech provider produced output.',
          videoStatus,
          videoError,
          audioError,
        },
        { status: 503 },
      );
    }
    const content = await db.content.create({ data: { title: `Avatar Video: ${avatar.name}`, type: 'video', status: 'draft', body: `Script: ${body.script}`, mediaUrl: audioUrl, engagement: '{}', aiGenerated: true, creatorId: payload.userId, companyId: payload.companyId } });
    await emitEvent({ companyId: payload.companyId, userId: payload.userId, type: 'ai.avatar_video_created', title: `Avatar video: ${avatar.name}`, description: body.script.slice(0, 60), resourceType: 'content', resourceId: content.id });
    return NextResponse.json({
      data: { contentId: content.id, avatarName: avatar.name, voiceId: config.voiceId, videoTaskId, videoStatus, audioUrl },
      ...(videoError ? { videoWarning: videoError } : {}),
      ...(audioError ? { audioWarning: audioError } : {}),
    }, { status: 201 });
  } catch { return NextResponse.json({ error: 'Failed' }, { status: 500 }); }
}
