<template>
  <section class="image-edit-canvas">
    <div class="tools" aria-label="图片编辑工具">
      <template v-if="!comparing">
        <button type="button" :aria-pressed="tool === 'paint'" :disabled="disabled" @click="tool = 'paint'">画笔</button>
        <button type="button" :aria-pressed="tool === 'erase'" :disabled="disabled" @click="tool = 'erase'">橡皮擦</button>
        <label>笔刷（屏幕像素）<input v-model.number="brush" type="range" min="2" max="160" :disabled="disabled" /> {{ brush }}</label>
        <button type="button" :disabled="disabled || !operations.length" @click="undo">撤销</button>
        <button type="button" :disabled="disabled || !selected" @click="clear">清空选区</button>
      </template>
      <button type="button" :aria-pressed="tool === 'pan'" :disabled="disabled" @click="tool = 'pan'">平移</button>
      <button type="button" aria-label="缩小图片" :disabled="disabled" @click="zoomBy(0.8)">−</button>
      <span>{{ Math.round(zoom * 100) }}%</span>
      <button type="button" aria-label="放大图片" :disabled="disabled" @click="zoomBy(1.25)">＋</button>
      <button type="button" :disabled="disabled" @click="resetView">适合窗口</button>
    </div>
    <p v-if="comparing && compareMode === 'side-by-side'" class="notice">结果宽高比与原图不同，使用等比例并排预览，不拉伸或裁切。</p>
    <div ref="stage" class="stage" :class="{ panning: tool === 'pan' || comparing }"
      @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerEnd" @pointercancel="pointerEnd"
      @lostpointercapture="pointerEnd" @wheel.prevent="wheel">
      <div v-show="!comparing" class="layer">
        <img :src="input.url" :style="imageStyle" draggable="false" alt="本轮输入原图" @load="$emit('ready', true)" @error="imageError" />
        <canvas ref="overlay" :style="imageStyle" aria-label="独立半透明选区，不改变原图" />
      </div>
      <template v-if="comparing && result">
        <template v-if="compareMode === 'divider'">
          <div class="layer"><img :src="result.url" :style="imageStyle" draggable="false" alt="编辑结果" @load="$emit('result-ready', true)" @error="resultError" /></div>
          <div class="layer" :style="{ clipPath: `inset(0 ${100 - divider}% 0 0)` }"><img :src="input.url" :style="imageStyle" draggable="false" alt="本轮原图" /></div>
          <span class="caption left">原图</span><span class="caption right">编辑后</span>
          <div class="divider" :style="{ left: divider + '%' }">
            <button type="button" aria-label="拖动原图与结果分界线；也可使用下方滑条" :disabled="disabled" @pointerdown.stop="dividerDown" @keydown.left.prevent="divider = Math.max(0, divider - 1)" @keydown.right.prevent="divider = Math.min(100, divider + 1)">↔</button>
          </div>
        </template>
        <div v-else class="side-by-side">
          <div><span class="caption left">原图</span><img :src="input.url" :style="sideStyle" draggable="false" alt="本轮原图" /></div>
          <div><span class="caption left">编辑后</span><img :src="result.url" :style="sideStyle" draggable="false" alt="编辑结果，宽高比不同" @load="$emit('result-ready', true)" @error="resultError" /></div>
        </div>
      </template>
    </div>
    <label v-if="comparing && compareMode === 'divider'" class="comparison-slider">原图 ← 对比分界 → 编辑后
      <input v-model.number="divider" type="range" min="0" max="100" aria-label="原图与编辑结果分界，向右显示更多原图" :disabled="disabled" />
    </label>
    <p v-else-if="!comparing" class="hint">{{ selected ? '遮罩局部重绘：红色区域为选区' : '文字改图：无选区，不发送遮罩' }}。滚轮缩放；选择“平移”拖动画面。选区透明度仅用于预览。</p>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { comparisonMode, finiteWait, hasSelection, imagePoint, maskRgba, paintMaskSegment, replayMask } from '@/utils/imageEdit'

