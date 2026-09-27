import { imageRecordUrl } from './storyboardMedia.js'

/** async_tasks.result is JSON text; fetch the actual generation record, not the task id. */
export async function completedImageTaskRecord(task, getImage) {
  const result = typeof task.result === 'string' ? JSON.parse(task.result) : task.result
  const id = result?.image_generation_id
  const record = id != null ? await getImage(id) : result
  if (!record || !imageRecordUrl(record) || (record.status && record.status !== 'completed')) {
    throw new Error('生成任务未返回可用图片')
  }
  return { ...record, id: record.id ?? id }
}
