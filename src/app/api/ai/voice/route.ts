import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { verifyToken } from "@/lib/auth";
import { synthesizeLocalSpeech } from "@/lib/local-audio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ai/voice — speech synthesis.
 *
 * Body: `{ text: string, voice?: string, language?: "bn" | "en" }`
 *
 * This route used to call the Z.ai cloud SDK, which (a) contradicted the
 * local-first voice policy, (b) needed a MarketingOS tenant bearer token that the
 * ALO admin console never has, and (c) returned 503 for every request when the
 * paid provider was not approved. It now uses the same local engine stack as
 * `/api/voice/generate` — Piper (`bn_BD-google-medium`) → eSpeak → built-in
 * formant synthesizer — so Bangla and English both work on a CPU-only server.
 *
 * Authentication accepts either:
 *   - a MarketingOS JWT bearer token (multi-user clients), or
 *   - the ALO administrator session cookie (the admin console).
 * The request gateway already requires one of these in production; this route
 * re-checks rather than trusting it.
 */

const AUDIO_DIR = path.join(process.cwd(), "storage", "audio");

async function authorize(req: NextRequest): Promise<boolean> {
  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (bearer && (await verifyToken(bearer))) return true;
  const { getServerSession } = await import("next-auth");
  const { authOptions } = await import("@/lib/auth");
  const session = await getServerSession(authOptions);
  return Boolean(session);
}

export async function POST(req: NextRequest) {
  if (!(await authorize(req))) {
    return NextResponse.json(
      { error: "unauthorized", message: "Sign in as the administrator, or send a valid bearer token." },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_request_body", message: "Send JSON: { text, voice?, language? }." }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "text_required" }, { status: 400 });
  if (text.length > 5000) return NextResponse.json({ error: "text_too_long", message: "Maximum 5,000 characters." }, { status: 400 });

  const language = body.language === "en" || body.language === "bn" ? body.language : undefined;
  const voice = typeof body.voice === "string" && body.voice ? body.voice.slice(0, 24) : (language ?? "bn");
  const id = `voice_${randomUUID()}`;
  const outputPath = path.join(AUDIO_DIR, `${id}.wav`);

  try {
    const speech = await synthesizeLocalSpeech(text, outputPath, voice);
    return NextResponse.json(
      {
        // Both shapes are returned: `data` for MarketingOS clients that read
        // `result.data.audioUrl`, and the flat fields the admin console uses.
        data: {
          audioUrl: `/api/media/audio/${id}`,
          duration: speech.durationSeconds,
          text,
          voice,
          engine: speech.engine,
        },
        audioUrl: `/api/media/audio/${id}`,
        engine: speech.engine,
        durationSeconds: speech.durationSeconds,
        format: "wav",
        language: language ?? voice,
        simulated: false,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // A synthesis failure is a server capability problem, never a client error.
    return NextResponse.json(
      {
        error: "speech_synthesis_failed",
        message: "No local speech engine produced audio. Check PIPER_BIN / ESPEAK_BIN on the server.",
        detail: error instanceof Error ? error.message.slice(0, 200) : undefined,
      },
      { status: 503 },
    );
  }
}
