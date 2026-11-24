export const LONG_VIDEO_MAX_SECONDS = 60 * 60;
export const LONG_VIDEO_CHUNK_SECONDS = 120;
export const LONG_VIDEO_MAX_SCRIPT_CHARS = 180_000;
export const LONG_VIDEO_MIN_SCRIPT_CHARS = 80;

export interface LongVideoChunk {
  index: number;
  startSec: number;
  durationSec: number;
}

/** Split at sentence boundaries where possible, preserving all supplied words. */
export function splitLongVideoScript(input: string, maxSegmentChars = 360): string[] {
  const normalized = input.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n+/u).map((part) => part.trim()).filter(Boolean);
  const sentences = paragraphs.flatMap((paragraph) => paragraph.match(/[^.!?।॥]+[.!?।॥]*/gu) ?? [paragraph]);
  const segments: string[] = [];
  for (const sentence of sentences) {
    let remainder = sentence.trim();
    while (remainder.length > maxSegmentChars) {
      let splitAt = remainder.lastIndexOf(" ", maxSegmentChars);
      if (splitAt < Math.floor(maxSegmentChars * 0.55)) splitAt = maxSegmentChars;
      const part = remainder.slice(0, splitAt).trim();
      if (part) segments.push(part);
      remainder = remainder.slice(splitAt).trim();
    }
    if (remainder) segments.push(remainder);
  }
  return segments;
}

/** Form fixed-duration, contiguous encoding chunks; only the final chunk may be shorter. */
export function planLongVideoChunks(durationSec: number, chunkSec = LONG_VIDEO_CHUNK_SECONDS): LongVideoChunk[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > LONG_VIDEO_MAX_SECONDS) {
    throw new Error("Video duration must be between 1 second and 60 minutes");
  }
  if (!Number.isInteger(chunkSec) || chunkSec < 10 || chunkSec > LONG_VIDEO_CHUNK_SECONDS) {
    throw new Error("Chunk duration must be an integer from 10 to 120 seconds");
  }
  const chunks: LongVideoChunk[] = [];
  for (let startSec = 0, index = 0; startSec < durationSec; index++) {
    const duration = Math.min(chunkSec, durationSec - startSec);
    chunks.push({ index, startSec, durationSec: duration });
    startSec += duration;
  }
  return chunks;
}

export function validateLongVideoRequest(input: { topic: unknown; script: unknown; durationSec: unknown; voice?: unknown }) {
  const topic = typeof input.topic === "string" ? input.topic.trim().slice(0, 160) : "";
  const script = typeof input.script === "string" ? input.script.trim() : "";
  const durationSec = Number(input.durationSec);
  const voice = typeof input.voice === "string" && /^[a-zA-Z0-9_+-]{1,24}$/.test(input.voice) ? input.voice : "bn";
  if (!topic) throw new Error("A video title or topic is required");
  if (script.length < LONG_VIDEO_MIN_SCRIPT_CHARS) throw new Error(`Narration script must be at least ${LONG_VIDEO_MIN_SCRIPT_CHARS} characters`);
  if (script.length > LONG_VIDEO_MAX_SCRIPT_CHARS) throw new Error(`Narration script must be no more than ${LONG_VIDEO_MAX_SCRIPT_CHARS} characters`);
  if (!Number.isInteger(durationSec) || durationSec < 60 || durationSec > LONG_VIDEO_MAX_SECONDS) {
    throw new Error("Requested duration must be between 60 and 3600 whole seconds");
  }
  return { topic, script, durationSec, voice };
}
