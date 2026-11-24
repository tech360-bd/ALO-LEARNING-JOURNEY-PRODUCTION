import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LONG_VIDEO_MAX_SECONDS,
  LONG_VIDEO_CHUNK_SECONDS,
  planLongVideoChunks,
  splitLongVideoScript,
  validateLongVideoRequest,
} from '../src/lib/long-video-plan.ts';

test('60-minute jobs are planned as contiguous bounded chunks with only one shorter tail', () => {
  const chunks = planLongVideoChunks(LONG_VIDEO_MAX_SECONDS);
  assert.equal(chunks.length, 30);
  assert.equal(chunks[0].startSec, 0);
  assert.equal(chunks[0].durationSec, LONG_VIDEO_CHUNK_SECONDS);
  assert.equal(chunks.at(-1).startSec, 3480);
  assert.equal(chunks.at(-1).durationSec, 120);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.durationSec, 0), LONG_VIDEO_MAX_SECONDS);
  for (let index = 1; index < chunks.length; index++) {
    assert.equal(chunks[index].startSec, chunks[index - 1].startSec + chunks[index - 1].durationSec);
  }
});

test('script splitting preserves Bengali/English words and stays within per-utterance bounds', () => {
  const script = 'প্রথম বাক্যটি সম্পূর্ণ। This is the second sentence! ' + 'শব্দ '.repeat(180);
  const segments = splitLongVideoScript(script, 100);
  assert.ok(segments.length > 3);
  assert.ok(segments.every((segment) => segment.length <= 100));
  const normalize = (text) => text.replace(/\s+/gu, ' ').trim();
  assert.equal(normalize(segments.join(' ')), normalize(script));
});

test('long video request enforces input size, title, script, voice and a 1–60 minute range', () => {
  const valid = validateLongVideoRequest({ topic: 'Learning', script: 'নিরাপদ ও ব্যবহারিক narration '.repeat(5), durationSec: 3600, voice: 'bn+f2' });
  assert.equal(valid.topic, 'Learning');
  assert.equal(valid.durationSec, 3600);
  assert.equal(valid.voice, 'bn+f2');
  assert.throws(() => validateLongVideoRequest({ topic: '', script: 'x'.repeat(100), durationSec: 60 }), /title or topic/);
  assert.throws(() => validateLongVideoRequest({ topic: 'Topic', script: 'short', durationSec: 60 }), /at least/);
  assert.throws(() => validateLongVideoRequest({ topic: 'Topic', script: 'x'.repeat(100), durationSec: 3601 }), /between 60 and 3600/);
  assert.throws(() => validateLongVideoRequest({ topic: 'Topic', script: 'x'.repeat(180_001), durationSec: 60 }), /no more than/);
});
