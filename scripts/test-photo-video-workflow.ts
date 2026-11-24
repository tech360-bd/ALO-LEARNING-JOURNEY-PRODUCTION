// Isolated application-handler test. No listening server, network provider, or MySQL.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

async function main() {
  const root = process.cwd();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'alo-photo-workflow-'));
  try {
    const photo = await readFile('public/kexsio-logo.png');
    await mkdir(path.join(dir, 'public'));
    await symlink(path.join(root, 'public/fonts'), path.join(dir, 'public/fonts'));
    await symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
    process.chdir(dir);
    Object.assign(process.env, { NODE_ENV: 'test', ADMIN_EMAIL: '', DATABASE_URL: '', PIPER_BASE_URL: '',
      ALO_LOCAL_DB_FILE: path.join(dir, 'store.json'), VIDEO_DIR: path.join(dir, 'storage/videos') });
    const render = await import('../src/app/api/video/from-photo/route');
    const video = await import('../src/app/api/media/video/[id]/route');
    const subtitle = await import('../src/app/api/media/subtitle/[id]/route');
    const url = 'http://localhost/api/video/from-photo';
    const run = (form: FormData) => render.POST(new Request(url, { method: 'POST', body: form }));
    const form = new FormData();
    form.append('images', new Blob(['invalid']), 'invalid.png');
    assert.equal((await run(form)).status, 415);
    form.delete('images');
    form.append('images', new Blob([photo]), 'logo.png');
    form.append('images', new Blob(['invalid']), 'invalid.png');
    assert.equal((await run(form)).status, 415);
    assert.deepEqual(await readdir('storage/photo-video'), []);
    form.delete('images');
    form.append('images', new Blob([photo]), 'logo.png');
    form.set('quality', 'draft'); form.set('shotSec', '2');
    const caption = 'আলো শিক্ষা';
    form.set('narration', caption);
    // A file where the renderer needs an audio directory forces a real late
    // render failure after captions are staged, entirely inside the temp root.
    await writeFile('storage/audio', 'test');
    assert.equal((await run(form)).status, 500);
    assert.deepEqual(await readdir('storage/videos'), []);
    assert.deepEqual(await readdir('storage/photo-video'), []);
    await rm('storage/audio');
    const response = await run(form);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.ok(result.captionsBurned && result.sizeBytes > 0);
    const gallery = await (await render.GET(new Request(url))).json();
    assert.ok(gallery.renders.some((r: { id: string }) => r.id === result.id));
    // Fresh Node process, same disk, no in-memory state from the renderer.
    execFileSync(process.execPath, ['--import','tsx','-e', `
      process.chdir(process.env.RESTART_ROOT);
      const { GET } = require(process.env.GALLERY_ROUTE);
      GET(new Request('http://localhost/api/video/from-photo')).then(async r => {
        if (r.status !== 200 || !(await r.json()).renders.some(x=>x.id===process.env.RENDER_ID)) process.exitCode=1;
      });`], { cwd: root, env: { ...process.env, RESTART_ROOT: dir, RENDER_ID: result.id, GALLERY_ROUTE: path.join(root,'src/app/api/video/from-photo/route.ts') } });
    const context = { params: Promise.resolve({ id: result.id }) };
    const full = await video.GET(new Request(url), context);
    assert.equal(full.status, 200);
    assert.equal((await full.arrayBuffer()).byteLength, result.sizeBytes);
    assert.equal((await video.GET(new Request(url), { params: Promise.resolve({ id: '../invalid' }) })).status, 404);
    const clip = await video.GET(new Request(url, { headers: { range: 'bytes=0-15' } }), context);
    assert.equal(clip.status, 206);
    assert.match(Buffer.from(await clip.arrayBuffer()).toString('ascii'), /ftyp/);
    const srt = await subtitle.GET(new Request(url), context);
    assert.equal(srt.status, 200); assert.ok((await srt.text()).includes(caption));
    assert.deepEqual(await readdir('storage/photo-video'), []);
    console.log(`PASS: invalid/mixed and failed render cleanup; fresh-process gallery; local upload, ${result.durationSec}s ${result.width}x${result.height} render, gallery, MP4 range and Bengali SRT download.`);
  } finally {
    process.chdir(root);
    await rm(dir, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
