import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const film = readFileSync(new URL('../src/views/FilmCreate.vue', import.meta.url), 'utf8')
function pageFunction(name, nextName, args = [], values = []) {
  const code = film.slice(film.indexOf(`function ${name}(`), film.indexOf(`function ${nextName}(`))
  return new Function(...args, `return ${code}`)(...values)
}
const resourceContext = pageFunction('resourceImageContext', 'storyboardImageContext', ['parseExtraImages'], [item => JSON.parse(item.extra_images || '[]')])
const storyboardContext = pageFunction('storyboardImageContext', 'closeImagePreview')

test('classic resource contexts use selected extra index and original reference slot, not main-image substitutes', () => {
  const item = { id: 8, name: '角色', local_path: 'main.png', image_url: 'https://example.test/main.png', extra_images: '["a.png","b.png"]' }
  for (const type of ['character', 'scene', 'prop']) {
    assert.deepEqual(resourceContext(type, item).source, { local_path: 'main.png' })
    const extra = resourceContext(type, item, 'extra', 1)
    assert.deepEqual(extra.source, { local_path: 'b.png' })
    assert.deepEqual(extra.target, { type, id: 8, slot: 'extra', index: 1 })
    assert.equal(extra.expected_ref, 'b.png')
    const placeholder = resourceContext(type, item, 'ref')
    assert.deepEqual(placeholder.source, { local_path: 'main.png' })
    assert.equal(placeholder.target.slot, 'ref')
    assert.equal(placeholder.expected_ref, '') // canonical ref slot is empty even though displayed source is main
    assert.equal(resourceContext(type, { ...item, ref_image: 'ref.png' }, 'ref').expected_ref, 'ref.png')
  }
  for (const type of ['character_library', 'scene_library', 'prop_library']) {
    const context = resourceContext(type, { id: 17, image_url: 'https://example.test/library.png' })
    assert.deepEqual(context.target, { type, id: 17, slot: 'main' })
    assert.deepEqual(context.source, { url: 'https://example.test/library.png' })
  }
})

test('storyboard contexts preserve history record identity, explicit frame slot and composed-field source', () => {
  const sb = { id: 12, first_frame_image_id: 5 }
  const selected = { id: 91, local_path: 'panel.png', image_url: '/static/panel.png' }
  const history = storyboardContext(sb, selected, 'history')
  assert.deepEqual(history.target, { type: 'storyboard', id: 12, slot: 'history' })
  assert.equal(history.source.image_id, 91)
  assert.equal(history.source.local_path, 'panel.png')
  assert.equal(sb.first_frame_image_id, 5) // opening must not trigger the strip's select/bind action
  assert.equal(history.expected_ref, 'panel.png')
  for (const slot of ['main', 'first', 'last']) {
    const context = storyboardContext(sb, { ...selected, source_slot: slot }, slot)
    assert.equal(context.target.slot, slot)
    assert.equal(context.expected_ref, '') // A displayed legacy candidate is not the current empty slot.
    const fields = { ...sb, local_path: 'main.png', last_frame_local_path: 'last.png' }
    assert.equal(storyboardContext(fields, selected, slot).expected_ref, slot === 'last' ? 'last.png' : 'main.png')
  }
  const composed = storyboardContext(sb, { local_path: 'composed.png', source_slot: 'composed' }, 'main')
  assert.equal(composed.target.slot, 'composed')
  assert.equal(composed.source.local_path, 'composed.png')
  assert.equal(composed.expected_ref, '') // never use legacy fallback source as an empty target's expected value
  assert.equal(storyboardContext({ ...sb, composed_image: 'composed.png' }, { local_path: 'composed.png', source_slot: 'composed' }, 'main').expected_ref, 'composed.png')
})

test('every classic image preview call carries explicit context; extra/history previews stop selection bubbling', () => {
  const previews = film.split('\n').filter(line => line.includes('@click') && line.includes('openImagePreview('))
  assert.equal(previews.length, 22)
  for (const line of previews) assert.match(line, /(?:resource|storyboard)ImageContext\(/)
  for (const line of previews.filter(line => line.includes("'history'") || line.includes("'extra'"))) assert.match(line, /@click\.stop/)
  for (const view of ['FilmList', 'DramaDetail']) {
    const text = readFileSync(new URL(`../src/views/${view}.vue`, import.meta.url), 'utf8')
    for (const line of text.split('\n').filter(line => line.includes('@click') && /open(?:ImagePreview|Preview)\(/.test(line))) {
      assert.doesNotMatch(line, /open(?:ImagePreview|Preview)\(assetImageUrl/)
    }
    assert.match(text, />AI 编辑<\/el-button>/)
  }
})
