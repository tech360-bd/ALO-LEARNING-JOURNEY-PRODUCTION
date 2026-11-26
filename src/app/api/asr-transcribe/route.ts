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
  } catch {
    return NextResponse.json({ error: "transcription_list_failed" }, { status: 500 });
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
    const record = await db.audioTranscription.create({
      data: {
        fileName,
        fileSize: fileSize || approxSize,
        format: lowerFormat,
        language,
        status: 'pending',
      },
    });

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
    } catch {
      // The provider message stays in the row for the operator; the response
      // says what the caller can act on.
      await db.audioTranscription.update({
        where: { id: record.id },
        data: { status: "failed", errorMessage: "transcription provider error" },
      });
      return NextResponse.json(
        { ok: false, error: "asr_failed", id: record.id, message: "Transcription failed. Check the server log for the provider error." },
        { status: 500 },
      );
    }
  } catch (e) {
    // Never forward a provider/JSON parse message to the browser; it is noise
    // for the operator and detail for an attacker.
    const message = e instanceof Error ? e.message : String(e);
    const isRequestError = /JSON|Unexpected token|body/i.test(message);
    return NextResponse.json(
      {
        ok: false,
        error: isRequestError ? "invalid_request_body" : "asr_failed",
        message: isRequestError
          ? "Send JSON: { audioBase64, format, fileName?, language? }."
          : "Transcription failed. Check the server log for the provider error.",
      },
      { status: isRequestError ? 400 : 500 },
    );
  }
}
