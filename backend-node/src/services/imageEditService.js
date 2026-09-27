const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const sharp = require('sharp');
const taskService = require('./taskService');
const imageService = require('./imageService');
const storageLayout = require('./storageLayout');
const defaultClient = require('./imageEditClient');
const { fail, localFile, sourceBuffer, decodeImage, writeFile, destinationFile, MAX_PIXELS } = require('./imageEditFiles');

const TTL = 24 * 60 * 60 * 1000;
const TABLES = { character: 'characters', scene: 'scenes', prop: 'props', character_library: 'character_libraries', scene_library: 'scene_libraries', prop_library: 'prop_libraries', storyboard: 'storyboards', asset: 'assets' };
const libraryServices = { character_library: require('./characterLibraryService'), scene_library: require('./sceneLibraryService'), prop_library: require('./propLibraryService') };
function parseArray(value) {
  try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed : []; } catch (_) { return []; }
}
function refKey(value) {
  return String(value || '').replace(/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/static\//, '').replace(/^\/static\//, '');
}

function createImageEditService(db, cfg, log, options = {}) {
  const client = options.client || defaultClient;
  const now = options.now || Date.now;
  const timeoutMs = options.timeoutMs || 180000;
  const root = path.resolve(cfg.storage?.local_path || './data/storage');
  const tempRoot = path.join(path.dirname(root), 'image-edit-tmp');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  const active = new Set();
  const running = new Map();
  const sessionDir = (id) => path.join(tempRoot, id);
  function read(id) {
    if (typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id)) fail(404, '编辑会话不存在');
    const row = db.prepare('SELECT * FROM image_edit_sessions WHERE id = ?').get(id);
    if (!row) fail(404, '编辑会话不存在或已过期');
    return { ...JSON.parse(row.data), id: row.id, state: row.state, revision: row.revision, created_at: row.created_at, updated_at: row.updated_at };
  }
  function save(s) {
    s.updated_at = now();
    const { id, state, revision, created_at, updated_at, ...data } = s;
    db.prepare('UPDATE image_edit_sessions SET state = ?, revision = ?, data = ?, updated_at = ? WHERE id = ?')
      .run(state, revision, JSON.stringify(data), updated_at, id);
    return s;
  }
  function view(s) {
    const media = (item, role) => item ? { url: `/api/v1/image-edits/${s.id}/files/${role}?v=${item.id}`, width: item.width, height: item.height } : null;
    return {
      id: s.id, state: s.state, revision: s.revision, input_id: s.input?.id || null, result_id: s.result?.id || null,
      input: media(s.input, 'input'), result: s.receipt ? { url: s.receipt.url, width: s.result?.width, height: s.result?.height } : media(s.result, 'result'),
      task_id: s.task_id || null, adoption_id: s.adoption?.id || null, receipt: s.receipt || null,
      error: s.error || null, capabilities: client.capabilities(),
    };
  }
  function checkRevision(s, body) {
    if (body.expected_revision == null || !Number.isSafeInteger(Number(body.expected_revision)) || Number(body.expected_revision) !== s.revision) fail(409, '编辑状态已变化，请刷新当前会话', 'IMAGE_EDIT_CONFLICT');
  }
  function editable(s) {
    if (!['editing', 'comparing'].includes(s.state) || active.has(s.id)) fail(409, '当前会话正在处理或已经结束');
  }
  function targetInfo(target) {
    if (!target || typeof target !== 'object') fail(400, '缺少编辑目标');
    if (target.type === 'page') {
      if (typeof target.id !== 'string' || !target.id || target.id.length > 200 || !['reference', 'free_result'].includes(target.kind)) fail(400, '无效的页面图片目标');
      const did = target.drama_id == null ? null : Number(target.drama_id);
      if (did !== null && (!Number.isSafeInteger(did) || did <= 0)) fail(400, '无效的所属工程');
      if (did && !db.prepare('SELECT id FROM dramas WHERE id = ? AND deleted_at IS NULL').get(did)) fail(404, '所属工程不存在');
      return { snapshot: null, reference: '', dramaId: did };
    }
    const table = Object.hasOwn(TABLES, target.type) ? TABLES[target.type] : null;
    const id = Number(target.id);
    if (!table || !Number.isSafeInteger(id) || id <= 0) fail(400, '无效的图片目标');
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(id);
    if (!row) fail(404, '图片目标已删除');
    const slot = target.slot || 'main';
    const slots = target.type === 'storyboard' ? ['main', 'first', 'last', 'history', 'composed']
      : ['character', 'scene', 'prop'].includes(target.type) ? ['main', 'extra', 'ref'] : ['main'];
    if (!slots.includes(slot)) fail(400, '无效的图片槽位');
    if (target.type === 'asset' && row.type !== 'image') fail(400, '仅图片素材可以编辑');
    let dramaId = row.drama_id || null;
    if (target.type === 'storyboard') {
      const ep = db.prepare('SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(row.episode_id);
      if (!ep) fail(404, '分镜所属剧集不存在');
      dramaId = ep.drama_id;
    }
    if (dramaId && !db.prepare('SELECT id FROM dramas WHERE id = ? AND deleted_at IS NULL').get(dramaId)) fail(404, '所属工程不存在');
    let snapshot;
    if (slot === 'history') {
      if (!Number.isSafeInteger(Number(target.image_id)) || Number(target.image_id) <= 0) fail(400, '缺少历史图片 ID');
      const image = db.prepare('SELECT id, local_path, image_url FROM image_generations WHERE id = ? AND storyboard_id = ? AND deleted_at IS NULL').get(Number(target.image_id), id);
      if (!image) fail(404, '所选历史图片不存在');
      snapshot = { image_id: image.id, local_path: image.local_path || '', image_url: image.image_url || '' };
    } else if (slot === 'extra') {
      const extras = parseArray(row.extra_images);
      if (!Number.isSafeInteger(target.index) || target.index < 0 || target.index >= extras.length) fail(409, '副图位置已变化');
      snapshot = { extras, value: extras[target.index] };
    } else if (slot === 'ref' || slot === 'composed') {
      snapshot = { value: row[slot === 'ref' ? 'ref_image' : 'composed_image'] || '' };
    } else if (slot === 'last') {
      snapshot = { image_id: row.last_frame_image_id || null, local_path: row.last_frame_local_path || '', image_url: row.last_frame_image_url || '' };
    } else {
      snapshot = { local_path: row.local_path || '', image_url: (target.type === 'asset' ? row.url : row.image_url) || '' };
      if (target.type === 'storyboard') snapshot.image_id = row.first_frame_image_id || null;
    }
    return { row, snapshot, reference: snapshot.value || snapshot.local_path || snapshot.image_url || '', dramaId };
  }
  function unchanged(s) {
    const info = targetInfo(s.target);
    if (JSON.stringify(info.snapshot) !== JSON.stringify(s.snapshot)) fail(409, '来源图片已变更，请重新打开编辑；本次结果仍保留', 'IMAGE_EDIT_CONFLICT');
    return info;
  }
  function invalidate(s) { s.revision++; s.last_request = null; }
  function get(id) {
    const s = read(id);
    if (!['discarded', 'expired'].includes(s.state)) save(s);
    return view(s);
  }
  function file(id, role) {
    const s = read(id);
    if (!['input', 'result'].includes(role) || ['discarded', 'expired'].includes(s.state)) fail(404, '图片不存在');
    if (role === 'result' && s.receipt) return localFile(root, s.receipt.local_path);
    const item = s[role];
    if (!item) fail(404, '图片不存在');
    return localFile(sessionDir(id), item.file);
  }
  async function create(body) {
    cleanup();
    const target = { ...body.target };
    if (target.slot === 'history') target.image_id = body.source?.image_id;
    const info = targetInfo(target);
    if (body.expected_ref !== undefined && target.type !== 'page' && refKey(body.expected_ref) !== refKey(info.reference)) fail(409, '图片已变更，请重新打开编辑');
    const source = body.source || {};
    if (target.slot === 'history' && refKey(source.local_path || source.url) !== refKey(info.reference)) fail(409, '历史图片来源不匹配');
    const input = await decodeImage(await sourceBuffer(root, source));
    // Reading/normalizing a large source must not silently change the target snapshot.
    if (JSON.stringify(targetInfo(target).snapshot) !== JSON.stringify(info.snapshot)) fail(409, '读取期间来源图片已变更');
    const id = randomUUID();
    const inputId = randomUUID();
    const item = { id: inputId, file: inputId + '.png', width: input.width, height: input.height };
    try {
      const data = { target, snapshot: info.snapshot, input: item, result: null, task_id: null, last_request: null, adoption: null, receipt: null, error: null };
      db.prepare('INSERT INTO image_edit_sessions (id, state, revision, data, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)')
        .run(id, 'editing', JSON.stringify(data), now(), now());
      writeFile(path.join(sessionDir(id), item.file), input.buffer);
    } catch (e) {
      fs.rmSync(sessionDir(id), { recursive: true, force: true });
      db.prepare('DELETE FROM image_edit_sessions WHERE id = ?').run(id);
      throw e;
    }
    return view(read(id));
  }
  async function generate(id, body, maskBuffer) {
    let s = read(id);
    const requestId = body.request_id;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 100) fail(400, '缺少有效的请求 ID');
    const prompt = String(body.prompt || '').trim();
    if (!prompt || prompt.length > 10000) fail(400, '请填写有效的修改要求（最多10000字）');
    const digest = createHash('sha256').update(JSON.stringify([body.input_id, Number(body.config_id), body.model, prompt])).update(maskBuffer || Buffer.alloc(0)).digest('hex');
    if (s.last_request?.id === requestId && s.last_request.input_id === s.input?.id) {
      if (s.last_request.digest !== digest || s.last_request.revision !== Number(body.expected_revision)) fail(409, '相同请求 ID 不能修改输入');
      return { task_id: s.last_request.task_id, session: view(s) };
    }
    checkRevision(s, body); editable(s);
    if (body.input_id !== s.input.id) fail(409, '本轮原图已变化');
    const config = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL').get(Number(body.config_id));
    if (!config || config.service_type !== 'image_edit' || !config.is_active) fail(400, '请选择已启用的图片编辑配置');
    let models;
    try { models = JSON.parse(config.model); } catch (_) { models = String(config.model || '').split(/[,\n，]/); }
    if (!Array.isArray(models)) models = [models];
    if (!models.includes(body.model) && config.default_model !== body.model) fail(400, '所选模型不属于该编辑配置');
    const caps = client.capabilities(config, body.model);
    if (!caps.available) fail(503, caps.reason || '图片编辑协议尚未对接', 'IMAGE_EDIT_UNAVAILABLE');
    let mask = null;
    if (maskBuffer) {
      const decoded = await decodeImage(maskBuffer);
      if (decoded.width !== s.input.width || decoded.height !== s.input.height) fail(400, '遮罩尺寸必须与原图一致');
      const raw = await sharp(decoded.buffer, { limitInputPixels: MAX_PIXELS }).flatten({ background: '#000' }).greyscale().threshold(127).raw().toBuffer();
      if (raw.some((v) => v > 0)) mask = await sharp(raw, { raw: { width: decoded.width, height: decoded.height, channels: 1 } }).png().toBuffer();
    }
    if (mask && !caps.mask_edit) fail(400, '该模型不支持遮罩编辑，不能忽略选区提交');
    if (!mask && !caps.text_edit) fail(400, '该模型需要先涂抹选区');
    s = db.transaction(() => {
      const current = read(id);
      checkRevision(current, body); editable(current);
      if (current.input.id !== body.input_id) fail(409, '本轮原图已变化');
      const task = taskService.createTask(db, log, 'image_edit', `image-edit:${id}`);
      current.last_request = { id: requestId, input_id: body.input_id, revision: current.revision, digest, task_id: task.id };
      current.revision++;
      current.state = 'generating'; current.task_id = task.id; current.error = null;
      return save(current);
    })();
    const work = runGeneration(s, config, body.model, prompt, mask);
    running.set(id, work);
    work.finally(() => { if (running.get(id) === work) running.delete(id); });
    return { task_id: s.task_id, session: view(s) };
  }
  async function runGeneration(s, config, model, prompt, mask) {
    const taskId = s.task_id;
    const controller = new AbortController();
    let timer;
    try {
      taskService.updateTaskStatus(db, taskId, 'processing', 0, '正在编辑图片');
      if (mask) writeFile(path.join(sessionDir(s.id), taskId + '-mask.png'), mask);
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('图片编辑超时，请检查原任务状态后重试')); }, timeoutMs);
      });
      const response = await Promise.race([
        client.edit({ config, model, input: fs.readFileSync(file(s.id, 'input')), mask, prompt, signal: controller.signal }), deadline,
      ]);
      const decoded = await decodeImage(Buffer.isBuffer(response) ? response : response.buffer, false);
      controller.signal.throwIfAborted();
      const current = read(s.id);
      if (current.state !== 'generating' || current.task_id !== taskId || taskService.getTask(db, taskId)?.status !== 'processing') {
        if (current.state === 'generating' && current.task_id === taskId) { current.state = 'editing'; current.error = '编辑任务已结束'; save(current); }
        return;
      }
      const resultId = randomUUID();
      const result = { id: resultId, file: resultId + '.' + decoded.extension, width: decoded.width, height: decoded.height };
      writeFile(path.join(sessionDir(s.id), result.file), decoded.buffer);
      db.transaction(() => {
        current.result = result; current.state = 'comparing'; current.error = null;
        save(current);
        taskService.updateTaskResult(db, taskId, { session_id: s.id, result_id: resultId });
      })();
      prune(current);
    } catch (e) {
      const current = read(s.id);
      if (current.state === 'generating' && current.task_id === taskId) {
        current.state = 'editing'; current.error = e.status ? e.message : '图片编辑失败或超时，请检查模型服务后重试';
        db.transaction(() => { save(current); taskService.updateTaskError(db, taskId, current.error); })();
      }
      log.warn('Image edit task failed', { session_id: s.id, task_id: taskId });
    } finally { clearTimeout(timer); }
  }
  async function continueEdit(id, body) {
    if (active.has(id)) fail(409, '编辑正在处理中');
    active.add(id);
    try {
      const s = read(id); checkRevision(s, body);
      if (s.state !== 'comparing' || s.result?.id !== body.result_id) fail(409, '本轮结果已变化');
      const decoded = await decodeImage(fs.readFileSync(file(id, 'result')));
      const inputId = randomUUID();
      const input = { id: inputId, file: inputId + '.png', width: decoded.width, height: decoded.height };
      writeFile(path.join(sessionDir(id), input.file), decoded.buffer);
      s.input = input; s.result = null; s.task_id = null; s.error = null; s.state = 'editing';
      invalidate(s); save(s); prune(s);
      return view(s);
    } finally { active.delete(id); }
  }
  function applyTarget(s, final, info) {
    const target = s.target;
    const slot = target.slot || 'main';
    const patch = { image_url: final.url, local_path: final.local_path };
    if (target.type === 'page') {
      if (target.kind !== 'free_result') return null;
      return imageService.registerImage(db, { drama_id: info.dramaId, ...patch, provider: 'image_edit', frame_type: 'image_edit_history' }).id;
    }
    if (target.type === 'storyboard') {
      if (slot === 'composed') {
        const result = require('./storyboardService').updateStoryboard(db, log, target.id, { composed_image: final.url });
        if (!result) fail(409, '分镜已删除');
        return null;
      }
      const frame = slot === 'history' ? 'image_edit_history' : slot === 'last' ? 'storyboard_last' : 'storyboard_first';
      const image = imageService.registerImage(db, { drama_id: info.dramaId, storyboard_id: target.id, ...patch, frame_type: frame, provider: 'image_edit' });
      if (slot !== 'history') {
        const count = require('./storyboardFrameBinding').bindStoryboardFrameImage(db, target.id, frame, image.id, final.url, final.local_path);
        if (count !== 1) fail(409, '分镜绑定失败');
      }
      return image.id;
    }
    if (slot === 'extra') {
      const extras = [...info.snapshot.extras]; extras[target.index] = final.local_path;
      delete patch.image_url; delete patch.local_path; patch.extra_images = JSON.stringify(extras);
    } else if (slot === 'ref') {
      delete patch.image_url; delete patch.local_path; patch.ref_image = final.local_path;
    }
    let out;
    if (target.type === 'character') out = require('./characterLibraryService').putCharacterImage(db, log, target.id, patch);
    else if (target.type === 'scene') out = require('./sceneService').updateScene(db, log, target.id, patch);
    else if (target.type === 'prop') out = require('./propService').update(db, log, target.id, patch);
    else if (target.type === 'asset') out = require('./assetService').update(db, log, target.id, { url: final.url, local_path: final.local_path, width: s.result.width, height: s.result.height, file_size: final.size, mime_type: final.mime_type });
    else out = libraryServices[target.type].updateLibraryItem(db, log, target.id, patch);
    if (!out || out.ok === false) fail(409, '原图片引用保存失败');
    return null;
  }
  async function adopt(id, body) {
    if (active.has(id)) fail(409, '正在采用，请查询原会话状态');
    active.add(id);
    let s, timer;
    try {
      s = read(id);
      if (s.receipt) {
        if (s.receipt.result_id !== body.result_id || (body.adoption_id && s.receipt.adoption_id !== body.adoption_id)) fail(409, '会话已经采用另一结果');
        return view(s);
      }
      checkRevision(s, body);
      if (!['comparing', 'prepared'].includes(s.state) || s.result?.id !== body.result_id) fail(409, '没有可以采用的当前结果');
      const page = s.target.type === 'page';
      if (!['prepare', 'commit'].includes(body.phase)) fail(400, '无效的采用阶段');
      if (!page && body.phase !== 'commit') fail(400, '数据库图片应直接提交采用');
      if (page && body.phase === 'commit' && (s.state !== 'prepared' || !body.adoption_id || body.adoption_id !== s.adoption?.id)) fail(409, '请先准备并核对页面目标');
      const info = unchanged(s);
      const result = await Promise.race([
        decodeImage(fs.readFileSync(file(id, 'result')), false),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('采用准备超时，结果仍保留'), { status: 504 })), options.adoptTimeoutMs || 30000); }),
      ]);
      s.state = 'adopting'; s.last_request = null;
      if (!s.adoption || s.adoption.result_id !== s.result.id) {
        removePrepared(s);
        const subdir = storageLayout.getProjectStorageSubdir(db, info.dramaId);
        const adoptionId = randomUUID();
        s.adoption = { id: adoptionId, result_id: s.result.id, path: `${subdir}/images/edit_${adoptionId}.${result.extension}`, complete: false };
      }
      save(s);
      const output = destinationFile(root, s.adoption.path);
      if (!s.adoption.complete || !fs.existsSync(output)) {
        // Registered before writing; a crash cannot leave an unowned final candidate.
        fs.rmSync(output + '.part', { force: true });
        writeFile(output, result.buffer);
        s.adoption.complete = true;
      }
      if (page && body.phase === 'prepare') {
        s.state = 'prepared'; invalidate(s); save(s);
        return view(s);
      }
      const final = { url: '/static/' + s.adoption.path, local_path: s.adoption.path, size: result.buffer.length, mime_type: `image/${result.extension === 'jpg' ? 'jpeg' : result.extension}` };
      db.transaction(() => {
        const currentInfo = unchanged(s);
        const imageId = applyTarget(s, final, currentInfo);
        s.receipt = { adoption_id: s.adoption.id, result_id: s.result.id, url: final.url, image_url: final.url, local_path: final.local_path, ...(imageId ? { image_id: imageId } : {}) };
        s.state = 'adopted'; s.error = null; invalidate(s); save(s);
      })();
      return view(s);
    } catch (e) {
      if (s && !read(id).receipt) {
        const persisted = read(id);
        if (persisted.state === 'adopting') {
          persisted.adoption = s.adoption;
          persisted.state = persisted.target.type === 'page' && s.adoption?.complete ? 'prepared' : 'comparing';
          persisted.error = '采用未提交，结果已保留，可重试'; save(persisted);
        }
      }
      throw e;
    } finally { clearTimeout(timer); active.delete(id); }
  }
  function prune(s) {
    const dir = sessionDir(s.id);
    if (!fs.existsSync(dir)) return;
    const keep = new Set([s.input?.file, s.result?.file].filter(Boolean));
    for (const name of fs.readdirSync(dir)) {
      if (!keep.has(name)) fs.rmSync(path.join(dir, name), { force: true });
    }
  }
  function finish(id) {
    const s = read(id);
    if (!s.receipt || s.state !== 'adopted') fail(409, '采用尚未提交，不能结束');
    fs.rmSync(sessionDir(id), { recursive: true, force: true });
    save(s);
    return view(s);
  }
  function discard(id) {
    const s = read(id);
    if (s.receipt) return view(s);
    if (active.has(id) || s.state === 'generating' || s.state === 'adopting') fail(409, '正在处理中，不能关闭');
    fs.rmSync(sessionDir(id), { recursive: true, force: true });
    removePrepared(s);
    s.state = 'discarded'; invalidate(s); save(s);
    return view(s);
  }
  function removePrepared(s) {
    if (s.receipt || !s.adoption) return;
    // Only server-created paths recorded by this session, never the selected source.
    for (const relative of [s.adoption.path, s.adoption.path + '.part']) {
      const filename = path.join(root, relative);
      if (fs.existsSync(filename)) {
        localFile(root, relative);
        fs.rmSync(filename, { force: true });
      }
    }
  }
  function cleanup() {
    const rows = db.prepare('SELECT id FROM image_edit_sessions WHERE updated_at < ?').all(now() - TTL);
    for (const { id } of rows) {
      const s = read(id);
      if (active.has(id) || running.has(id) || ['generating', 'adopting'].includes(s.state)) continue;
      try {
        fs.rmSync(sessionDir(id), { recursive: true, force: true });
        removePrepared(s); // receipt irrevocably protects the delivered final file
        db.prepare('DELETE FROM image_edit_sessions WHERE id = ?').run(id);
      } catch (_) { log.warn('Image edit cleanup deferred', { session_id: id }); }
    }
  }
  function recover() {
    for (const { id } of db.prepare('SELECT id FROM image_edit_sessions').all()) {
      const s = read(id);
      if (s.receipt) {
        const missing = !fs.existsSync(path.join(root, s.receipt.local_path));
        if (s.state !== 'adopted' || (missing && !s.error)) {
          s.state = 'adopted';
          if (missing) s.error = '已采用的文件不可用，请检查存储；不会重复采用';
          save(s);
        }
      } else if (s.state === 'adopting') {
        const complete = s.adoption?.complete && fs.existsSync(path.join(root, s.adoption.path));
        if (!complete) { removePrepared(s); s.adoption = null; }
        s.state = complete && s.target.type === 'page' ? 'prepared' : 'comparing';
        s.error = '上次采用未提交，结果已保留'; save(s);
      } else if (s.state === 'generating') {
        taskService.updateTaskError(db, s.task_id, taskService.ORPHAN_ASYNC_TASK_MSG);
        s.state = 'editing'; s.error = taskService.ORPHAN_ASYNC_TASK_MSG; save(s);
      }
    }
    cleanup();
  }
  return { create, get, file, generate, continueEdit, adopt, finish, discard, recover, cleanup,
    // Explicit async completion hook for isolated tests, not a public HTTP operation.
    wait: (id) => running.get(id) || Promise.resolve() };
}
module.exports = { createImageEditService, TTL };
