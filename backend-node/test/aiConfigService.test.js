const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const service = require('../src/services/aiConfigService');
const routes = require('../src/routes/aiConfig');

const log = { info() {}, error() {}, errorw() {} };
function database(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(fs.readFileSync(path.join(__dirname, '../migrations/01_init.sql'), 'utf8'));
  db.exec('ALTER TABLE ai_service_configs ADD COLUMN api_protocol TEXT');
  return db;
}
function response() {
  return { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
}

test('image_edit defaults are independent, including duplicate default repair', (t) => {
  const db = database(t);
  const defaults = ['image', 'storyboard_image', 'image_edit'].map((service_type) =>
    service.createConfig(db, log, { service_type, provider: 'custom', is_default: true }));
  const second = service.createConfig(db, log, { service_type: 'image_edit', provider: 'custom', is_default: true, priority: 5 });
  assert.equal(service.getConfig(db, defaults[2].id).is_default, false);
  db.prepare('UPDATE ai_service_configs SET is_default = 1 WHERE id = ?').run(defaults[2].id);
  assert.deepEqual(service.listConfigs(db).filter((c) => c.is_default).map((c) => c.id).sort(), [defaults[0].id, defaults[1].id, second.id]);
  service.updateConfig(db, log, defaults[2].id, { is_default: true });
  assert.equal(service.getConfig(db, second.id).is_default, false);
  for (const config of defaults) assert.equal(service.getConfig(db, config.id).is_default, true);
});

test('editing CRUD/import fields round-trip without provider endpoint inference', (t) => {
  const db = database(t);
  for (const provider of ['gemini', 'google', 'openai', 'nano_banana', 'dashscope', 'qwen_image', 'volcengine', 'agnes', 'custom']) {
    const config = service.createConfig(db, log, { service_type: 'image_edit', provider });
    assert.equal(config.endpoint, '', provider);
    assert.equal(config.query_endpoint, '', provider);
    assert.equal(config.api_protocol, '', provider);
    assert.equal(config.base_url, '', provider);
    assert.equal(config.api_key, '', provider);
  }
  const fields = {
    service_type: 'image_edit', provider: 'custom', name: 'Editing draft',
    api_protocol: 'future-protocol', endpoint: '/user-supplied', query_endpoint: '/user-query',
    model: ['my-model'], default_model: 'my-model', settings: '{"vendor_setting":"preserved"}',
  };
  const original = service.createConfig(db, log, fields);
  const { id, created_at, updated_at, ...exported } = original;
  const imported = service.createConfig(db, log, JSON.parse(JSON.stringify(exported)));
  for (const key of Object.keys(fields)) assert.deepEqual(imported[key], fields[key], key);
  service.updateConfig(db, log, imported.id, { name: 'Renamed' });
  assert.equal(service.getConfig(db, imported.id).settings, fields.settings);
  assert.throws(() => service.updateConfig(db, log, imported.id, { service_type: 'image' }), /不能修改服务类型/);
  assert.equal(service.getConfig(db, imported.id).service_type, 'image_edit');
  assert.equal(service.deleteConfig(db, log, imported.id), true);
  assert.equal(service.getConfig(db, imported.id), null);
  assert.equal(service.listConfigs(db, 'image_edit').some((c) => c.id === imported.id), false);
  // Ordinary image configurations retain their existing endpoint defaults.
  assert.equal(service.createConfig(db, log, { service_type: 'image', provider: 'gemini' }).endpoint, '/v1beta/models/{model}:generateContent');
  assert.equal(service.createConfig(db, log, { service_type: 'image', provider: 'openai' }).endpoint, '/images/generations');
});

test('editing connectivity fails closed before auth, provider or model inference, without requests', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external request'); });
  for (const provider of [undefined, 'gemini', 'google', 'nano_banana', 'openai', 'dashscope', 'volces', 'custom']) {
    for (const credentials of [{}, { base_url: 'https://example.invalid', api_key: 'secret' }]) {
      await assert.rejects(service.testConnection({
        ...credentials, service_type: 'image_edit', provider, model: ['seedream-image'],
        endpoint: '/images/generations', api_protocol: 'openai', settings: '{"mask_edit":true}',
      }), { message: /图片编辑协议尚未对接/, status: 503 });
    }
  }
  const res = response();
  await routes(null, log).testConnection({ body: { service_type: 'image_edit' } }, res);
  assert.equal(res.code, 503);
  assert.equal(res.body.success, false);
  assert.match(res.body.error.message, /图片编辑协议尚未对接/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('routes permit editing drafts, preserve legacy required fields and reject changing types', async (t) => {
  const db = database(t);
  const api = routes(db, log);
  const editing = response();
  api.create({ body: { service_type: 'image_edit', name: 'Draft', provider: 'custom' } }, editing);
  assert.equal(editing.code, 201);
  const changed = response();
  api.update({ params: { id: editing.body.data.id }, body: { service_type: 'image', name: 'Wrong' } }, changed);
  assert.equal(changed.code, 400);
  assert.equal(service.getConfig(db, editing.body.data.id).name, 'Draft');
  for (const body of [
    { service_type: 'image_edit', provider: 'custom' },
    { service_type: 'image', name: 'Legacy', provider: 'openai' },
    { service_type: 'image', name: 'Legacy', provider: 'openai', base_url: 'https://example.invalid' },
  ]) {
    const res = response();
    api.create({ body }, res);
    assert.equal(res.code, 400);
  }
  const missingAuth = response();
  await api.testConnection({ body: { service_type: 'image' } }, missingAuth);
  assert.equal(missingAuth.code, 400);
  assert.match(missingAuth.body.error.message, /base_url 或 api_key/);
  await assert.rejects(service.testConnection({ service_type: 'text' }), /base_url 必填/);
  await assert.rejects(service.testConnection({ service_type: 'text', base_url: 'https://example.invalid' }), /api_key 必填/);
  const fetch = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ choices: [] }) }));
  await service.testConnection({ service_type: 'text', provider: 'openai', base_url: 'https://example.invalid', api_key: 'secret' });
  assert.equal(fetch.mock.calls[0].arguments[0], 'https://example.invalid/chat/completions');
});