const props = defineProps({ input: { type: Object, required: true }, inputId: { type: String, required: true }, result: Object, comparing: Boolean, disabled: Boolean })
const emit = defineEmits(['selection', 'ready', 'result-ready', 'error'])
const stage = ref(null), overlay = ref(null)
const size = ref({ width: 1, height: 1 })
const tool = ref('paint'), brush = ref(36), zoom = ref(1), pan = ref({ x: 0, y: 0 }), divider = ref(50)
const operations = ref([]), selected = ref(false)
let mask = new Uint8Array(), pointer = null, observer, frame
const compareMode = computed(() => comparisonMode(props.input, props.result))
const view = computed(() => {
  const scale = Math.min(size.value.width / props.input.width, size.value.height / props.input.height) * zoom.value
  return { scale, x: (size.value.width - props.input.width * scale) / 2 + pan.value.x, y: (size.value.height - props.input.height * scale) / 2 + pan.value.y }
})
const imageStyle = computed(() => ({ width: `${props.input.width}px`, height: `${props.input.height}px`, transform: `translate(${view.value.x}px, ${view.value.y}px) scale(${view.value.scale})` }))
const sideStyle = computed(() => ({ transform: `translate(${pan.value.x}px, ${pan.value.y}px) scale(${zoom.value})` }))
function resetView() { if (pointer) return; zoom.value = 1; pan.value = { x: 0, y: 0 } }
function render() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    if (!overlay.value) return
    // ponytail: full overlay refresh per animation frame; use dirty rectangles if large-image profiling warrants it.
    const context = overlay.value.getContext('2d')
    context.putImageData(new ImageData(maskRgba(mask, true), props.input.width, props.input.height), 0, 0)
  })
}
function selectionChanged() {
  selected.value = hasSelection(mask)
  emit('selection', selected.value)
  render()
}
function rebuild() {
  mask = replayMask(props.input.width, props.input.height, operations.value)
  selectionChanged()
}
function undo() { if (pointer) return; operations.value.pop(); rebuild() }
function clear() { if (pointer) return; operations.value.push({ clear: true }); mask.fill(0); selectionChanged() }
function point(event) { return imagePoint(event.clientX, event.clientY, stage.value.getBoundingClientRect(), view.value) }
function pointerDown(event) {
  if (props.disabled || pointer || event.button !== 0) return
  event.preventDefault()
  const start = point(event)
  const panning = tool.value === 'pan' || props.comparing
  if (!panning && (start.x < 0 || start.y < 0 || start.x >= props.input.width || start.y >= props.input.height)) return
  stage.value.setPointerCapture(event.pointerId)
  pointer = { id: event.pointerId, mode: panning ? 'pan' : 'stroke', x: event.clientX, y: event.clientY, pan: { ...pan.value } }
  if (!panning) {
    const stroke = { points: [start], radius: brush.value / view.value.scale / 2, erase: tool.value === 'erase' }
    operations.value.push(stroke)
    pointer.stroke = stroke
    paintMaskSegment(mask, props.input.width, props.input.height, start, start, stroke.radius, stroke.erase)
    render()
  }
}
function dividerDown(event) {
  if (props.disabled || pointer) return
  event.preventDefault()
  stage.value.setPointerCapture(event.pointerId)
  pointer = { id: event.pointerId, mode: 'divider' }
  pointerMove(event)
}
function pointerMove(event) {
  if (!pointer || pointer.id !== event.pointerId) return
  if (pointer.mode === 'divider') {
    const rect = stage.value.getBoundingClientRect()
    divider.value = Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100))
  } else if (pointer.mode === 'pan') {
    pan.value = { x: pointer.pan.x + event.clientX - pointer.x, y: pointer.pan.y + event.clientY - pointer.y }
  } else {
    const stroke = pointer.stroke, end = point(event), last = stroke.points[stroke.points.length - 1]
    paintMaskSegment(mask, props.input.width, props.input.height, last, end, stroke.radius, stroke.erase)
    stroke.points.push(end)
    render()
  }
}
function pointerEnd(event) {
  if (!pointer || pointer.id !== event.pointerId) return
  const wasStroke = pointer.mode === 'stroke'
  pointer = null
  if (stage.value.hasPointerCapture(event.pointerId)) stage.value.releasePointerCapture(event.pointerId)
  if (wasStroke) selectionChanged()
}
function zoomBy(factor, anchor) {
  if (props.disabled || pointer) return
  const old = view.value
  const next = Math.max(0.1, Math.min(16, zoom.value * factor))
  const ratio = next / zoom.value
  const a = anchor || { x: size.value.width / 2, y: size.value.height / 2 }
  zoom.value = next
  pan.value = {
    x: a.x - (a.x - old.x) * ratio - (size.value.width - props.input.width * old.scale * ratio) / 2,
    y: a.y - (a.y - old.y) * ratio - (size.value.height - props.input.height * old.scale * ratio) / 2
  }
}
function wheel(event) {
  const rect = stage.value.getBoundingClientRect()
  zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, { x: event.clientX - rect.left, y: event.clientY - rect.top })
}
function imageError() { emit('ready', false); emit('error', '会话原图读取失败，请重查状态或重新打开') }
function resultError() { emit('result-ready', false); emit('error', '结果预览读取失败，暂不能采用；可以返回调整或重查状态') }
async function exportMask() {
  if (pointer?.mode === 'stroke') throw new Error('请先完成当前笔画')
  if (!hasSelection(mask)) return null
  const canvas = document.createElement('canvas')
  canvas.width = props.input.width; canvas.height = props.input.height
  canvas.getContext('2d').putImageData(new ImageData(maskRgba(mask), canvas.width, canvas.height), 0, 0)
  return finiteWait(new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('遮罩 PNG 导出失败')), 'image/png')), 10000)
}
watch(() => props.inputId, async () => {
  emit('ready', false)
  pointer = null
  operations.value = []
  resetView()
  await nextTick()
  if (!overlay.value) return
  overlay.value.width = props.input.width; overlay.value.height = props.input.height
  rebuild()
}, { immediate: true })
watch(() => props.comparing, () => { divider.value = 50 })
watch(() => props.result?.url, () => emit('result-ready', false))
onMounted(() => {
  observer = new ResizeObserver(([entry]) => { size.value = { width: entry.contentRect.width, height: entry.contentRect.height } })
  observer.observe(stage.value)
})
onBeforeUnmount(() => { observer?.disconnect(); cancelAnimationFrame(frame) })
defineExpose({ exportMask })
</script>

