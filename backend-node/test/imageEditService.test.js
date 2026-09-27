const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { createImageEditService, TTL } = require('../src/services/imageEditService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const taskService = require('../src/services/taskService');
const { publicAddress, destinationFile } = require('../src/services/imageEditFiles');
const log = { info() {}, warn() {}, error() {} };

async function fixture(t, extra = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-image-edit-'));
  const root = path.join(folder, 'storage');
  fs.mkdirSync(root);
  const db = new Database(':memory:');
  const print = console.log;
  try { console.log = () => {}; runMigrationsAndEnsure(db); } finally { console.log = print; }
  db.prepare('INSERT INTO dramas(id,title,created_at) VALUES (1,?,?)').run('编辑测试', '2026-01-01');
  db.exec("INSERT INTO episodes(id,drama_id) VALUES(1,1); INSERT INTO storyboards(id,episode_id) VALUES(1,1)");
  db.prepare('INSERT INTO ai_service_configs(id,service_type,model,is_active) VALUES(1,?,?,1)').run('image_edit', JSON.stringify(['test-edit']));
  const original = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#123456' } }).png().toBuffer();
  const output = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#654321' } }).png().toBuffer();
  fs.writeFileSync(path.join(root, 'original.png'), original);
  db.prepare('INSERT INTO characters(id,drama_id,name,local_path,image_url) VALUES(1,1,?,?,?)').run('人物', 'original.png', '/static/original.png');
  const calls = [];
  let clock = Date.now();
  const client = extra.client || {
    capabilities: () => ({ available: true, text_edit: true, mask_edit: true }),
    edit: async (req) => { calls.push(req); return output; },
  };
  const cfg = { storage: { local_path: root } };
  const opts = { client, now: () => clock, ...extra };
  const service = createImageEditService(db, cfg, log, opts);
  t.after(async () => { db.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  const open = (target = { type: 'character', id: 1, slot: 'main' }, source = { local_path: 'original.png' }) => service.create({ target, source });
  const body = (s, id = 'request-1', more = {}) => ({ request_id: id, input_id: s.input_id, expected_revision: s.revision, config_id: 1, model: 'test-edit', prompt: '修改杯子', ...more });
  const generate = async (s, id) => { await service.generate(s.id, body(s, id)); await service.wait(s.id); return service.get(s.id); };
  return { service, db, cfg, opts, root, folder, original, output, calls, open, body, generate, advance: (ms) => { clock += ms; } };
}

test('editing isolates drafts; current request replays once, old rounds are rejected', async (t) => {
  const f = await fixture(t);
  const a = await f.open();
  const request = f.body(a);
  const submitted = await f.service.generate(a.id, request);
  await f.service.wait(a.id);
  const b = f.service.get(a.id);
  assert.equal(b.state, 'comparing');
  assert.equal(f.db.prepare('SELECT local_path FROM characters WHERE id=1').get().local_path, 'original.png');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM image_generations').get().n, 0);
  assert.equal((await f.service.generate(a.id, request)).task_id, submitted.task_id);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].mask, null);
  await assert.rejects(f.service.generate(a.id, { ...request, prompt: 'different' }), { status: 409 });
  const next = await f.service.continueEdit(a.id, { expected_revision: b.revision, result_id: b.result_id });
  assert.notEqual(next.input_id, a.input_id);
  assert.equal(next.result, null);
  await f.generate(next, 'request-2');
  await assert.rejects(f.service.generate(a.id, request), { status: 409 });
  assert.equal(f.calls.length, 2);
  assert.equal(f.db.prepare('SELECT local_path FROM characters WHERE id=1').get().local_path, 'original.png');
});

test('mask is separate, dimension checked, and cleared mask becomes no mask', async (t) => {
  const f = await fixture(t);
  const s = await f.open();
  const mask = await sharp({ create: { width: 4, height: 3, channels: 3, background: 'white' } }).png().toBuffer();
  await f.service.generate(s.id, f.body(s), mask); await f.service.wait(s.id);
  assert.ok(f.calls[0].mask);
  assert.deepEqual(f.calls[0].input, f.original);
  const b = f.service.get(s.id);
  const black = await sharp({ create: { width: 4, height: 3, channels: 3, background: 'black' } }).png().toBuffer();
  await f.service.generate(s.id, f.body(b, 'request-2'), black); await f.service.wait(s.id);
  assert.equal(f.calls[1].mask, null);
  const wrong = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(f.service.generate(s.id, f.body(f.service.get(s.id), 'request-3'), wrong), { status: 400 });
});

test('unknown editing protocol fails closed, never calls ordinary generation', async (t) => {
  const f = await fixture(t, { client: require('../src/services/imageEditClient') });
  const s = await f.open();
  assert.equal(s.capabilities.available, false);
  await assert.rejects(f.service.generate(s.id, f.body(s)), { status: 503 });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM async_tasks').get().n, 0);
});

test('source traversal, symlinks, invalid images and private remote addresses are refused', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.folder, 'outside.png'), f.original);
  await assert.rejects(f.open(undefined, { local_path: '../outside.png' }), { status: 400 });
  fs.symlinkSync(path.join(f.folder, 'outside.png'), path.join(f.root, 'escape.png'));
  await assert.rejects(f.open(undefined, { local_path: 'escape.png' }), { status: 400 });
  await assert.rejects(f.open(undefined, { url: 'data:image/png;base64,dGV4dA==' }), { status: 400 });
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.1.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2002:7f00:1::', '2001:0:1::', '2001:0db8::1']) assert.equal(publicAddress(ip), false, ip);
  fs.symlinkSync(f.folder, path.join(f.root, 'escape-dir'));
  assert.throws(() => destinationFile(f.root, 'escape-dir/edited.png'), { status: 400 });
  assert.throws(() => destinationFile(f.root, 'escape-dir/new-dir/edited.png'), { status: 400 });
  assert.equal(fs.existsSync(path.join(f.folder, 'new-dir')), false);
  assert.equal(fs.existsSync(path.join(f.folder, 'edited.png')), false);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});

