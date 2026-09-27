import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ref, reactive, computed, watch } from 'vue'
import { ensureReferenceUploaded, referenceEditContext, createSceneAndSaveReference } from '../src/utils/filmCreateReference.js'

test('draft reference uploads once; committed edit replaces both preview and saved path without re-uploading original pixels', async () => {
  const draftRef = ref({ id: 'stable-reference-1', dataUrl: 'data:image/png;base64,aGVsbG8=', filename: 'ref.png' })
  const formRef = ref({ location: '教室', time: '白天' })
  const visible = ref(true)
  let uploads = 0
  const upload = async file => {
    uploads++
    assert.equal(await file.text(), 'hello')
    return { local_path: 'uploads/original.png', url: '/static/uploads/original.png' }
  }
  await ensureReferenceUploaded(draftRef.value, upload)
  const original = draftRef.value
  const context = referenceEditContext({ draftRef, formRef, visible, dramaId: 12 })
  assert.deepEqual(context.target, { type: 'page', id: 'stable-reference-1', kind: 'reference', drama_id: 12 })
  assert.equal(context.source.local_path, 'uploads/original.png')
  assert.equal(context.validateTarget(), true)
  assert.equal(draftRef.value, original) // constructing/preparing context does not change the input
  const result = context.onAdopted({ local_path: 'projects/edited.png', image_url: '/static/projects/edited.png' })
  assert.equal(result, undefined) // commit callback is a synchronous assignment, never upload/form submission
  assert.equal(draftRef.value.dataUrl, '/static/projects/edited.png')
  assert.equal(await ensureReferenceUploaded(draftRef.value, upload), 'projects/edited.png')
  assert.equal(uploads, 1)
})

test('reference identity rejects replaced input, changed path, reopened form and closed dialog', () => {
  const draftRef = ref({ id: 'original', local_path: 'old.png', url: '/static/old.png' })
  const formRef = ref({ id: 4 })
  const visible = ref(true)
  const original = draftRef.value
  const context = referenceEditContext({ draftRef, formRef, visible, dramaId: 1 })
  draftRef.value = { ...original } // same URL and ID are not the same page input instance
  assert.equal(context.validateTarget(), false)
  assert.throws(() => context.onAdopted({ local_path: 'new.png' }), /已变更/)
  draftRef.value = original
  draftRef.value.local_path = 'changed.png'
  assert.equal(context.validateTarget(), false)
  draftRef.value.local_path = 'old.png'
  visible.value = false
  assert.equal(context.validateTarget(), false)
  visible.value = true
  formRef.value = { id: 4 }
  assert.equal(context.validateTarget(), false)
})

test('upload failure keeps original reference pixels and no invented persistent path', async () => {
  const draft = { dataUrl: 'data:image/png;base64,aGVsbG8=' }
  await assert.rejects(ensureReferenceUploaded(draft, async () => { throw new Error('disk full') }), /disk full/)
  assert.equal(draft.local_path, undefined)
  assert.equal(draft.url, undefined)
  assert.equal(draft.dataUrl, 'data:image/png;base64,aGVsbG8=')
})

test('character creation acknowledged before a refresh failure is not submitted twice', async () => {
  const source = readFileSync(new URL('../src/composables/filmCreate/useCharacters.js', import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '').replace('export function useCharacters', 'function useCharacters')
  let creates = 0
  const messages = []
  const useCharacters = new Function('ref', 'reactive', 'computed', 'watch', 'ElMessage', 'dramaAPI', 'useGenerationTaskStore', 'useImageEditor',
    source + '\nreturn useCharacters')(
    ref, reactive, computed, watch, { success() {}, error: message => messages.push(message) },
    { saveCharacters: async () => { creates++ } }, () => ({}), () => ({ busy: ref(false) }),
  )
  const manager = useCharacters({ store: { dramaId: 1, drama: { characters: [] } }, dramaId: ref(1),
    currentEpisodeId: ref(2), loadDrama: async () => { throw new Error('refresh failed') } })
  manager.openAddCharacter()
  manager.editCharacterForm.value.name = '新角色'
  await manager.submitEditCharacter()
  await manager.submitEditCharacter()
  assert.equal(creates, 1)
  assert.equal(manager.showEditCharacter.value, true)
  assert.match(messages[1], /不能重复添加/)
})

// Exercise the actual composable with its API/notification edges substituted, not a duplicate submit algorithm.
test('new same-name/time scene binds create-returned ID; reference-save failure retains ID and retries update, never create', async () => {
  const source = readFileSync(new URL('../src/composables/filmCreate/useScenes.js', import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '').replace('export function useScenes', 'function useScenes')
  let creates = 0, updates = 0, failReference = true
  const boundIds = [], messages = []
  const sceneAPI = {
    create: async () => { creates++; return { id: 99, location: '教室', time: '白天' } },
    update: async id => { assert.equal(id, 99); updates++ },
    putRefImage: async (id, path) => {
      boundIds.push(id)
      assert.equal(path, 'projects/adopted.png')
      if (failReference) throw new Error('reference save failed')
    },
  }
  const useScenes = new Function('ref', 'reactive', 'computed', 'ElMessage', 'sceneAPI', 'useGenerationTaskStore',
    'useImageEditor', 'ensureReferenceUploaded', 'createSceneAndSaveReference', 'uploadAPI',
    source + '\nreturn useScenes')(
    ref, reactive, computed, { success: msg => messages.push(msg), error: msg => messages.push(msg) }, sceneAPI,
    () => ({}), () => ({ busy: ref(false) }), ensureReferenceUploaded, createSceneAndSaveReference,
    { uploadImage: () => { throw new Error('must not re-upload edited draft') } },
  )
  const oldScene = { id: 7, location: '教室', time: '白天', ref_image: 'old-scene.png' }
  const manager = useScenes({ store: { dramaId: 1, drama: { scenes: [oldScene] } }, dramaId: ref(1),
    currentEpisodeId: ref(2), loadDrama: async () => {} })
  manager.openAddScene()
  Object.assign(manager.editSceneForm.value, { location: '教室', time: '白天' })
  manager.addSceneRefImage.value = { id: 'draft', dataUrl: '/static/projects/adopted.png', local_path: 'projects/adopted.png' }
  await manager.submitEditScene()
  assert.equal(manager.editSceneForm.value.id, 99)
  assert.equal(manager.showEditScene.value, true)
  assert.equal(manager.addSceneRefImage.value.local_path, 'projects/adopted.png')
  assert.equal(oldScene.ref_image, 'old-scene.png')
  assert.deepEqual(messages, ['reference save failed'])
  failReference = false
  await manager.submitEditScene()
  assert.equal(creates, 1)
  assert.equal(updates, 1)
  assert.deepEqual(boundIds, [99, 99])
  assert.equal(manager.showEditScene.value, false)
})
