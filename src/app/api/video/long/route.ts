import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { requireOwner } from "@/lib/auth";
import { getVideoStorageDir } from "@/lib/storage-paths";
import { LONG_VIDEO_MAX_SECONDS, validateLongVideoRequest } from "@/lib/long-video-plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VIDEO_DIR = getVideoStorageDir();
const JOB_ID_PATTERN = /^video_[0-9a-f-]{36}$/i;
const STALE_JOB_MS = 6 * 60 * 60 * 1000;

type LongJobState = {
  id: string;
  ownerId: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  stage: string;
  createdAt: string;
  updatedAt: string;
  completedChunks?: number;
  totalChunks?: number;
  estimatedAudioSec?: number;
  result?: { videoUrl: string; durationSec: number; width: number; height: number; sizeBytes: number; chunkCount: number; title: string };
  error?: string | null;
};

async function loadJob(jobId: string): Promise<LongJobState | null> {
  try {
    return JSON.parse(await readFile(path.join(VIDEO_DIR, `${jobId}.job.json`), "utf8")) as LongJobState;
  } catch {
    return null;
  }
}

async function failStaleJob(job: LongJobState): Promise<LongJobState> {
  const ageMs = Date.now() - Date.parse(job.updatedAt);
  if ((job.status !== "queued" && job.status !== "processing") || !Number.isFinite(ageMs) || ageMs <= STALE_JOB_MS) return job;
  const failed: LongJobState = { ...job, status: "failed", progress: 0, stage: "Worker stopped", error: "The worker did not update this job for six hours. No final video is available; start a new render.", updatedAt: new Date().toISOString() };
  await writeFile(path.join(VIDEO_DIR, `${job.id}.job.json`), JSON.stringify(failed), { mode: 0o600 }).catch(() => {});
  await Promise.all([
    rm(path.join(VIDEO_DIR, `${job.id}.input.json`), { force: true }).catch(() => {}),
    rm(path.join(VIDEO_DIR, `${job.id}.mp4`), { force: true }).catch(() => {}),
    rm(path.join(VIDEO_DIR, `.${job.id}.work`), { recursive: true, force: true }).catch(() => {}),
  ]);
  return failed;
}

function publicJob(job: LongJobState) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedChunks: job.completedChunks ?? 0,
    totalChunks: job.totalChunks ?? 0,
    estimatedAudioSec: job.estimatedAudioSec ?? null,
    result: job.status === "completed" ? job.result : undefined,
    error: job.status === "failed" ? job.error : undefined,
  };
}

export async function GET(request: Request) {
  try {
    const { ownerId } = await requireOwner();
    const url = new URL(request.url);
    const jobId = url.searchParams.get("jobId") ?? "";
    if (!JOB_ID_PATTERN.test(jobId)) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
    const storedJob = await loadJob(jobId);
    if (!storedJob || storedJob.ownerId !== ownerId) return NextResponse.json({ error: "Video job not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    const job = await failStaleJob(storedJob);
    return NextResponse.json({ job: publicJob(job) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = Number((error as { statusCode?: number }).statusCode ?? 500);
    return NextResponse.json({ error: status === 401 ? "Unauthorized" : "Video job status unavailable" }, { status: status === 401 || status === 503 ? status : 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { ownerId } = await requireOwner();
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: "Expected a JSON request body" }, { status: 400 }); }
    const input = validateLongVideoRequest((body ?? {}) as { topic: unknown; script: unknown; durationSec: unknown; voice?: unknown });
    await mkdir(VIDEO_DIR, { recursive: true, mode: 0o700 });

    // This local FFmpeg worker is intentionally single-job-per-owner to avoid
    // unbounded CPU and disk contention on the production VPS.
    const entries = await readdir(VIDEO_DIR).catch(() => []);
    for (const entry of entries.filter((name) => /^video_[0-9a-f-]{36}\.job\.json$/i.test(name))) {
      try {
        const stored = JSON.parse(await readFile(path.join(VIDEO_DIR, entry), "utf8")) as LongJobState;
        const active = await failStaleJob(stored);
        if (active.ownerId === ownerId && (active.status === "queued" || active.status === "processing")) {
          return NextResponse.json({ error: "You already have a long video job running", job: publicJob(active) }, { status: 409 });
        }
      } catch { /* Ignore an incomplete/stale manifest; the worker uses atomic writes. */ }
    }

    const id = `video_${randomUUID()}`;
    const now = new Date().toISOString();
    const job: LongJobState = { id, ownerId, status: "queued", progress: 0, stage: "Queued", createdAt: now, updatedAt: now, error: null };
    const jobPath = path.join(VIDEO_DIR, `${id}.job.json`);
    const inputPath = path.join(VIDEO_DIR, `${id}.input.json`);
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600, flag: "wx" });
    await writeFile(jobPath, JSON.stringify(job), { mode: 0o600, flag: "wx" });

    const workerPath = path.join(process.cwd(), "scripts", "long-video-worker.mjs");
    const worker = spawn(process.execPath, ["--experimental-strip-types", workerPath, jobPath], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: { ...process.env, VIDEO_DIR },
    });
    worker.once("error", async () => {
      const failed = { ...job, status: "failed" as const, stage: "Failed to start worker", error: "The local video worker could not start", updatedAt: new Date().toISOString() };
      await writeFile(jobPath, JSON.stringify(failed), { mode: 0o600 }).catch(() => {});
      await rm(inputPath, { force: true }).catch(() => {});
    });
    worker.unref();

    return NextResponse.json({ job: publicJob(job), maxDurationSec: LONG_VIDEO_MAX_SECONDS }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = Number((error as { statusCode?: number }).statusCode ?? 500);
    const message = error instanceof Error ? error.message : "Long video request failed";
    return NextResponse.json({ error: status === 401 ? "Unauthorized" : message }, { status: status === 401 || status === 503 ? status : 400 });
  }
}
