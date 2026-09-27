import { assetImageUrl } from './mediaUrl.js'
import { parseDramaMetadata } from './canvasLayout.js'

export function dramaUsesFirstLastFrame(drama) {
  const meta = parseDramaMetadata(drama?.metadata)
  return !!meta.storyboard_use_first_last_frame
}

function isHttpVideoUrl(url) {
  if (!url || typeof url !== 'string') return false
  const t = url.trim()
  return t.startsWith('http://') || t.startsWith('https://')
}

function isCompletedImage(i) {
  return i?.status === 'completed'
    && i.frame_type !== 'quad_grid'
    && i.frame_type !== 'nine_grid'
    && (i.image_url || i.local_path)
}

export function getSbImagesList(imagesBySbId, storyboardId) {
  const list = imagesBySbId?.[storyboardId]
  return Array.isArray(list) ? list.filter(isCompletedImage) : []
}

export function getSbVideosList(videosBySbId, storyboardId) {
  const list = videosBySbId?.[storyboardId]
  if (!Array.isArray(list)) return []
  return list.filter((v) => v.status === 'completed' && ((v.local_path && String(v.local_path).trim()) || isHttpVideoUrl(v.video_url)))
}

export const IMAGE_FALLBACK_EXCLUDED_TYPES = 'image_edit_history,quad_grid,nine_grid'

function imageSlot(sb, slot) {
  const last = slot === 'last'
  return {
    id: last ? sb.last_frame_image_id : sb.first_frame_image_id,
    image_url: last ? sb.last_frame_image_url : sb.image_url,
    local_path: last ? sb.last_frame_local_path : sb.local_path,
    frame_type: slot === 'main' ? undefined : `storyboard_${slot}`,
    storyboard_id: sb.id,
    source_slot: slot,
    status: 'completed',
  }
}

/** A supplementary GET must never resolve a different storyboard or image. */
export function validateStoryboardImage(record, sb, id) {
  if (!record || String(record.storyboard_id) !== String(sb.id)
    || (id != null && String(record.id) !== String(id)) || !isCompletedImage(record)) {
    throw new Error('绑定的分镜图片不可用')
  }
  return record
}

/** Pure canonical selection. Supplements are separate from paged history: [sb.id][slot]. */
export function resolveSbImageRecord(sb, imagesBySbId, slot = 'main', supplements = {}) {
  if (!sb) return null
  const fields = imageSlot(sb, slot)
  const images = getSbImagesList(imagesBySbId, sb.id)
  const extra = supplements?.[sb.id]?.[slot]
  if (fields.id != null) {
    const bound = images.find((i) => String(i.id) === String(fields.id))
    if (bound) return { ...bound, source_slot: slot }
    if (fields.local_path || fields.image_url) return fields
    if (extra && String(extra.id) === String(fields.id)
      && String(extra.storyboard_id) === String(sb.id) && isCompletedImage(extra)) {
      return { ...extra, source_slot: slot }
    }
    return null // A missing/failed bound image must never select another image.
  }
  if (slot === 'main' && sb.composed_image) {
    const value = sb.composed_image
    return { storyboard_id: sb.id, source_slot: 'composed', status: 'completed',
      ...(value.startsWith('/') || /^https?:/.test(value) ? { image_url: value } : { local_path: value }) }
  }
  if (fields.local_path || fields.image_url) return fields
  const eligible = (i) => isCompletedImage(i) && i.frame_type !== 'image_edit_history'
    && (slot === 'main' || i.frame_type === fields.frame_type)
  const fallback = images.find(eligible)
    || (extra && String(extra.storyboard_id) === String(sb.id) && eligible(extra) ? extra : null)
  return fallback ? { ...fallback, source_slot: slot } : null
}

