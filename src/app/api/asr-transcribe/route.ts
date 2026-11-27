import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import fs from 'fs';
import path from 'path';
import { getAsrProviderStatus, transcribe } from "@/lib/asr-engine";

/**
 * ALO ASR (Speech-to-Text) Studio
 * Transcribes uploaded audio files (wav/mp3/m4a/flac/ogg) to text.
 *
 * Provider order comes from `src/lib/asr-engine.ts`: a local faster-whisper /
 * WhisperX / whisper.cpp daemon first, then the free Z.AI cloud ASR, then a
 * local whisper CLI. This route used to call Z.AI directly, which (a) bypassed
 * the local-first policy and (b) turned "no daemon and no key" into a raw
 * provider parse error such as "No number after minus sign in JSON" being
 * returned to the browser as a 500.
 */

/**
 * Is this error the database, or the speech engine?
 *
 * They are different operator actions — "restart MySQL / check DATABASE_URL" vs
 * "start the ASR daemon" — but both used to surface as a bare 500 `asr_failed`
 * with a question mark in the message. On the server that hides a database
 * outage behind a speech feature.
 */
function isDatabaseFailure(message: string): boolean {
  return /prisma|did not initialize|database|ECONNREFUSED|ETIMEDOUT|P1001|P1002|P1017|Can't reach database/i.test(message);
}

const SUPPORTED_FORMATS = ['wav', 'mp3', 'm4a', 'flac', 'ogg'];
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