test('orientation normalized once for the displayed input', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'rotated.jpg'), await sharp(f.original).jpeg().withMetadata({ orientation: 6 }).toBuffer());
  const s = await f.open(undefined, { local_path: 'rotated.jpg' });
  assert.equal(s.input.width, 3); assert.equal(s.input.height, 4);
});

test('database adopt updates only target, marks character certification stale, and retries idempotently', async (t) => {
  const f = await fixture(t);
  f.db.prepare('UPDATE characters SET seedance2_asset=? WHERE id=1').run(JSON.stringify({ status: 'active' }));
  f.db.exec("INSERT INTO characters(id,drama_id,name,local_path) VALUES(2,1,'same file','original.png')");
  const b = await f.generate(await f.open());
  const body = { phase: 'commit', result_id: b.result_id, expected_revision: b.revision };
  const adopted = await f.service.adopt(b.id, body);
  assert.equal(adopted.state, 'adopted');
  assert.deepEqual((await f.service.adopt(b.id, body)).receipt, adopted.receipt);
  assert.equal(f.db.prepare('SELECT local_path FROM characters WHERE id=2').get().local_path, 'original.png');
  assert.equal(JSON.parse(f.db.prepare('SELECT seedance2_asset FROM characters WHERE id=1').get().seedance2_asset).status, 'stale');
  assert.ok(fs.existsSync(path.join(f.root, adopted.receipt.local_path)));
  f.service.finish(b.id); f.service.finish(b.id);
  assert.ok(fs.existsSync(path.join(f.root, 'original.png')));
  assert.ok(fs.existsSync(path.join(f.root, adopted.receipt.local_path)));
});

test('target drift rejects adoption and keeps the result', async (t) => {
  const f = await fixture(t);
  const b = await f.generate(await f.open());
  f.db.exec("UPDATE characters SET local_path='someone-else.png' WHERE id=1");
  await assert.rejects(f.service.adopt(b.id, { phase: 'commit', result_id: b.result_id, expected_revision: b.revision }), { status: 409 });
  assert.ok(fs.existsSync(f.service.file(b.id, 'result')));
  assert.equal(f.db.prepare('SELECT local_path FROM characters WHERE id=1').get().local_path, 'someone-else.png');
});

