import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ref, reactive } from 'vue'
import * as storyboardMedia from '../src/utils/storyboardMedia.js'
import * as canvasLayout from '../src/utils/canvasLayout.js'
import * as mediaUrl from '../src/utils/mediaUrl.js'
const { imageRecordUrl, storyboardImageLookup, validateStoryboardImage } = storyboardMedia
import { completedImageTaskRecord } from '../src/utils/freeCreateMedia.js'

// Execute the real setup/composable functions with injected IO; no DOM or paid model calls.
async function setup(path, names, deps = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const script = (source.match(/<script setup>([\s\S]*?)<\/script>/)?.[1] || source)
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*$/gm, '').replace(/^export /gm, '')
  const bindings = {
    ref, reactive, onMounted() {}, onBeforeUnmount() {},
    imageRecordUrl, completedImageTaskRecord, storyboardImageLookup, validateStoryboardImage,
    ElMessage: { error() {}, warning() {}, success() {} },
    ...deps,
  }
  return new Function(...Object.keys(bindings), `${script}\nreturn { ${names.join(',')} }`)(...Object.values(bindings))
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function freePage(overrides = {}) {
  const busy = ref(false)
  let context
  const page = await setup('../src/views/FreeCreate.vue', [
    'processRefImageFile', 'clearRefImage', 'refImageDataUrl', 'refImageLocalPath', 'refUploading',
    'editRefImage', 'editResult', 'results', 'clearResults', 'pollImageTask', 'generate', 'prompt',
  ], { useImageEditor: () => ({ busy, open: (c) => { context = c } }), ...overrides })
  return { ...page, busy, context: () => context }
}

test('FreeCreate reference upload commits preview/path together and rejects out-of-order completions', async () => {
  const first = deferred(), second = deferred()
  let calls = 0
  const page = await freePage({ uploadAPI: { uploadImage: () => (++calls === 1 ? first.promise : second.promise) } })
  const a = page.processRefImageFile({ type: 'image/png' })
  assert.equal(page.refImageDataUrl.value, null)
  assert.equal(page.refImageLocalPath.value, null)
  const b = page.processRefImageFile({ type: 'image/png' })
  second.resolve({ local_path: 'second.png' })
  await b
  assert.equal(page.refImageDataUrl.value, '/static/second.png')
  assert.equal(page.refImageLocalPath.value, 'second.png')
  first.resolve({ local_path: 'old.png' })
  await a
  assert.equal(page.refImageLocalPath.value, 'second.png')
})

test('FreeCreate failed/cleared/unmounted uploads cannot retain invalid reference state', async () => {
  let unmount
  const pending = deferred()
  const page = await freePage({ uploadAPI: { uploadImage: () => pending.promise }, onBeforeUnmount: (fn) => { unmount = fn } })
  const upload = page.processRefImageFile({ type: 'image/png' })
  page.clearRefImage()
  pending.resolve({ local_path: 'late.png' })
  await upload
  assert.equal(page.refImageLocalPath.value, null)
  assert.equal(page.refImageDataUrl.value, null)
  const failed = await freePage({ uploadAPI: { uploadImage: async () => { throw new Error('offline') } } })
  failed.refImageLocalPath.value = 'previous.png'
  failed.refImageDataUrl.value = '/static/previous.png'
  await failed.processRefImageFile({ type: 'image/png' })
  assert.equal(failed.refImageLocalPath.value, null)
  assert.equal(failed.refImageDataUrl.value, null)
  assert.equal(failed.refUploading.value, false)
  unmount()
  await page.processRefImageFile({ type: 'image/png' })
  assert.equal(page.refImageLocalPath.value, null)
})

test('FreeCreate reference page context has stable slot and synchronous local-only adoption; busy freezes controls', async () => {
  let uploads = 0
  const page = await freePage({ uploadAPI: { uploadImage: async () => { uploads++; return { local_path: 'ref.png' } } } })
  await page.processRefImageFile({ type: 'image/png' })
  await page.editRefImage()
  const context = page.context()
  assert.equal(context.target.type, 'page')
  assert.equal(context.target.kind, 'reference')
  assert.equal(context.source.local_path, 'ref.png')
  assert.equal(context.validateTarget(), true)
  page.busy.value = true
  page.clearRefImage()
  await page.processRefImageFile({ type: 'image/png' })
  assert.equal(page.refImageLocalPath.value, 'ref.png')
  assert.equal(uploads, 1)
  assert.equal(context.onAdopted({ local_path: 'adopted.png', image_url: '/static/adopted.png' }), undefined)
  assert.equal(page.refImageLocalPath.value, 'adopted.png')
  assert.equal(page.refImageDataUrl.value, '/static/adopted.png')
  assert.equal(context.validateTarget(), false)
  assert.throws(() => context.onAdopted({ local_path: 'stale.png' }), /槽位已改变/)
})

