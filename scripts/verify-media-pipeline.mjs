#!/usr/bin/env node
// Offline host smoke check, not an authenticated upload or download test.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AVATAR_PRESETS, buildPortraitPrompt, buildSceneImagePrompt } from '../src/lib/human-avatars.ts';
import { resolveFfmpegBinary, resolveFfprobeBinary, synthesizeLocalSpeech } from '../src/lib/local-audio.ts';
import { buildSrt } from '../src/lib/photo-video.ts';

const dir = await mkdtemp(path.join(tmpdir(), 'alo-media-'));
try {
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, timeout: 30000, encoding: 'utf8' });
  assert.ok(AVATAR_PRESETS.length);
  for (const p of AVATAR_PRESETS) {
    assert.ok(p.faceDescription && p.voiceProfile);
    assert.ok(buildPortraitPrompt({ ...p, ethnicity: 'Bengali' }).includes(p.faceDescription));
    assert.ok(buildSceneImagePrompt(p, 'reading').includes(p.faceDescription));
  }
  const ff = resolveFfmpegBinary();
  const probe = resolveFfprobeBinary();
  const caption = 'আলো শিক্ষা';
  // Use static, repository-owned input, never a user photo. Short temp names
  // avoid interpolating arbitrary filesystem paths into the drawtext graph.
  await copyFile('public/kexsio-logo.png', path.join(dir, 'input.png'));
  await copyFile('public/fonts/HindSiliguri-Bold.ttf', path.join(dir, 'caption.ttf'));
  await writeFile(path.join(dir, 'caption.txt'), caption);
  const srt = path.join(dir, 'caption.srt');
  await writeFile(srt, buildSrt([{ index: 1, startSec: 0, endSec: 1, text: caption }]));
  assert.ok((await readFile(srt, 'utf8')).includes('00:00:01,000\n' + caption));
  const voice = await synthesizeLocalSpeech(caption, path.join(dir, 'voice.wav'), 'bn');
  run(ff, ['-loglevel','error','-loop','1','-i','input.png','-i','voice.wav','-t','1','-vf',
    'scale=320:240,drawtext=fontfile=caption.ttf:textfile=caption.txt:fontsize=24:fontcolor=blue',
    '-pix_fmt','yuv420p','-c:v','libx264','-threads','1','-c:a','aac','sample.mp4']);
  const { streams } = JSON.parse(run(probe, ['-v','error','-show_streams','-of','json','sample.mp4']));
  for (const codec of ['h264', 'aac']) assert.ok(streams.some(s => s.codec_name === codec), codec);
  console.log(`PASS: avatar prompts, Bengali caption filter and SRT, ${voice.engine} WAV, H.264/AAC MP4 verified by ffprobe. Not a visual or HTTP acceptance test.`);
} catch (error) {
  console.error('FAIL: media smoke check:', error.message);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
