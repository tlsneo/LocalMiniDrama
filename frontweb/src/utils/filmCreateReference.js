// Reference drafts keep their uploaded/adopted path; form submission must not re-upload old pixels.
export async function ensureReferenceUploaded(draft, upload) {
  if (draft.local_path || draft.url) return draft.local_path || draft.url
  const response = await fetch(draft.dataUrl)
  if (!response.ok) throw new Error('读取参考图失败')
  const blob = await response.blob()
  const result = await upload(new File([blob], draft.filename || 'reference.png', { type: blob.type }))
  const data = result?.data ?? result
  if (!data?.local_path && !data?.url) throw new Error('上传未返回参考图地址')
  draft.local_path = data.local_path || ''
  draft.url = data.url || '/static/' + data.local_path
  return draft.local_path || draft.url
}

export function referenceEditContext({ draftRef, formRef, visible, dramaId }) {
  const draft = draftRef.value
  const form = formRef.value
  if (!draft?.id || !(draft.local_path || draft.url)) throw new Error('请先完成参考图上传')
  const original = draft.local_path || draft.url
  const validateTarget = () => visible.value && formRef.value === form && draftRef.value === draft
    && (draft.local_path || draft.url) === original
  return {
    title: 'AI 编辑参考图 · 采用后应用到当前输入',
    source: { local_path: draft.local_path || undefined, url: draft.url },
    target: { type: 'page', id: draft.id, kind: 'reference', drama_id: dramaId },
    validateTarget,
    onAdopted(receipt) {
      if (!validateTarget()) throw new Error('参考图输入已变更，请恢复原表单后重试同步')
      draftRef.value = { id: draft.id, local_path: receipt.local_path, url: receipt.image_url || receipt.url,
        dataUrl: receipt.image_url || receipt.url || '/static/' + receipt.local_path }
    },
  }
}

export async function createSceneAndSaveReference(form, payload, create, saveReference) {
  const created = await create(payload)
  if (!created?.id) throw new Error('创建场景未返回 ID')
  form.id = created.id // Keep identity even if reference persistence fails; retry must update this row.
  await saveReference(form.id)
}

// The extraction API accepts data URLs, not relative /static URLs. Always read the current draft.
export async function referenceExtractionInput(draft) {
  if (draft.dataUrl?.startsWith('data:')) return draft.dataUrl
  const response = await fetch(draft.url || '/static/' + draft.local_path)
  if (!response.ok) throw new Error('读取参考图失败')
  const blob = await response.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('读取参考图失败'))
    reader.readAsDataURL(blob)
  })
}