test('FreeCreate result uses selected stable item/image IDs, not array position; callback rejects deleted target', async () => {
  const page = await freePage()
  page.results.value = [{ id: 'a', type: 'image', image_id: 101, local_path: 'a.png', url: '/static/a.png' }]
  const selected = page.results.value[0]
  await page.editResult(selected)
  const context = page.context()
  assert.equal(context.target.kind, 'free_result')
  assert.ok(context.target.id.endsWith(':a'))
  assert.equal(context.source.image_id, 101)
  page.results.value.unshift({ id: 'b', url: '/static/b.png' })
  assert.equal(context.validateTarget(), true)
  context.onAdopted({ image_id: 102, local_path: 'edited.png' })
  assert.equal(selected.image_id, 102)
  assert.equal(selected.url, '/static/edited.png')
  assert.equal(page.results.value[0].url, '/static/b.png')
  await page.editResult(selected)
  const reopened = page.context()
  page.clearResults()
  assert.equal(reopened.validateTarget(), false)
  assert.throws(() => reopened.onAdopted({ image_id: 103, local_path: 'late.png' }), /结果项已改变/)
})

test('FreeCreate poll uses taskAPI and imagesAPI.get; generated result identity is stable/reactive', async () => {
  const calls = []
  const page = await freePage({
    taskAPI: { get: async (id) => { calls.push(['task', id]); return { status: 'completed', result: '{"image_generation_id":101}' } } },
    imagesAPI: { get: async (id) => { calls.push(['image', id]); return { id, status: 'completed', local_path: 'done.png' } }, create: async () => ({ task_id: 'task-1' }) },
    setTimeout: (fn) => fn(),
  })
  page.prompt.value = 'draw a tree'
  await page.generate()
  assert.deepEqual(calls, [['task', 'task-1'], ['image', 101]])
  assert.equal(typeof page.results.value[0].id, 'string')
  assert.equal(page.results.value[0].image_id, 101)
  assert.equal(page.results.value[0].url, '/static/done.png')
  assert.equal(page.results.value[0].status, 'completed')
})

test('canvas supplemental GET validates ownership, preserves history, and exposes missing bound error', async () => {
  const pageImages = [{ id: 101, storyboard_id: 9, status: 'completed', frame_type: 'storyboard_last', local_path: 'new.png' }]
  const gets = []
  const { useCanvasStoryboardMedia } = await setup('../src/composables/useCanvasStoryboardMedia.js', ['useCanvasStoryboardMedia'], {
    imagesAPI: { list: async () => ({ items: pageImages }), get: async (id) => { gets.push(id); throw new Error('bound image missing') } },
    videosAPI: { list: async () => { throw new Error('unrelated video failure') } },
  })
  const media = useCanvasStoryboardMedia()
  await media.loadForStoryboards([{ id: 9, first_frame_image_id: 1, last_frame_image_id: 101 }])
  assert.ok(gets.includes(1))
  assert.deepEqual(media.imagesBySbId.value[9], pageImages)
  assert.equal(media.imageSupplements.value[9].main, undefined)
  assert.match(media.imageErrors.value[9].main, /bound image missing/)
})

test('canvas reload discards stale completion and legacy candidate remains outside history', async () => {
  const old = deferred()
  const queries = []
  const editHistory = [{ id: 101, storyboard_id: 9, status: 'completed', frame_type: 'image_edit_history', local_path: 'edit.png' }]
  const { useCanvasStoryboardMedia } = await setup('../src/composables/useCanvasStoryboardMedia.js', ['useCanvasStoryboardMedia'], {
    imagesAPI: { list: async (params) => {
      queries.push(params)
      if (params.storyboard_id === 8) return old.promise
      if (params.page_size === 100) return { items: editHistory }
      return { items: [{ id: 1, storyboard_id: 9, status: 'completed', frame_type: params.frame_type || 'storyboard_first', local_path: 'legacy.png' }] }
    } },
    videosAPI: { list: async () => ({ items: [] }) },
  })
  const media = useCanvasStoryboardMedia()
  const earlier = media.loadForStoryboards([{ id: 8, local_path: '8.png', last_frame_local_path: '8last.png' }])
  await media.loadForStoryboards([{ id: 9 }])
  old.resolve({ items: [] })
  await earlier
  assert.deepEqual(media.imagesBySbId.value[9], editHistory)
  assert.equal(media.imagesBySbId.value[8], undefined)
  assert.equal(media.imageSupplements.value[9].main.id, 1)
  assert.equal(queries.filter((q) => q.page_size === 1 && q.exclude_frame_types === 'image_edit_history,quad_grid,nine_grid').length, 3)
})