/** Network work needed after the normal page; callers own requests/errors/caches. */
export function storyboardImageLookup(sb, imagesBySbId, slot = 'main') {
  if (!sb || resolveSbImageRecord(sb, imagesBySbId, slot)) return null
  const fields = imageSlot(sb, slot)
  if (fields.id != null) return { id: fields.id }
  return { params: {
    storyboard_id: sb.id, status: 'completed', page_size: 1,
    exclude_frame_types: IMAGE_FALLBACK_EXCLUDED_TYPES,
    ...(fields.frame_type ? { frame_type: fields.frame_type } : {}),
  } }
}

export function resolveSbFirstImageRecord(sb, imagesBySbId, supplements) {
  return resolveSbImageRecord(sb, imagesBySbId, 'first', supplements)
    || (sb?.first_frame_image_id == null && sb?.composed_image ? resolveSbImageRecord(sb, imagesBySbId, 'main', supplements) : null)
}

export function resolveSbLastImageRecord(sb, imagesBySbId, supplements) {
  return resolveSbImageRecord(sb, imagesBySbId, 'last', supplements)
}

export function resolveSbMainImageRecord(sb, imagesBySbId, supplements) {
  return resolveSbImageRecord(sb, imagesBySbId, 'main', supplements)
}

export function imageRecordUrl(record) {
  return assetImageUrl(record)
}

/** 当前分镜视频（优先匹配 storyboard.video_url） */
export function resolveSbVideoRecord(sb, videosBySbId) {
  if (!sb) return null
  const list = getSbVideosList(videosBySbId, sb.id)
  if (list.length) {
    if (sb.video_url) {
      const matched = list.find((v) => v.video_url === sb.video_url)
      if (matched) return matched
      const lp = sb.video_url.replace(/^\/static\//, '')
      const byPath = list.find((v) => v.local_path && (v.local_path === lp || sb.video_url.includes(v.local_path)))
      if (byPath) return byPath
    }
    return list[0]
  }
  if (sb.video_url || sb.local_path) {
    return { video_url: sb.video_url, local_path: sb.local_path }
  }
  return null
}

export function videoRecordUrl(record) {
  if (!record) return ''
  const localPath = record.local_path && String(record.local_path).trim()
  if (localPath) return '/static/' + localPath.replace(/^\//, '')
  if (record.video_url && isHttpVideoUrl(record.video_url)) return record.video_url
  if (record.video_url) {
    const p = String(record.video_url).trim()
    if (p.startsWith('/static/')) return p
    if (!p.startsWith('http')) return '/static/' + p.replace(/^\//, '')
    return p
  }
  return ''
}

export function sbVideoFirstLastUrls(sb, imagesBySbId, useFirstLast, supplements) {
  const universal = sb?.creation_mode === 'universal'
  let first = ''
  let last = undefined
  if (!universal) {
    const firstRec = useFirstLast ? resolveSbFirstImageRecord(sb, imagesBySbId, supplements) : resolveSbMainImageRecord(sb, imagesBySbId, supplements)
    first = imageRecordUrl(firstRec)
  }
  if (useFirstLast && !universal) {
    const lastRec = resolveSbLastImageRecord(sb, imagesBySbId, supplements)
    const lu = imageRecordUrl(lastRec)
    if (lu) last = lu
  }
  return { first: first || undefined, last }
}

/** 分镜是否已有可用图片（与列表模式 hasSbImage 逻辑对齐） */
export function hasStoryboardImage(sb, imagesBySbId, drama, supplements) {
  const slot = dramaUsesFirstLastFrame(drama) && sb?.creation_mode !== 'universal' ? 'first' : 'main'
  return !!(slot === 'first' ? resolveSbFirstImageRecord(sb, imagesBySbId, supplements) : resolveSbImageRecord(sb, imagesBySbId, slot, supplements))
}

/** 分镜是否已有可用视频 */
export function hasStoryboardVideo(sb, videosBySbId) {
  if (!sb) return false
  const rec = resolveSbVideoRecord(sb, videosBySbId)
  return !!(rec?.video_url || rec?.local_path || sb.video_url)
}
