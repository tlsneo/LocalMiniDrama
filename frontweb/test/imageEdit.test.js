import test from 'node:test'
import assert from 'node:assert/strict'
import {
  imagePoint, comparisonMode, hasSelection, paintMaskSegment, replayMask, maskRgba,
  generationProblem, hasUnadoptedChanges, nextRound, sessionBusy, recoveryPhase, committedReceipt,
  prepareAndCommit, syncReceipt, validatePageTarget, finiteWait
} from '../src/utils/imageEdit.js'

const input = { url: '/input', width: 20, height: 10 }
const session = { state: 'editing', input_id: 'A', result_id: null, input, revision: 1, capabilities: { available: true, text_edit: true, mask_edit: true } }
const receipt = { adoption_id: 'adoption', result_id: 'C', url: '/final.png', image_url: '/final.png', local_path: 'final.png', image_id: 20 }
const adopted = { ...session, state: 'adopted', receipt }

test('pointer inverse transform includes container offset, image letterbox, pan and zoom, not DPR twice', () => {
  for (const dpr of [1, 1.25, 2, 3]) {
    const view = { x: 30 - 12, y: 60 + 17, scale: 0.75 * 2, dpr }
    const rect = { left: 100, top: 50 }
    assert.deepEqual(imagePoint(rect.left + view.x + 40 * view.scale, rect.top + view.y + 25 * view.scale, rect, view), { x: 40, y: 25 })
  }
})

test('binary brush does not accumulate opacity; eraser removes selection without touching original', () => {
  const mask = new Uint8Array(100)
  const start = { x: 2.5, y: 2.5 }, end = { x: 7.5, y: 7.5 }
  paintMaskSegment(mask, 10, 10, start, end, 1)
  const first = mask.slice()
  paintMaskSegment(mask, 10, 10, start, end, 1)
  assert.deepEqual(mask, first)
  assert.equal(hasSelection(mask), true)
  assert.equal(mask[0], 0)
  assert.equal(mask[55], 1)
  assert.ok(mask.every((pixel) => pixel === 0 || pixel === 1))
  paintMaskSegment(mask, 10, 10, start, end, 1, true)
  assert.equal(hasSelection(mask), false)
})

test('pointer capture strokes may leave image bounds; raster clips safely and undo replays operations', () => {
  const paint = { points: [{ x: -100, y: 2.5 }, { x: 100, y: 2.5 }], radius: 0.6, erase: false }
  const erase = { ...paint, erase: true }
  const strokes = [paint]
  const selected = replayMask(5, 5, strokes)
  assert.equal(selected.reduce((a, b) => a + b), 5)
  strokes.push(erase)
  assert.equal(hasSelection(replayMask(5, 5, strokes)), false)
  strokes.pop()
  assert.deepEqual(replayMask(5, 5, strokes), selected)
  strokes.push({ clear: true })
  assert.equal(hasSelection(replayMask(5, 5, strokes)), false)
  strokes.pop()
  assert.deepEqual(replayMask(5, 5, strokes), selected)
})

test('export pixels are opaque black-preserve/white-select; preview transparency is independent', () => {
  const mask = new Uint8Array([0, 1])
  assert.deepEqual([...maskRgba(mask)], [0, 0, 0, 255, 255, 255, 255, 255])
  const preview = maskRgba(mask, true)
  assert.equal(preview[3], 0)
  assert.equal(preview[7], 115)
  assert.deepEqual([...mask], [0, 1])
  assert.equal(hasSelection(new Uint8Array()), false)
})

test('compare uses divider for same ratio even at different resolution, otherwise side by side', () => {
  assert.equal(comparisonMode(input, { width: 200, height: 100 }), 'divider')
  assert.equal(comparisonMode(input, { width: 100, height: 200 }), 'side-by-side')
  assert.equal(comparisonMode({ width: 4000, height: 4000 }, { width: 4001, height: 4000 }), 'side-by-side')
  assert.equal(comparisonMode(input, null), 'none')
})

test('actual editing capabilities gate requests without a text-to-image fallback', () => {
  const args = { session, configId: 1, model: 'edit', prompt: 'change cup', selected: false }
  assert.equal(generationProblem(args), '')
  assert.match(generationProblem({ ...args, session: { ...session, capabilities: { available: false } } }), /尚未对接/)
  assert.match(generationProblem({ ...args, prompt: '   ' }), /填写/)
  assert.match(generationProblem({ ...args, configId: null }), /配置/)
  assert.match(generationProblem({ ...args, selected: true, session: { ...session, capabilities: { available: true, text_edit: true, mask_edit: false } } }), /不能忽略/)
  assert.match(generationProblem({ ...args, session: { ...session, capabilities: { available: true, text_edit: false, mask_edit: true } } }), /先涂抹/)
  assert.match(generationProblem({ ...args, session: null }), /原图/)
})

test('A→B→C resets inputs only on continue, back-adjust and failures preserve the B-round prompt/mask', () => {
  const generatingA = { ...session, state: 'generating' }
  const comparingB = { ...session, state: 'comparing', result_id: 'B' }
  assert.deepEqual(nextRound(generatingA, comparingB, 'cup to flowers', false), { prompt: 'cup to flowers', comparing: true, resetMask: false })
  const editingB = { ...session, input_id: 'B' }
  assert.deepEqual(nextRound(comparingB, editingB, 'cup to flowers', true), { prompt: '', comparing: false, resetMask: true })
  const generatingB = { ...editingB, state: 'generating' }
  const comparingC = { ...editingB, state: 'comparing', result_id: 'C' }
  assert.deepEqual(nextRound(generatingB, comparingC, 'blue shirt', false), { prompt: 'blue shirt', comparing: true, resetMask: false })
  // Back is purely a view change: heartbeat of C must not switch back to comparison.
  assert.deepEqual(nextRound(comparingC, comparingC, 'blue shirt', false), { prompt: 'blue shirt', comparing: false, resetMask: false })
  assert.deepEqual(nextRound(generatingB, { ...editingB, error: 'failed' }, 'blue shirt', false), { prompt: 'blue shirt', comparing: false, resetMask: false })
})

