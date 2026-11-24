import { spawnSync } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { synthesizeLocalSpeech, resolveFfmpegBinary, resolveFfprobeBinary } from '../src/lib/local-audio.ts';
import { LONG_VIDEO_CHUNK_SECONDS, planLongVideoChunks, splitLongVideoScript } from '../src/lib/long-video-plan.ts';

const root = process.cwd();
const videoDir = process.env.VIDEO_DIR?.trim()
  ? (path.isAbsolute(process.env.VIDEO_DIR) ? path.normalize(process.env.VIDEO_DIR) : path.resolve(root, process.env.VIDEO_DIR))
  : path.join(root, 'storage', 'videos');
const ffmpeg = resolveFfmpegBinary();
const ffprobe = resolveFfprobeBinary();
const fontFile = [
  path.join(root, 'public', 'fonts', 'HindSiliguri-Bold.ttf'),
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
].find((candidate) => {
  try { return requireExists(candidate); } catch { return false; }
});

function requireExists(file) {
  return spawnSync('test', ['-f', file]).status === 0;
}

function command(binary, args, timeout = 10 * 60 * 1000) {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw new Error(`${path.basename(binary)} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim().slice(-1200);
    throw new Error(`${path.basename(binary)} exited ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout ?? '').trim();
}

function probe(filePath) {
  const data = JSON.parse(command(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath]));
  const video = data.streams?.find((stream) => stream.codec_type === 'video');
  const audio = data.streams?.find((stream) => stream.codec_type === 'audio');
  return {
    durationSec: Number.parseFloat(data.format?.duration ?? '0') || 0,
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
    videoCodec: String(video?.codec_name ?? 'none'),
    audioCodec: String(audio?.codec_name ?? 'none'),
    sizeBytes: Number.parseInt(data.format?.size ?? '0', 10) || 0,
  };
}