<style scoped>
.image-edit-canvas { min-width: 0; }
.tools { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
.tools label { display: flex; align-items: center; gap: 5px; font-size: 12px; }
.tools input { width: 90px; }
button { cursor: pointer; border: 1px solid var(--border-color, #64748b); border-radius: 5px; padding: 5px 9px; background: var(--bg-card, #263244); color: inherit; }
button[aria-pressed="true"] { outline: 2px solid #409eff; }
button:disabled { opacity: .45; cursor: not-allowed; }
.stage { position: relative; height: min(62vh, 650px); min-height: 260px; overflow: hidden; touch-action: none; background: #161b24; cursor: crosshair; user-select: none; }
.stage.panning { cursor: grab; }
.layer { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.layer img, .layer canvas { position: absolute; left: 0; top: 0; max-width: none; transform-origin: 0 0; }
.caption { position: absolute; top: 8px; padding: 4px 9px; background: #000a; color: white; border-radius: 4px; z-index: 2; pointer-events: none; }
.caption.left { left: 8px; }.caption.right { right: 8px; }
.divider { position: absolute; top: 0; bottom: 0; width: 2px; background: white; pointer-events: none; }
.divider button { position: absolute; top: 50%; left: 0; transform: translate(-50%, -50%); pointer-events: auto; background: #fff; color: #111; touch-action: none; }
.side-by-side { display: flex; height: 100%; pointer-events: none; }
.side-by-side > div { position: relative; width: 50%; height: 100%; overflow: hidden; border-right: 1px solid #596579; }
.side-by-side img { width: 100%; height: 100%; object-fit: contain; }
.comparison-slider { display: flex; align-items: center; gap: 12px; padding-top: 10px; }
.comparison-slider input { flex: 1; }
.hint, .notice { font-size: 12px; color: var(--text-secondary, #8e9db5); }
.notice { color: #e6a23c; }
</style>
