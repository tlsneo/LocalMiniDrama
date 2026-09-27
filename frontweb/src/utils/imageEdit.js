// Pointer coordinates are CSS pixels; the mask uses normalized input-image pixels,
// so devicePixelRatio must not be applied a second time.
export function imagePoint(clientX, clientY, rect, view) {
  return { x: (clientX - rect.left - view.x) / view.scale, y: (clientY - rect.top - view.y) / view.scale }
}

export function comparisonMode(input, result) {
  if (!input?.width || !input?.height || !result?.width || !result?.height) return 'none'
  return input.width * result.height === result.width * input.height ? 'divider' : 'side-by-side'
}

export function hasSelection(mask) {
  return mask.some((value) => value !== 0)
}

// Rasterize a capsule at pixel centers: every pixel is selected or not selected,
// never brush-opacity/antialias intensity. Erasing follows exactly the same geometry.
export function paintMaskSegment(mask, width, height, from, to, radius, erase = false) {
  const left = Math.max(0, Math.floor(Math.min(from.x, to.x) - radius))
  const right = Math.min(width - 1, Math.ceil(Math.max(from.x, to.x) + radius))
  const top = Math.max(0, Math.floor(Math.min(from.y, to.y) - radius))
  const bottom = Math.min(height - 1, Math.ceil(Math.max(from.y, to.y) + radius))
  const dx = to.x - from.x, dy = to.y - from.y
  const length = dx * dx + dy * dy
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const t = length ? Math.max(0, Math.min(1, ((x + 0.5 - from.x) * dx + (y + 0.5 - from.y) * dy) / length)) : 0
      if ((x + 0.5 - from.x - t * dx) ** 2 + (y + 0.5 - from.y - t * dy) ** 2 <= radius ** 2) {
        mask[y * width + x] = erase ? 0 : 1
      }
    }
  }
}

export function replayMask(width, height, operations) {
  const mask = new Uint8Array(width * height)
  for (const stroke of operations) {
    if (stroke.clear) { mask.fill(0); continue }
    stroke.points.forEach((point, index) => paintMaskSegment(mask, width, height, stroke.points[Math.max(0, index - 1)], point, stroke.radius, stroke.erase))
  }
  return mask
}

export function maskRgba(mask, preview = false) {
  const data = new Uint8ClampedArray(mask.length * 4)
  mask.forEach((selected, index) => {
    const i = index * 4
    data[i] = preview ? 255 : selected ? 255 : 0
    data[i + 1] = preview ? 65 : data[i]
    data[i + 2] = preview ? 65 : data[i]
    data[i + 3] = preview ? selected ? 115 : 0 : 255
  })
  return data
}

export function generationProblem({ session, prompt, configId, model, selected }) {
  if (!session?.input?.url) return '原图尚未读取成功'
  if (!session.capabilities?.available) return session.capabilities?.reason || '图片编辑协议尚未对接'
  if (!configId || !model) return '请先配置并选择图片编辑服务及模型'
  if (!prompt.trim()) return '请填写修改要求'
  if (selected && !session.capabilities.mask_edit) return '当前模型不支持遮罩编辑，不能忽略选区提交'
  if (!selected && !session.capabilities.text_edit) return '当前模型仅支持局部重绘，请先涂抹选区'
  return ''
}

export function hasUnadoptedChanges(session, prompt, selected, initialInputId) {
  return !!(prompt.trim() || selected || session?.result_id || (initialInputId && session?.input_id !== initialInputId))
}

export function sessionBusy(state) {
  return state === 'generating' || state === 'adopting'
}

// Keep this round's description/mask in the UI until input_id actually changes.
export function nextRound(previous, next, prompt, comparing) {
  if (previous && previous.input_id !== next.input_id) return { prompt: '', comparing: false, resetMask: true }
  return {
    prompt,
    comparing: next.state === 'comparing' && (previous?.state === 'generating' || previous?.result_id !== next.result_id) ? true : comparing,
    resetMask: false
  }
}

export function recoveryPhase(session) {
  if (session.receipt) return 'sync_pending'
  return sessionBusy(session.state) ? 'reconciling' : ''
}

// A prepared response is not a receipt and must never be handed to the page.
export function committedReceipt(session) {
  if (session.state !== 'adopted' || !session.receipt?.adoption_id) throw new Error('采用尚未提交，不能回填来源')
  return session.receipt
}

export async function prepareAndCommit(session, context, adopt, update) {
  validatePageTarget(context)
  if (context.target.type === 'page' && session.state !== 'prepared') {
    session = await adopt({ expected_revision: session.revision, result_id: session.result_id, phase: 'prepare' })
    update(session)
  }
  validatePageTarget(context)
  return adopt({ expected_revision: session.revision, result_id: session.result_id, phase: 'commit', ...(session.adoption_id ? { adoption_id: session.adoption_id } : {}) })
}

export async function syncReceipt(context, session) {
  const receipt = committedReceipt(session)
  validatePageTarget(context)
  const pending = context.onAdopted(receipt)
  if (context.target.type === 'page' && pending?.then) {
    // Page adapters must assign synchronously; never upload or submit a form here.
    Promise.resolve(pending).catch(() => {})
    throw new Error('页面回填必须为同步本地赋值；文件已保存，请检查来源适配')
  }
  if (context.target.type !== 'page') await finiteWait(Promise.resolve(pending), 15000)
  return receipt
}

export async function finiteWait(promise, timeout) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('等待超时，请重查状态')), timeout)
    })])
  } finally { clearTimeout(timer) }
}

export function validatePageTarget(context) {
  if (context.target.type === 'page' && (!context.validateTarget || context.validateTarget() !== true)) {
    throw new Error('来源输入已变更或不存在，请关闭后重新打开编辑')
  }
}