function escapeFilterPath(filePath) {
  return filePath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function escapeConcatPath(filePath) {
  return filePath.replace(/'/g, "'\\''");
}

async function updateJob(jobFile, job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  const temp = `${jobFile}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(job), { mode: 0o600 });
  await rename(temp, jobFile);
}

async function main() {
  const jobFile = process.argv[2];
  if (!jobFile || path.dirname(path.resolve(jobFile)) !== path.resolve(videoDir) || !/^(?:video_[0-9a-f-]{36})\.job\.json$/i.test(path.basename(jobFile))) {
    throw new Error('Invalid long-video job path');
  }
  const job = JSON.parse(await readFile(jobFile, 'utf8'));
  const jobId = job.id;
  if (!/^video_[0-9a-f-]{36}$/i.test(jobId)) throw new Error('Invalid job id');
  const inputFile = path.join(videoDir, `${jobId}.input.json`);
  const input = JSON.parse(await readFile(inputFile, 'utf8'));
  const workDir = path.join(videoDir, `.${jobId}.work`);
  const lockFile = path.join(videoDir, `.${jobId}.lock`);
  let lock;
  try {
    lock = await open(lockFile, 'wx', 0o600);
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await updateJob(jobFile, job, { status: 'processing', progress: 1, stage: 'Preparing narration', error: null });

    const lines = splitLongVideoScript(input.script);
    if (!lines.length) throw new Error('Narration script is empty');
    const normalizedAudio = [];
    const timedSegments = [];
    let elapsed = 0;
    for (let index = 0; index < lines.length; index++) {
      const rawPath = path.join(workDir, `voice_raw_${index}.wav`);
      const audioPath = path.join(workDir, `voice_${index}.wav`);
      await synthesizeLocalSpeech(lines[index], rawPath, input.voice);
      command(ffmpeg, ['-y', '-i', rawPath, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', audioPath], 120_000);
      const audioInfo = probe(audioPath);
      if (!(audioInfo.durationSec > 0)) throw new Error(`Could not measure narration segment ${index + 1}`);
      timedSegments.push({ text: lines[index], startSec: elapsed, endSec: elapsed + audioInfo.durationSec });
      elapsed += audioInfo.durationSec;
      normalizedAudio.push(audioPath);
      if (index % 10 === 0 || index === lines.length - 1) {
        const progress = Math.min(35, 5 + Math.round(((index + 1) / lines.length) * 30));
        await updateJob(jobFile, job, { progress, stage: `Creating narration (${index + 1}/${lines.length})`, estimatedAudioSec: Math.round(elapsed) });
      }
      if (elapsed > input.durationSec + 30) break;
    }

    const contentAudio = path.join(workDir, 'narration.wav');
    const concatAudioList = path.join(workDir, 'audio-concat.txt');
    await writeFile(concatAudioList, normalizedAudio.map((file) => `file '${escapeConcatPath(file)}'`).join('\n') + '\n');
    command(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', concatAudioList, '-c:a', 'pcm_s16le', contentAudio], 10 * 60 * 1000);
    const fullAudioInfo = probe(contentAudio);
    const actualAudioSec = fullAudioInfo.durationSec;
    const minimumAccepted = input.durationSec * 0.95;
    if (actualAudioSec < minimumAccepted) {
      throw new Error(`Narration is only ${Math.floor(actualAudioSec / 60)}m ${Math.round(actualAudioSec % 60)}s; the requested video needs at least ${Math.floor(minimumAccepted / 60)}m ${Math.round(minimumAccepted % 60)}s of spoken script. Add original narration; repeated filler is not inserted.`);
    }
    const finalDuration = Math.min(input.durationSec, actualAudioSec);
    const chunks = planLongVideoChunks(finalDuration, LONG_VIDEO_CHUNK_SECONDS);
    const finalSegments = timedSegments.filter((segment) => segment.startSec < finalDuration).map((segment) => ({
      ...segment,
      endSec: Math.min(segment.endSec, finalDuration),
    }));
    const palette = ['0x132238', '0x1B2942', '0x252342', '0x15343A', '0x33243C'];
    const clipFiles = [];

    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      const clipPath = path.join(workDir, `chunk_${String(index + 1).padStart(3, '0')}.mp4`);
      const chunkEnd = chunk.startSec + chunk.durationSec;
      const filters = [];
      if (fontFile) {
        const titleFile = path.join(workDir, 'title.txt');
        if (index === 0) {
          await writeFile(titleFile, `${input.topic}\nALO Learning Journey`, 'utf8');
          filters.push(`drawtext=fontfile='${escapeFilterPath(fontFile)}':textfile='${escapeFilterPath(titleFile)}':fontcolor=white:fontsize=44:x=(w-text_w)/2:y=80:box=1:boxcolor=black@0.38:boxborderw=24:enable='between(t,0,8)'`);
        }
        for (let segmentIndex = 0; segmentIndex < finalSegments.length; segmentIndex++) {
          const segment = finalSegments[segmentIndex];
          if (segment.endSec <= chunk.startSec || segment.startSec >= chunkEnd) continue;
          const captionFile = path.join(workDir, `caption_${segmentIndex}.txt`);
          await writeFile(captionFile, segment.text.replace(/\s+/gu, ' ').trim().slice(0, 420), 'utf8');
          const localStart = Math.max(0, segment.startSec - chunk.startSec).toFixed(3);
          const localEnd = Math.min(chunk.durationSec, segment.endSec - chunk.startSec).toFixed(3);
          filters.push(`drawtext=fontfile='${escapeFilterPath(fontFile)}':textfile='${escapeFilterPath(captionFile)}':fontcolor=white:fontsize=38:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=12:box=1:boxcolor=black@0.5:boxborderw=24:enable='between(t,${localStart},${localEnd})'`);
        }
      }
      const color = palette[index % palette.length];
      const vf = filters.length ? `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,${filters.join(',')}` : 'scale=1280:720';
      command(ffmpeg, [
        '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=1280x720:r=25:d=${chunk.durationSec.toFixed(3)}`,
        '-ss', chunk.startSec.toFixed(3), '-i', contentAudio, '-t', chunk.durationSec.toFixed(3),
        '-vf', vf, '-map', '0:v:0', '-map', '1:a:0', '-shortest',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', clipPath,
      ], 10 * 60 * 1000);
      const clipInfo = probe(clipPath);
      if (!clipInfo.width || clipInfo.audioCodec === 'none' || clipInfo.durationSec < chunk.durationSec * 0.98) {
        throw new Error(`Chunk ${index + 1} failed audio/video validation`);
      }
      clipFiles.push(clipPath);
      const progress = 35 + Math.round(((index + 1) / chunks.length) * 60);
      await updateJob(jobFile, job, { progress, stage: `Rendering clip ${index + 1}/${chunks.length}`, completedChunks: index + 1, totalChunks: chunks.length, estimatedAudioSec: Math.round(actualAudioSec) });
    }

    const concatVideoList = path.join(workDir, 'video-concat.txt');
    await writeFile(concatVideoList, clipFiles.map((file) => `file '${escapeConcatPath(file)}'`).join('\n') + '\n');
    const finalPath = path.join(videoDir, `${jobId}.mp4`);
    command(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', concatVideoList, '-c', 'copy', '-movflags', '+faststart', finalPath], 15 * 60 * 1000);

    const finalInfo = probe(finalPath);
    if (!finalInfo.width || finalInfo.audioCodec === 'none' || finalInfo.durationSec < minimumAccepted || finalInfo.durationSec > input.durationSec + 2) {
      throw new Error(`Final MP4 failed validation (duration ${Math.round(finalInfo.durationSec)}s, requested ${input.durationSec}s)`);
    }
    await updateJob(jobFile, job, {
      status: 'completed', progress: 100, stage: 'Complete',
      result: {
        videoUrl: `/api/media/video/${jobId}`,
        durationSec: Math.round(finalInfo.durationSec),
        width: finalInfo.width,
        height: finalInfo.height,
        sizeBytes: finalInfo.sizeBytes,
        chunkCount: clipFiles.length,
        title: input.topic,
      },
      error: null,
    });
    await rm(workDir, { recursive: true, force: true });
    await rm(inputFile, { force: true });
  } catch (error) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    await rm(path.join(videoDir, `${job.id}.mp4`), { force: true }).catch(() => {});
    await updateJob(jobFile, job, { status: 'failed', progress: 0, stage: 'Failed', error: String(error?.message ?? 'Long video rendering failed').slice(0, 1200) }).catch(() => {});
    await rm(inputFile, { force: true }).catch(() => {});
  } finally {
    await lock?.close().catch(() => {});
    await rm(lockFile, { force: true }).catch(() => {});
  }
}

main().catch(async (error) => {
  const jobFile = process.argv[2];
  if (jobFile) {
    try {
      const job = JSON.parse(await readFile(jobFile, 'utf8'));
      job.status = 'failed';
      job.stage = 'Failed';
      job.progress = 0;
      job.error = String(error?.message ?? 'Worker failed').slice(0, 1200);
      job.updatedAt = new Date().toISOString();
      await writeFile(jobFile, JSON.stringify(job), { mode: 0o600 });
    } catch {}
  }
  process.exitCode = 1;
});
