import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveSbImageRecord, resolveSbFirstImageRecord, sbVideoFirstLastUrls, storyboardImageLookup, validateStoryboardImage,
  getSbImagesList, imageRecordUrl, IMAGE_FALLBACK_EXCLUDED_TYPES,
} from '../src/utils/storyboardMedia.js'
import { completedImageTaskRecord } from '../src/utils/freeCreateMedia.js'

const image = (id, frame_type = 'storyboard_first', extra = {}) => ({
  id, storyboard_id: 9, frame_type, status: 'completed', local_path: `images/${id}.png`, ...extra,
})

for (const slot of ['main', 'first', 'last']) {
  const idField = slot === 'last' ? 'last_frame_image_id' : 'first_frame_image_id'
  const pathField = slot === 'last' ? 'last_frame_local_path' : 'local_path'
  const type = slot === 'last' ? 'storyboard_last' : 'storyboard_first'
  test(`${slot}: 100→101 history never displaces binding; authoritative slot path survives page boundary`, () => {
    const sb = { id: 9, [idField]: 1, [pathField]: 'images/1.png' }
    const history = Array.from({ length: 100 }, (_, i) => image(100 - i, type))
    assert.equal(resolveSbImageRecord(sb, { 9: history }, slot).id, 1)
    history.unshift(image(101, type))
    history.length = 100
    const selected = resolveSbImageRecord(sb, { 9: history }, slot)
    assert.equal(selected.id, 1)
    assert.equal(selected.local_path, 'images/1.png')
    assert.equal(selected.source_slot, slot)
    assert.equal(storyboardImageLookup(sb, { 9: history }, slot), null)
  })

  test(`${slot}: bound id without slot path requires isolated GET; failed/mismatched supplement never selects latest`, () => {
    const sb = { id: 9, [idField]: '1' }
    const page = { 9: [image(101, type)] }
    assert.deepEqual(storyboardImageLookup(sb, page, slot), { id: '1' })
    assert.equal(resolveSbImageRecord(sb, page, slot), null)
    assert.equal(resolveSbImageRecord(sb, page, slot, { 9: { [slot]: image(2, type) } }), null)
    assert.equal(resolveSbImageRecord(sb, page, slot, { 9: { [slot]: image(1, type, { storyboard_id: 99 }) } }), null)
    const selected = resolveSbImageRecord(sb, page, slot, { 9: { [slot]: image(1, 'image_edit_history') } })
    assert.equal(selected.id, 1)
    assert.equal(selected.frame_type, 'image_edit_history')
    assert.equal(page[9].length, 1, 'supplements must not appear as a loaded history page')
  })

  test(`${slot}: full page of edit history requests database-filtered fallback before LIMIT`, () => {
    const sb = { id: 9 }
    const page = { 9: Array.from({ length: 100 }, (_, i) => image(i + 10, 'image_edit_history')) }
    assert.equal(getSbImagesList(page, 9).length, 100, 'edit history remains visible')
    assert.equal(resolveSbImageRecord(sb, page, slot), null)
    const lookup = storyboardImageLookup(sb, page, slot)
    assert.deepEqual(lookup.params, {
      storyboard_id: 9, status: 'completed', page_size: 1,
      exclude_frame_types: 'image_edit_history,quad_grid,nine_grid',
      ...(slot === 'main' ? {} : { frame_type: `storyboard_${slot}` }),
    })
    const selected = resolveSbImageRecord(sb, page, slot, { 9: { [slot]: image(1, type) } })
    assert.equal(selected.id, 1)
    assert.equal(page[9].length, 100)
  })
}

test('explicitly selected editing history wins; unbound history is never automatic fallback', () => {
  const page = { 9: [image(3, 'image_edit_history'), image(2)] }
  assert.equal(resolveSbImageRecord({ id: 9 }, page).id, 2)
  assert.equal(resolveSbImageRecord({ id: 9, first_frame_image_id: 3 }, page).id, 3)
  assert.equal(IMAGE_FALLBACK_EXCLUDED_TYPES, 'image_edit_history,quad_grid,nine_grid')
})

test('slot references/composed retain actual source instead of newer records; last never reads main fields', () => {
  const sb = { id: 9, composed_image: 'images/composed.png', image_url: 'https://example.test/main.png', last_frame_image_url: 'https://example.test/last.png' }
  const page = { 9: [image(3), image(4, 'storyboard_last')] }
  const composed = resolveSbImageRecord(sb, page)
  assert.equal(composed.source_slot, 'composed')
  assert.equal(imageRecordUrl(composed), '/static/images/composed.png')
  assert.equal(imageRecordUrl(resolveSbImageRecord(sb, page, 'first')), sb.image_url)
  assert.equal(imageRecordUrl(resolveSbImageRecord(sb, page, 'last')), sb.last_frame_image_url)
  assert.equal(resolveSbImageRecord({ ...sb, last_frame_image_url: null, last_frame_image_id: 999 }, page, 'last'), null)
  assert.equal(resolveSbImageRecord({ ...sb, first_frame_image_id: 3 }, page).id, 3)
})

test('first-frame composed fallback uses the same field in list, canvas and video inputs', () => {
  const sb = { id: 9, composed_image: 'images/composed.png' }
  assert.equal(resolveSbFirstImageRecord(sb, {}).source_slot, 'composed')
  assert.equal(sbVideoFirstLastUrls(sb, {}, true).first, '/static/images/composed.png')
  assert.equal(resolveSbFirstImageRecord({ ...sb, first_frame_image_id: 100 }, {}), null)
})

test('fallback excludes full grids and invalid rows, while supplemental records require matching ownership', () => {
  const page = { 9: [image(5, 'quad_grid'), image(4, 'nine_grid'), image(3, 'storyboard_first', { status: 'failed' }), image(2, 'quad_panel_0')] }
  assert.equal(resolveSbImageRecord({ id: 9 }, page).id, 2)
  assert.equal(validateStoryboardImage(image(1), { id: 9 }, '1').id, 1)
  for (const bad of [null, image(2), image(1, undefined, { storyboard_id: 8 }), image(1, undefined, { status: 'failed' }), image(1, undefined, { local_path: null })]) {
    assert.throws(() => validateStoryboardImage(bad, { id: 9 }, 1), /不可用/)
  }
})

test('FreeCreate parses JSON task.result, uses image_generation_id GET and retains independent image identity', async () => {
  const requested = []
  const record = await completedImageTaskRecord({ result: JSON.stringify({ image_generation_id: 101 }) }, async (id) => {
    requested.push(id)
    return image(id, 'free')
  })
  assert.deepEqual(requested, [101])
  assert.equal(record.id, 101)
  assert.equal(imageRecordUrl(record), '/static/images/101.png')
  assert.equal((await completedImageTaskRecord({ result: { image_url: 'https://example.test/a.png' } }, () => assert.fail())).image_url, 'https://example.test/a.png')
  await assert.rejects(completedImageTaskRecord({ result: '{bad' }, () => assert.fail()))
  await assert.rejects(completedImageTaskRecord({ result: '{}' }, () => assert.fail()), /未返回可用图片/)
  await assert.rejects(completedImageTaskRecord({ result: '{"image_generation_id":9}' }, async () => ({ status: 'failed', image_url: 'old.png' })), /未返回可用图片/)
})