test('binding and new history roll back together; successful retry binds only the tail', async (t) => {
  const f = await fixture(t);
  f.db.exec("UPDATE storyboards SET image_url='/static/original.png',local_path='original.png' WHERE id=1");
  const b = await f.generate(await f.open({ type: 'storyboard', id: 1, slot: 'last' }));
  const body = { phase: 'commit', result_id: b.result_id, expected_revision: b.revision };
  f.db.exec("CREATE TRIGGER reject_binding BEFORE UPDATE OF last_frame_image_id ON storyboards BEGIN SELECT RAISE(ABORT, 'test binding failure'); END");
  await assert.rejects(f.service.adopt(b.id, body), /test binding failure/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM image_generations').get().n, 0);
  assert.equal(f.service.get(b.id).state, 'comparing');
  f.db.exec('DROP TRIGGER reject_binding');
  const a = await f.service.adopt(b.id, body);
  const sb = f.db.prepare('SELECT * FROM storyboards WHERE id=1').get();
  assert.equal(sb.local_path, 'original.png');
  assert.equal(sb.last_frame_local_path, a.receipt.local_path);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM image_generations').get().n, 1);
});

test('a new candidate removes obsolete uncommitted adoption files, never old source files', async (t) => {
  const f = await fixture(t);
  const s = await f.generate(await f.open());
  f.db.exec("CREATE TRIGGER reject_edit BEFORE UPDATE OF local_path ON characters BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  await assert.rejects(f.service.adopt(s.id, { phase: 'commit', result_id: s.result_id, expected_revision: s.revision }));
  const oldPath = JSON.parse(f.db.prepare('SELECT data FROM image_edit_sessions WHERE id=?').get(s.id).data).adoption.path;
  assert.ok(fs.existsSync(path.join(f.root, oldPath)));
  f.db.exec('DROP TRIGGER reject_edit');
  const next = await f.generate(f.service.get(s.id), 'new-candidate');
  await f.service.adopt(next.id, { phase: 'commit', result_id: next.result_id, expected_revision: next.revision });
  assert.equal(fs.existsSync(path.join(f.root, oldPath)), false);
  assert.ok(fs.existsSync(path.join(f.root, 'original.png')));
});

test('page prepare exposes no final path/history, commit transfers ownership independently of finish', async (t) => {
  const f = await fixture(t);
  const b = await f.generate(await f.open({ type: 'page', id: 'result-1', kind: 'free_result' }));
  const p = await f.service.adopt(b.id, { phase: 'prepare', result_id: b.result_id, expected_revision: b.revision });
  assert.equal(p.state, 'prepared'); assert.equal(p.receipt, null);
  assert.equal(JSON.stringify(p).includes('edit_'), false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM image_generations').get().n, 0);
  const body = { phase: 'commit', adoption_id: p.adoption_id, result_id: p.result_id, expected_revision: p.revision };
  const a = await f.service.adopt(p.id, body);
  assert.deepEqual((await f.service.adopt(p.id, body)).receipt, a.receipt);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM image_generations').get().n, 1);
  // No finish call ever arrives. The final file must survive expiration.
  f.advance(TTL + 1); f.service.cleanup();
  assert.throws(() => f.service.get(a.id), { status: 404 });
  assert.ok(fs.existsSync(path.join(f.root, a.receipt.local_path)));
});

test('discard and expiry clean only uncommitted owned files', async (t) => {
  const f = await fixture(t);
  const b = await f.generate(await f.open({ type: 'page', id: 'ref-1', kind: 'reference' }));
  const p = await f.service.adopt(b.id, { phase: 'prepare', result_id: b.result_id, expected_revision: b.revision });
  const raw = JSON.parse(f.db.prepare('SELECT data FROM image_edit_sessions WHERE id=?').get(p.id).data);
  const filename = path.join(f.root, raw.adoption.path);
  assert.ok(fs.existsSync(filename));
  f.service.discard(p.id);
  assert.equal(fs.existsSync(filename), false);
  assert.ok(fs.existsSync(path.join(f.root, 'original.png')));
});

test('recovery unlocks prepared/adopting and does not repeat committed history', async (t) => {
  const f = await fixture(t);
  const b = await f.generate(await f.open({ type: 'page', id: 'result-1', kind: 'free_result' }));
  const p = await f.service.adopt(b.id, { phase: 'prepare', result_id: b.result_id, expected_revision: b.revision });
  f.db.prepare("UPDATE image_edit_sessions SET state='adopting' WHERE id=?").run(p.id);
  const recovered = createImageEditService(f.db, f.cfg, log, f.opts);
  recovered.recover();
  const ready = recovered.get(p.id);
  assert.equal(ready.state, 'prepared');
  const a = await recovered.adopt(p.id, { phase: 'commit', adoption_id: ready.adoption_id, result_id: ready.result_id, expected_revision: ready.revision });
  recovered.recover();
  assert.equal(recovered.get(a.id).state, 'adopted');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM image_generations').get().n, 1);
});

test('timeout and cancelled task cannot publish a late result or be regenerated by replay', async (t) => {
  let complete;
  const client = { capabilities: () => ({ available: true, text_edit: true, mask_edit: true }), edit: () => new Promise((resolve) => { complete = resolve; }) };
  const f = await fixture(t, { client, timeoutMs: 15 });
  const s = await f.open(); const request = f.body(s);
  const task = await f.service.generate(s.id, request);
  assert.throws(() => f.service.discard(s.id), { status: 409 });
  await f.service.wait(s.id);
  assert.equal(f.service.get(s.id).state, 'editing');
  assert.equal(taskService.getTask(f.db, task.task_id).status, 'failed');
  complete(f.output); await new Promise(setImmediate);
  assert.equal(f.service.get(s.id).result, null);
  assert.equal((await f.service.generate(s.id, request)).task_id, task.task_id);
});

test('entity slots, libraries and media assets keep their existing save semantics', async (t) => {
  const f = await fixture(t);
  for (const [type, table] of [['character', 'characters'], ['scene', 'scenes'], ['prop', 'props']]) {
    if (type !== 'character') f.db.exec(`INSERT INTO ${table}(id,drama_id,local_path) VALUES(1,1,'original.png')`);
    f.db.prepare(`UPDATE ${table} SET extra_images=?,ref_image='original.png' WHERE id=1`).run(JSON.stringify(['original.png', 'other.png']));
    for (const slot of ['main', 'extra', 'ref']) {
      const before = f.db.prepare(`SELECT * FROM ${table} WHERE id=1`).get();
      const s = await f.generate(await f.open({ type, id: 1, slot, ...(slot === 'extra' ? { index: 0 } : {}) }));
      const a = await f.service.adopt(s.id, { phase: 'commit', result_id: s.result_id, expected_revision: s.revision });
      const after = f.db.prepare(`SELECT * FROM ${table} WHERE id=1`).get();
      if (slot === 'main') assert.equal(after.local_path, a.receipt.local_path);
      else {
        assert.equal(after.local_path, before.local_path);
        if (slot === 'extra') assert.deepEqual(JSON.parse(after.extra_images), [a.receipt.local_path, 'other.png']);
        else assert.equal(after.ref_image, a.receipt.local_path);
      }
    }
  }
  for (const [type, table] of [['character_library', 'character_libraries'], ['scene_library', 'scene_libraries'], ['prop_library', 'prop_libraries'], ['asset', 'assets']]) {
    f.db.exec(`INSERT INTO ${table}(id,local_path${type === 'asset' ? ',type' : ''}) VALUES(1,'original.png'${type === 'asset' ? ",'image'" : ''})`);
    const s = await f.generate(await f.open({ type, id: 1, slot: 'main' }));
    const a = await f.service.adopt(s.id, { phase: 'commit', result_id: s.result_id, expected_revision: s.revision });
    assert.equal(f.db.prepare(`SELECT local_path FROM ${table} WHERE id=1`).get().local_path, a.receipt.local_path);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM image_generations').get().n, 0);
  assert.ok(fs.existsSync(path.join(f.root, 'original.png')));
});

test('array reorder, deletion and incorrect configuration cannot overwrite or submit', async (t) => {
  const f = await fixture(t);
  f.db.prepare('UPDATE characters SET extra_images=? WHERE id=1').run('["original.png","other.png"]');
  const s = await f.generate(await f.open({ type: 'character', id: 1, slot: 'extra', index: 0 }));
  f.db.prepare('UPDATE characters SET extra_images=? WHERE id=1').run('["other.png","original.png"]');
  await assert.rejects(f.service.adopt(s.id, { phase: 'commit', result_id: s.result_id, expected_revision: s.revision }), { status: 409 });
  const fresh = await f.open();
  f.db.exec("UPDATE ai_service_configs SET service_type='image' WHERE id=1");
  await assert.rejects(f.service.generate(fresh.id, f.body(fresh)), { status: 400 });
  f.db.exec("UPDATE ai_service_configs SET service_type='image_edit',is_active=0 WHERE id=1");
  await assert.rejects(f.service.generate(fresh.id, f.body(fresh)), { status: 400 });
  f.db.exec("UPDATE characters SET deleted_at='2026-01-01' WHERE id=1");
  await assert.rejects(f.service.adopt(s.id, { phase: 'commit', result_id: s.result_id, expected_revision: s.revision }), { status: 404 });
  assert.equal(f.calls.length, 1);
});

test('editing old history appends without binding and fallback exclusion happens before pagination', async (t) => {
  const f = await fixture(t);
  const images = require('../src/services/imageService');
  const source = images.registerImage(f.db, { drama_id: 1, storyboard_id: 1, image_url: '/static/original.png', local_path: 'original.png', frame_type: 'storyboard_first' });
  f.db.prepare('UPDATE storyboards SET first_frame_image_id=?,local_path=? WHERE id=1').run(source.id, 'original.png');
  const s = await f.generate(await f.open({ type: 'storyboard', id: 1, slot: 'history' }, { image_id: source.id, local_path: 'original.png' }));
  const a = await f.service.adopt(s.id, { phase: 'commit', result_id: s.result_id, expected_revision: s.revision });
  assert.equal(f.db.prepare('SELECT first_frame_image_id FROM storyboards WHERE id=1').get().first_frame_image_id, source.id);
  assert.equal(f.db.prepare('SELECT frame_type FROM image_generations WHERE id=?').get(a.receipt.image_id).frame_type, 'image_edit_history');
  for (let i = 0; i < 100; i++) images.registerImage(f.db, { drama_id: 1, storyboard_id: 1, local_path: 'original.png', frame_type: 'image_edit_history' });
  const fallback = images.list(f.db, { storyboard_id: 1, status: 'completed', exclude_frame_types: 'image_edit_history,quad_grid,nine_grid', page_size: 1 });
  assert.equal(fallback.total, 1);
  assert.equal(fallback.items[0].id, source.id);
  const { exportDrama } = require('../src/services/dramaExportService');
  const AdmZip = require('adm-zip');
  f.db.exec('UPDATE storyboards SET first_frame_image_id=NULL WHERE id=1');
  const zip = new AdmZip(exportDrama(f.db, f.cfg, log, 1).buffer);
  const exported = JSON.parse(zip.readAsText('project.json')).episodes[0].storyboards[0];
  assert.equal(exported.image_file, `media/storyboards/sb_1_gen_${source.id}.png`);
  const edited = exported.image_generations.find((i) => i.original_id === a.receipt.image_id);
  assert.equal(edited.frame_type, 'image_edit_history');
  assert.deepEqual(zip.readFile(edited.zip_file), f.output);
  assert.equal(zip.getEntries().some((entry) => entry.entryName.includes('image-edit-tmp')), false);
  f.db.prepare('UPDATE storyboards SET first_frame_image_id=? WHERE id=1').run(a.receipt.image_id);
  const bound = new AdmZip(exportDrama(f.db, f.cfg, log, 1).buffer);
  assert.equal(JSON.parse(bound.readAsText('project.json')).episodes[0].storyboards[0].image_file, edited.zip_file);
});

test('HTTP contract uploads an independent mask and exposes only committed page receipts', async (t) => {
  const f = await fixture(t);
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/image-edits', require('../src/routes/imageEdit')(f.service, log));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/image-edits`;
  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    return (await res.json()).data;
  }
  const s = await post(base, { source: { local_path: 'original.png' }, target: { type: 'page', id: 'http-ref', kind: 'reference' } });
  const input = await fetch(`http://127.0.0.1:${server.address().port}${s.input.url}`);
  assert.equal(input.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await input.arrayBuffer()), f.original);
  const form = new FormData();
  for (const [key, value] of Object.entries(f.body(s))) form.append(key, String(value));
  const mask = await sharp({ create: { width: 4, height: 3, channels: 3, background: 'white' } }).png().toBuffer();
  form.append('mask', new Blob([mask], { type: 'image/png' }), 'mask.png');
  const res = await fetch(`${base}/${s.id}/generate`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.session.state, 'generating');
  await f.service.wait(s.id);
  assert.ok(f.calls[0].mask);
  const b = (await (await fetch(`${base}/${s.id}`)).json()).data;
  const p = await post(`${base}/${s.id}/adopt`, { phase: 'prepare', result_id: b.result_id, expected_revision: b.revision });
  assert.equal(p.receipt, null);
  const a = await post(`${base}/${s.id}/adopt`, { phase: 'commit', result_id: p.result_id, expected_revision: p.revision, adoption_id: p.adoption_id });
  assert.ok(a.receipt.local_path);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM image_generations').get().n, 0);
  await post(`${base}/${s.id}/finish`, {});
  assert.ok(fs.existsSync(path.join(f.root, a.receipt.local_path)));
});

test('edit task namespace stays outside legacy recovery and cancellation rejects late output', async (t) => {
  let complete;
  const client = { capabilities: () => ({ available: true, text_edit: true }), edit: () => new Promise((resolve) => { complete = resolve; }) };
  const f = await fixture(t, { client });
  const s = await f.open();
  const task = await f.service.generate(s.id, f.body(s));
  assert.equal(taskService.getTasksByResource(f.db, '1').length, 0);
  assert.equal(taskService.getTask(f.db, task.task_id).resource_id, `image-edit:${s.id}`);
  taskService.cancelTask(f.db, log, task.task_id);
  complete(f.output); await f.service.wait(s.id);
  assert.equal(f.service.get(s.id).state, 'editing');
  assert.equal(f.service.get(s.id).result, null);
  assert.equal(taskService.getTask(f.db, task.task_id).status, 'failed');
  const orphan = taskService.createTask(f.db, log, 'image_edit', 'image-edit:old-session');
  assert.equal(taskService.failOrphanedAsyncTasksOnStartup(f.db, log), 1);
  assert.equal(taskService.getTask(f.db, orphan.id).status, 'failed');
});

test('committed receipt expires across restarts without deleting final files', async (t) => {
  const f = await fixture(t);
  const s = await f.generate(await f.open({ type: 'page', id: 'reference', kind: 'reference' }));
  const p = await f.service.adopt(s.id, { phase: 'prepare', result_id: s.result_id, expected_revision: s.revision });
  const a = await f.service.adopt(p.id, { phase: 'commit', adoption_id: p.adoption_id, result_id: p.result_id, expected_revision: p.revision });
  f.advance(TTL + 1);
  createImageEditService(f.db, f.cfg, log, f.opts).recover();
  assert.throws(() => f.service.get(a.id), { status: 404 });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM image_generations').get().n, 0);
  assert.ok(fs.existsSync(path.join(f.root, a.receipt.local_path)));
});
