import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FONT_CANDIDATES = [
  path.join(process.cwd(), "public", "fonts", "HindSiliguri-Bold.ttf"),
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

/**
 * Non-blocking binary execution helper for ffmpeg / ffprobe / espeak.
 * Uses `execFile` (no shell) so arguments cannot trigger shell expansion,
 * and awaits asynchronously so the Next.js event loop stays responsive.
 */
export async function execAsync(
  bin: string,
  args: string[],
  timeoutMs = 300_000
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return (stdout || "").trim();
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string };
    const stderr = (e?.stderr || e?.message || "").slice(0, 400);
    throw new Error(`Command failed: ${bin} ${args.slice(0, 5).join(" ")}...\n${stderr}`);
  }
}

/**
 * Resolve a caption/title font file that supports Bengali + Latin glyphs.
 */
export function resolveVideoFontFile(): string {
  for (const candidate of FONT_CANDIDATES) {
    try {
      if (fsSync.existsSync(candidate)) return candidate;
    } catch {
      // keep trying
    }
  }
  return FONT_CANDIDATES[FONT_CANDIDATES.length - 1];
}

/**
 * Escape text safely for FFmpeg's `drawtext=text='...'` filtergraph option.
 * Strips control characters/newlines and escapes filtergraph metacharacters
 * so untrusted strings cannot break out of the `text` option or inject filters.
 */
export function escapeDrawtext(raw: string, maxLen = 120): string {
  const clean = String(raw || "")
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ")
    .trim()
    .slice(0, maxLen);
  return clean
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/=/g, "\\=")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}

/**
 * Validate an espeak voice identifier (prevents CLI flag injection via `-v`).
 */
export function validateVoiceId(raw: unknown, fallback = "bn"): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!/^[a-zA-Z0-9_+-]{1,24}$/.test(trimmed)) return fallback;
  if (trimmed.startsWith("-")) return fallback;
  return trimmed;
}

/**
 * Resolve a user-supplied local media path strictly inside `storage/` or `public/`.
 * Blocks path traversal (`..`), absolute paths outside allowed roots, and symlink escapes.
 */
export async function resolveSafeMediaInputPath(rawPath: unknown): Promise<string | null> {
  if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0")) return null;
  const trimmed = rawPath.trim().replace(/^\/+/, "");
  const allowedRoots = [
    path.resolve(process.cwd(), "storage"),
    path.resolve(process.cwd(), "public"),
  ];
  const candidate = path.resolve(process.cwd(), trimmed);
  const insideRoot = allowedRoots.some(
    (root) => candidate.startsWith(`${root}${path.sep}`)
  );
  if (!insideRoot) return null;
  try {
    const real = await fs.realpath(candidate);
    const realRoots = await Promise.all(
      allowedRoots.map((r) => fs.realpath(r).catch(() => r))
    );
    const realInside = realRoots.some(
      (root) => real.startsWith(`${root}${path.sep}`)
    );
    if (!realInside) return null;
    const st = await fs.stat(real);
    return st.isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Parse a single HTTP `Range: bytes=...` header against a known file size.
 * Returns `{ ok: false }` for malformed, inverted, multi-range, or out-of-bounds
 * ranges so callers can respond with HTTP 416 Range Not Satisfiable.
 */
export function parseByteRange(
  rangeHeader: string,
  totalSize: number
): { ok: true; start: number; end: number } | { ok: false } {
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) return { ok: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) return { ok: false };

  const start = match[1] ? Number(match[1]) : Math.max(0, totalSize - Number(match[2]));
  const rawEnd = match[2] && match[1] ? Number(match[2]) : totalSize - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(rawEnd) ||
    start < 0 ||
    rawEnd < start ||
    start >= totalSize
  ) {
    return { ok: false };
  }
  return { ok: true, start, end: Math.min(rawEnd, totalSize - 1) };
}