test('continuing B with an empty new prompt/mask still requires dirty-close confirmation', () => {
  assert.equal(hasUnadoptedChanges(session, '', false, 'A'), false)
  assert.equal(hasUnadoptedChanges(session, 'change', false, 'A'), true)
  assert.equal(hasUnadoptedChanges(session, '', true, 'A'), true)
  assert.equal(hasUnadoptedChanges({ ...session, input_id: 'B' }, '', false, 'A'), true)
  assert.equal(hasUnadoptedChanges({ ...session, result_id: 'B' }, '', false, 'A'), true)
})

test('generating/adopting lock; unknown work reconciles; committed work only synchronizes', () => {
  assert.equal(sessionBusy('generating'), true)
  assert.equal(sessionBusy('adopting'), true)
  assert.equal(sessionBusy('prepared'), false)
  assert.equal(recoveryPhase({ state: 'adopting' }), 'reconciling')
  assert.equal(recoveryPhase({ state: 'comparing' }), '')
  assert.equal(recoveryPhase(adopted), 'sync_pending')
  assert.throws(() => committedReceipt({ state: 'prepared', adoption_id: 'a' }), /尚未提交/)
  assert.equal(committedReceipt(adopted), receipt)
})

test('page prepare validates again, then commit; no source assignment or business save before receipt', async () => {
  let original = 'A', validations = 0
  const calls = []
  const context = { target: { type: 'page' }, validateTarget: () => { validations++; return original === 'A' }, onAdopted: (value) => { original = value.url } }
  const comparing = { ...session, state: 'comparing', result_id: 'C' }
  const prepared = { ...comparing, state: 'prepared', adoption_id: 'adoption', revision: 2 }
  const final = await prepareAndCommit(comparing, context, async (body) => {
    calls.push(body)
    assert.equal(original, 'A')
    return body.phase === 'prepare' ? prepared : adopted
  }, (value) => { assert.equal(value.receipt, undefined); assert.equal(original, 'A') })
  assert.equal(validations, 2)
  assert.deepEqual(calls, [
    { expected_revision: 1, result_id: 'C', phase: 'prepare' },
    { expected_revision: 2, result_id: 'C', phase: 'commit', adoption_id: 'adoption' }
  ])
  assert.equal(original, 'A')
  await syncReceipt(context, final)
  assert.equal(original, '/final.png')
})

test('changed page slot between prepare/commit rejects late overwrite and keeps original reference', async () => {
  let original = 'A'
  const calls = []
  const context = { target: { type: 'page' }, validateTarget: () => original === 'A', onAdopted: () => assert.fail('must not assign') }
  await assert.rejects(prepareAndCommit(session, context, async (body) => {
    calls.push(body.phase)
    original = 'new upload'
    return { ...session, state: 'prepared', revision: 2, adoption_id: 'a' }
  }, () => {}), /来源输入已变更/)
  assert.deepEqual(calls, ['prepare'])
  assert.equal(original, 'new upload')
  assert.throws(() => validatePageTarget({ target: { type: 'page' } }), /来源输入/)
})

test('database target commits directly; page prepared retry does not prepare a second file', async () => {
  const calls = []
  await prepareAndCommit(session, { target: { type: 'character' } }, async (body) => { calls.push(body.phase); return adopted }, () => assert.fail())
  await prepareAndCommit({ ...session, state: 'prepared', adoption_id: 'a' }, { target: { type: 'page' }, validateTarget: () => true }, async (body) => { calls.push(body.phase); assert.equal(body.adoption_id, 'a'); return adopted }, () => assert.fail())
  assert.deepEqual(calls, ['commit', 'commit'])
})

test('commit response loss is not retried; GET receipt can synchronize without a second adoption', async () => {
  let commits = 0, assignments = 0
  const context = { target: { type: 'asset' }, onAdopted: (value) => { assert.equal(value, receipt); assignments++ } }
  await assert.rejects(prepareAndCommit(session, context, async () => { commits++; throw new Error('response lost') }, () => {}), /response lost/)
  assert.equal(assignments, 0)
  assert.equal(recoveryPhase(adopted), 'sync_pending')
  await syncReceipt(context, adopted)
  assert.equal(commits, 1)
  assert.equal(assignments, 1)
})

test('refresh failure preserves receipt and retries only the callback; invalid page cannot consume receipt', async () => {
  let calls = 0
  const context = { target: { type: 'character' }, onAdopted: async (value) => { assert.equal(value, receipt); if (++calls === 1) throw new Error('refresh failed') } }
  await assert.rejects(syncReceipt(context, adopted), /refresh failed/)
  assert.equal(adopted.receipt, receipt)
  await syncReceipt(context, adopted)
  assert.equal(calls, 2)
  await assert.rejects(syncReceipt({ target: { type: 'page' }, validateTarget: () => false, onAdopted: () => assert.fail() }, adopted), /来源输入/)
  await assert.rejects(syncReceipt({ target: { type: 'page' }, validateTarget: () => true, onAdopted: async () => {} }, adopted), /同步本地赋值/)
})

test('finite callback/network waits release their timer on success and reject on timeout', async () => {
  assert.equal(await finiteWait(Promise.resolve('ok'), 100), 'ok')
  await assert.rejects(finiteWait(new Promise(() => {}), 5), /等待超时/)
})