// GET — list recent transcriptions
export async function GET() {
  try {
    const recent = await db.audioTranscription.findMany({
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    const stats = {
      total: recent.length,
      completed: recent.filter((r) => r.status === 'completed').length,
      failed: recent.filter((r) => r.status === 'failed').length,
      pending: recent.filter((r) => r.status === 'pending').length,
      totalWords: recent.reduce((s, r) => s + r.wordCount, 0),
      totalDuration: recent.reduce((s, r) => s + (r.durationSec || 0), 0),
      totalSize: recent.reduce((s, r) => s + r.fileSize, 0),
    };
    return NextResponse.json({
      recent,
      stats,
      supportedFormats: SUPPORTED_FORMATS,
      maxFileSize: MAX_FILE_SIZE,
    });
  } catch (e) {
    // Reading the history is a database read only — report that dependency.
    return NextResponse.json(
      {
        error: "transcription_list_failed",
        message: "The transcription history could not be read: the database is unreachable.",
        detail: e instanceof Error ? e.message.slice(0, 200) : undefined,
      },
      { status: 503 },
    );
  }
}

// POST — transcribe audio
// Body: { audioBase64: string, fileName: string, fileSize: number, format: string, language?: string }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      audioBase64,
      fileName = 'upload.wav',
      fileSize = 0,
      format = 'wav',
      language = 'auto',
    } = body as {
      audioBase64: string;
      fileName?: string;
      fileSize?: number;
      format?: string;
      language?: string;
    };

    if (!audioBase64) {
      return NextResponse.json(
        { ok: false, error: 'audioBase64 is required' },
        { status: 400 }
      );
    }
    const lowerFormat = (format || '').toLowerCase();
    if (!SUPPORTED_FORMATS.includes(lowerFormat)) {
      return NextResponse.json(
        { ok: false, error: `Unsupported format. Supported: ${SUPPORTED_FORMATS.join(', ')}` },
        { status: 400 }
      );
    }
    // base64 string length ~ 1.37x actual file size
    const approxSize = Math.floor((audioBase64.length * 3) / 4);
    if (approxSize > MAX_FILE_SIZE) {
      return NextResponse.json(
        { ok: false, error: `File too large. Max ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)} MB` },
        { status: 413 }
      );
    }

    // create pending record
    let record: { id: string };
    try {
      record = await db.audioTranscription.create({
        data: {
          fileName,
          fileSize: fileSize || approxSize,
          format: lowerFormat,
          language,
          status: 'pending',
        },
      });
    } catch (dbError) {
      // No row means no job: say so plainly instead of failing as `asr_failed`.
      return NextResponse.json(
        {
          ok: false,
          error: 'database_unavailable',
          message: 'Could not record the transcription job: the database is unreachable. Check DATABASE_URL and that MySQL is running.',
          providers: getAsrProviderStatus(),
          detail: dbError instanceof Error ? dbError.message.slice(0, 200) : undefined,
        },
        { status: 503 },
      );
    }

    try {
      const cleanBase64 = audioBase64.replace(/^data:audio\/\w+;base64,/, "");
      const result = await transcribe({
        audioBase64: cleanBase64,
        language: language === "auto" ? "auto" : language,
      });

      const transcription = result.text ?? "";
      const wordCount = transcription.trim() ? transcription.trim().split(/\s+/).length : 0;

      // Prefer the engine's measured duration; fall back to a wav size estimate.
      const estDurationSec = result.durationSec
        ? Math.round(result.durationSec * 10) / 10
        : lowerFormat === "wav"
          ? Math.round((approxSize / (24000 * 2)) * 10) / 10
          : null;

      // No engine available: report it honestly instead of storing an empty
      // "completed" transcription that looks like a successful silent result.
      if (result.simulated || (!transcription && result.error)) {
        const message =
          result.error ??
          "No ASR engine produced text. Configure FASTER_WHISPER_URL, WHISPERX_URL, WHISPER_CPP_URL or WHISPER_CMD on the server.";
        await db.audioTranscription.update({
          where: { id: record.id },
          data: { status: "failed", errorMessage: message },
        });
        return NextResponse.json(
          {
            ok: false,
            id: record.id,
            error: "asr_engine_unavailable",
            message,
            provider: result.provider,
            providers: getAsrProviderStatus(),
          },
          { status: 503 },
        );
      }

      // persist transcription to a text file for download
      const outputDir = path.join(process.cwd(), "public", "asr-output");
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const textPath = path.join(outputDir, `transcript_${record.id}.txt`);
      fs.writeFileSync(textPath, transcription, "utf8");

      const updated = await db.audioTranscription.update({
        where: { id: record.id },
        data: {
          status: "completed",
          transcription,
          wordCount,
          durationSec: estDurationSec,
        },
      });

      return NextResponse.json({
        ok: true,
        id: updated.id,
        fileName,
        format: lowerFormat,
        language: result.language || language,
        transcription,
        wordCount,
        durationSec: estDurationSec,
        provider: result.provider,
        modelId: result.modelId,
        segments: result.segments,
        transcriptUrl: `/asr-output/transcript_${record.id}.txt`,
      });
    } catch (engineError) {
      const detail = engineError instanceof Error ? engineError.message : String(engineError);
      // The provider message stays in the row for the operator; the response
      // says what the caller can act on.
      await db.audioTranscription
        .update({
          where: { id: record.id },
          data: { status: "failed", errorMessage: "transcription provider error" },
        })
        .catch(() => undefined);

      if (isDatabaseFailure(detail)) {
        return NextResponse.json(
          {
            ok: false,
            error: "database_unavailable",
            id: record.id,
            message: "Transcription could not be stored: the database became unreachable.",
            providers: getAsrProviderStatus(),
          },
          { status: 503 },
        );
      }
      // An engine that is absent or broken is a degraded capability (503), not an
      // internal error (500): the request was valid, the service is not ready.
      return NextResponse.json(
        {
          ok: false,
          error: "asr_failed",
          id: record.id,
          message: "The ASR engine failed to transcribe this audio. Start the local daemon (FASTER_WHISPER_URL) and retry.",
          providers: getAsrProviderStatus(),
        },
        { status: 503 },
      );
    }
  } catch (e) {
    // Never forward a provider/JSON parse message to the browser; it is noise
    // for the operator and detail for an attacker. A malformed body is a 400;
    // anything that happens after validation is a 503 (database unreachable or
    // engine crash) — reporting it as "invalid body" sent callers chasing their
    // own payload, and a 500 implied this server was broken when the real fault
    // was a dependency being down.
    const message = e instanceof Error ? e.message : String(e);
    const databaseFailure = isDatabaseFailure(message);
    const parseFailure = !databaseFailure && /JSON|Unexpected token|Unexpected end of/i.test(message);
    return NextResponse.json(
      {
        ok: false,
        error: parseFailure ? "invalid_request_body" : databaseFailure ? "database_unavailable" : "asr_failed",
        message: parseFailure
          ? "Send JSON: { audioBase64, format, fileName?, language? }."
          : databaseFailure
            ? "The transcription job could not be created: the database is unreachable. Check DATABASE_URL and that MySQL is running."
            : "Transcription failed before reaching an engine.",
        providers: getAsrProviderStatus(),
      },
      { status: parseFailure ? 400 : 503 },
    );
  }
}