test('canvas adapter retains selected first/last record and frame identity; missing bound emits unavailable node', async () => {
  const workflow = await setup('../src/utils/canvasWorkflow.js', ['getStoryboardGroupMap', 'parseWorkflowGroups'], canvasLayout)
  const { buildDramaCanvasGraph } = await setup('../src/utils/dramaCanvasAdapter.js', ['buildDramaCanvasGraph'], { ...canvasLayout, ...mediaUrl, ...storyboardMedia, ...workflow })
  const sb = { id: 9, first_frame_image_id: 1, last_frame_image_id: 2, local_path: 'first.png', last_frame_local_path: 'last.png' }
  const drama = { metadata: { storyboard_use_first_last_frame: true }, episodes: [{ id: 5, storyboards: [sb] }] }
  const graph = buildDramaCanvasGraph(drama, { imagesBySbId: { 9: [{ id: 101, status: 'completed', frame_type: 'storyboard_last', local_path: 'wrong.png' }] } })
  const first = graph.nodes.find((n) => n.id === 'sbimg-first:9')
  const last = graph.nodes.find((n) => n.id === 'sbimg-last:9')
  assert.equal(first.data.imageRecord.id, 1)
  assert.equal(first.data.frameKind, 'first')
  assert.equal(first.data.url, '/static/first.png')
  assert.equal(last.data.imageRecord.id, 2)
  assert.equal(last.data.frameKind, 'last')
  assert.equal(last.data.url, '/static/last.png')
  delete sb.last_frame_local_path
  const missing = buildDramaCanvasGraph(drama).nodes.find((n) => n.id === 'sbimg-last:9')
  assert.equal(missing.data.url, '')
  assert.match(missing.data.imageError, /不可用/)
  drama.metadata.storyboard_use_first_last_frame = false
  delete sb.first_frame_image_id
  sb.composed_image = 'composed.png'
  const composed = buildDramaCanvasGraph(drama).nodes.find((n) => n.id === 'sbimg:9')
  assert.equal(composed.data.frameKind, 'composed')
  assert.equal(composed.data.url, '/static/composed.png')
})

test('canvas video generation uses supplementary binding and never silently falls back on missing bound image', async () => {
  let submitted
  const { runVideoStep } = await setup('../src/composables/useCanvasWorkflowRunner.js', ['runVideoStep'], {
    ...storyboardMedia, toAbsoluteMediaUrl: (value) => value,
    videosAPI: { create: async (body) => { submitted = body; return {} } },
  })
  const sb = { id: 9, first_frame_image_id: 1, video_prompt: 'animate' }
  const drama = { id: 3 }
  const opts = { imageSupplements: { 9: { main: { id: 1, storyboard_id: 9, status: 'completed', local_path: 'bound.png' } } } }
  await runVideoStep(drama, sb, opts)
  assert.equal(submitted.first_frame_url, '/static/bound.png')
  await assert.rejects(runVideoStep(drama, sb, {}), /绑定的分镜图片不可用/)
})

test('MediaLibrary registers uploaded images as actual assets and only counts successful registrations', async () => {
  const created = [], messages = []
  const { onUpload } = await setup('../src/views/MediaLibrary.vue', ['onUpload'], {
    useImageEditor: () => ({ busy: ref(false) }),
    uploadAPI: { uploadImage: async (file) => ({ local_path: file.name }) },
    request: { post: async (url, body) => { created.push({ url, body }); if (body.name === 'fail.png') throw new Error('DB failure') }, get: async () => ({ items: [] }) },
    ElMessage: { warning() {}, success: (message) => messages.push(message) },
  })
  await onUpload({ target: { value: 'input', files: [{ name: 'ok.png', type: 'image/png', size: 20 }, { name: 'fail.png', type: 'image/png' }] } })
  assert.equal(created.length, 2)
  assert.equal(created[0].url, '/assets')
  assert.equal(created[0].body.local_path, 'ok.png')
  assert.equal(created[0].body.type, 'image')
  assert.deepEqual(messages, ['1 个素材上传完成'])
})

test('MediaLibrary edits actual asset source/row, never old image_gen_id; refresh follows committed row', async () => {
  let context
  const row = { id: 5, type: 'image', url: '/static/current.png', local_path: 'current.png', image_gen_id: 1 }
  const page = await setup('../src/views/MediaLibrary.vue', ['editImage', 'mediaItems', 'previewItem'], {
    useImageEditor: () => ({ busy: ref(false), open: (value) => { context = value } }),
    request: { get: async (url) => { assert.equal(url, '/assets/5'); return { ...row, local_path: 'adopted.png' } } },
  })
  page.mediaItems.value = [row]
  page.previewItem.value = row
  await page.editImage(row)
  assert.deepEqual(context.target, { type: 'asset', id: 5, slot: 'main' })
  assert.equal(context.source.local_path, 'current.png')
  assert.equal(context.source.image_id, undefined)
  await context.onAdopted()
  assert.equal(page.previewItem.value.local_path, 'adopted.png')
  assert.equal(page.mediaItems.value[0].image_gen_id, 1)
})
