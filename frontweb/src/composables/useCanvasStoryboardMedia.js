import { ref } from 'vue'
import { imagesAPI } from '@/api/images'
import { videosAPI } from '@/api/videos'
import { storyboardImageLookup, validateStoryboardImage } from '@/utils/storyboardMedia'

/**
 * 加载当前剧集分镜的 images / videos 列表（与 FilmCreate.loadStoryboardMedia 对齐）
 */
export function useCanvasStoryboardMedia() {
  const imagesBySbId = ref({})
  const videosBySbId = ref({})
  const mediaLoading = ref(false)
  const imageSupplements = ref({})
  const imageErrors = ref({})
  let loadVersion = 0

  async function loadForStoryboards(storyboards) {
    const version = ++loadVersion
    const boards = storyboards || []
    if (!boards.length) {
      imagesBySbId.value = {}
      videosBySbId.value = {}
      imageSupplements.value = {}
      imageErrors.value = {}
      mediaLoading.value = false
      return
    }
    mediaLoading.value = true
    try {
      const nextImages = { ...imagesBySbId.value }
      const nextVideos = { ...videosBySbId.value }
      const supplements = {}
      const errors = {}
      await Promise.all(
        boards.map(async (sb) => {
          try {
            const [imgRes, vidRes] = await Promise.allSettled([
              imagesAPI.list({ storyboard_id: sb.id, page: 1, page_size: 100 }),
              videosAPI.list({ storyboard_id: sb.id, page: 1, page_size: 50 }),
            ])
            nextImages[sb.id] = imgRes.status === 'fulfilled' ? imgRes.value?.items || [] : []
            nextVideos[sb.id] = vidRes.status === 'fulfilled' ? vidRes.value?.items || [] : []
            supplements[sb.id] = {}
            errors[sb.id] = {}
            await Promise.all(['main', 'first', 'last'].map(async (slot) => {
              const lookup = storyboardImageLookup(sb, nextImages, slot)
              if (!lookup) return
              try {
                const record = lookup.id != null
                  ? await imagesAPI.get(lookup.id)
                  : (await imagesAPI.list(lookup.params))?.items?.[0]
                if (record || lookup.id != null) {
                  supplements[sb.id][slot] = validateStoryboardImage(record, sb, lookup.id)
                }
              } catch (error) {
                errors[sb.id][slot] = error.message || '分镜图片不可用'
              }
            }))
          } catch (error) {
            nextImages[sb.id] = []
            nextVideos[sb.id] = []
            errors[sb.id] = { main: error.message || '分镜媒体加载失败' }
          }
        })
      )
      if (version !== loadVersion) return
      imagesBySbId.value = nextImages
      videosBySbId.value = nextVideos
      imageSupplements.value = supplements
      imageErrors.value = errors
    } finally {
      if (version === loadVersion) mediaLoading.value = false
    }
  }

  async function loadForDrama(drama, episodeId = null) {
    const episodes = episodeId
      ? (drama?.episodes || []).filter((ep) => ep.id === episodeId)
      : (drama?.episodes || [])
    const boards = episodes.flatMap((ep) => ep.storyboards || [])
    await loadForStoryboards(boards)
  }

  return {
    imagesBySbId,
    videosBySbId,
    mediaLoading,
    imageSupplements,
    imageErrors,
    loadForStoryboards,
    loadForDrama,
  }
}
