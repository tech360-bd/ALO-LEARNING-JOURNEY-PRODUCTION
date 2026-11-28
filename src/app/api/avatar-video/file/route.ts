import { NextRequest, NextResponse } from 'next/server';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { db } from '@/lib/db';
import { requireOwnerOrResponse } from '@/lib/auth';
import { resolvePublicPath } from '@/lib/cleanup';
import { parseByteRange } from '@/lib/video-exec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/avatar-video/file?id=<videoId>
 * Authenticated, owner-scoped media download. Streams the MP4 file with validated HTTP Range support.
 */
export async function GET(req: NextRequest) {
  const auth = await requireOwnerOrResponse();
  if (auth.response) return auth.response;

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id || !/^[a-zA-Z0-9_-]{10,40}$/.test(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const video = await db.avatarVideo.findFirst({
      where: { id, ownerId: auth.owner.ownerId },
    });
    if (!video || !video.videoUrl) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }

    const urlPath = video.videoUrl.split('?')[0];
    const filePath = resolvePublicPath(urlPath);
    if (!filePath) {
      return NextResponse.json({ error: 'File missing on disk' }, { status: 410, headers: { 'Cache-Control': 'no-store' } });
    }

    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return NextResponse.json({ error: 'File missing on disk' }, { status: 410, headers: { 'Cache-Control': 'no-store' } });
    }
    if (!fileStat.isFile()) {
      return NextResponse.json({ error: 'File missing on disk' }, { status: 410, headers: { 'Cache-Control': 'no-store' } });
    }

    const baseHeaders: Record<string, string> = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="avatar_video_${id}.mp4"`,
    };

    const range = req.headers.get('range');
    if (range) {
      const parsedRange = parseByteRange(range, fileStat.size);
      if (!parsedRange.ok) {
        return new Response(null, {
          status: 416,
          headers: { ...baseHeaders, 'Content-Range': `bytes */${fileStat.size}` },
        });
      }
      const { start, end } = parsedRange;
      const stream = createReadStream(filePath, { start, end });
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${fileStat.size}`,
        },
      });
    }

    const stream = createReadStream(filePath);
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        ...baseHeaders,
        'Content-Length': String(fileStat.size),
      },
    });
  } catch (err) {
    console.error('[avatar-video/file] Failed to stream video:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
