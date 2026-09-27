<template>
  <el-dialog :model-value="visible" :title="context?.title || 'AI 图片编辑'" width="min(1280px, 96vw)"
    top="3vh" destroy-on-close append-to-body :before-close="closeDialog" class="image-editor-dialog">
    <p class="privacy-note">原图、遮罩和修改要求会发送到所选模型服务。采用前不会改变来源图片；不会按遮罩裁切或拼回结果。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="alert" />
    <el-alert v-if="session && !session.capabilities?.available" :title="session.capabilities?.reason || '图片编辑协议尚未对接'" description="当前只能查看原图、填写描述和绘制选区；真实生成不可用，不提供模拟结果或文生图替代。" type="warning" :closable="false" show-icon class="alert" />
    <div v-if="session?.input" class="editor-layout">
      <ImageEditCanvas ref="canvas" :input="session.input" :input-id="String(session.input_id)" :result="session.result"
        :comparing="comparing" :disabled="busy || !!phase || session.state === 'prepared'"
        @selection="selected = $event" @ready="imageReady = $event" @result-ready="resultReady = $event" @error="error = $event" />
      <aside>
        <label for="image-edit-service">图片编辑服务</label>
        <el-select id="image-edit-service" v-model="configId" :disabled="locked" placeholder="选择 image_edit 服务">
          <el-option v-for="config in configs" :key="config.id" :label="config.name" :value="config.id" />
        </el-select>
        <p v-if="!configs.length" class="note">未配置可用的图片编辑服务，请关闭窗口后到“AI 配置”添加。不会使用普通生图服务。</p>
        <label for="image-edit-model">模型</label>
        <el-select id="image-edit-model" v-model="model" :disabled="locked" placeholder="选择编辑模型">
          <el-option v-for="item in models" :key="item" :label="item" :value="item" />
        </el-select>
        <label for="image-edit-prompt">修改要求</label>
        <el-input id="image-edit-prompt" v-model="prompt" type="textarea" :rows="7" :disabled="locked" placeholder="例如：把手里的杯子换成一束花，保留人物姿势。" />
        <p class="note">{{ selected ? '当前模式：遮罩局部重绘' : '当前模式：文字改图（不传遮罩）' }}</p>
        <el-button v-if="!comparing && !session.receipt && session.state !== 'prepared'" type="primary" :disabled="!!generationDisabled" :loading="session.state === 'generating' && phase !== 'uncertain'" @click="generateImage">请求生成</el-button>
        <p v-if="!comparing && generationDisabled" class="note">{{ generationDisabled }}</p>
        <el-button v-if="!comparing && session.state === 'comparing'" :disabled="busy || !!phase" @click="comparing = true">查看本轮结果</el-button>
        <p v-if="busy" role="status">{{ phase === 'reconciling' ? '正在查询会话及采用回执，不会重发请求…' : '正在处理，请稍候。此时无法关闭或离开页面。' }}</p>
        <template v-if="comparing && !phase && session.state === 'comparing'">
          <el-button type="primary" :disabled="busy || !resultReady" @click="adopt">采用新图</el-button>
          <el-button :disabled="busy || !resultReady" @click="continueEditing">继续编辑</el-button>
          <el-button :disabled="busy" @click="back">返回调整</el-button>
          <p class="note">继续编辑：以结果开始下一轮。返回调整：保留本轮原图、选区和描述。</p>
        </template>
        <el-button v-if="session.state === 'prepared' && !phase" type="primary" :disabled="busy" @click="adopt">核对来源并提交采用</el-button>
        <el-button v-if="phase === 'uncertain'" type="primary" @click="recheck">重查保存 / 生成状态</el-button>
        <template v-if="phase === 'sync_pending'">
          <p class="note">已保存回执：{{ session.receipt?.adoption_id }}。关闭不会撤销保存。</p>
          <el-button type="primary" @click="finishSync">重试页面同步</el-button>
        </template>
      </aside>
    </div>
    <p v-else role="status">{{ phase === 'opening' ? '正在读取实际选中的原图…' : '原图不可用，请关闭后重新打开。' }}</p>
    <template #footer><el-button @click="requestClose">{{ busy ? '处理中，暂不能关闭' : '关闭' }}</el-button></template>
  </el-dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ImageEditCanvas from '@/components/ImageEditCanvas.vue'
import { aiAPI } from '@/api/ai'
import { useImageEditor } from '@/composables/useImageEditor'
import { finiteWait, generationProblem } from '@/utils/imageEdit'
import { getSelectableModels } from '@/utils/modelSelection'

const { visible, context, session, prompt, selected, comparing, phase, error, busy, generate, back, continueEditing, adopt, finishSync, requestClose, recheck, beforeUnload } = useImageEditor()
const router = useRouter()
const configs = ref([]), configId = ref(null), model = ref(''), canvas = ref(null), imageReady = ref(false), resultReady = ref(false)
const locked = computed(() => busy.value || !!phase.value || comparing.value || session.value?.state === 'prepared')
const models = computed(() => getSelectableModels(configs.value, 'image_edit', configId.value))
const generationDisabled = computed(() => {
  if (busy.value || phase.value) return '等待当前操作或状态核对完成'
  if (!['editing', 'comparing'].includes(session.value?.state)) return '当前会话不可生成，请先完成采用或重新打开'
  if (!imageReady.value) return '原图尚未读取成功'
  return generationProblem({ session: session.value, prompt: prompt.value, configId: configId.value, model: model.value, selected: selected.value })
})
watch(models, (values) => { if (!values.includes(model.value)) model.value = values[0] || '' })
let configRequest = 0, removeGuard
watch(visible, async (value) => {
  const token = ++configRequest
  if (!value) return
  imageReady.value = false
  resultReady.value = false
  configs.value = []
  configId.value = null
  model.value = ''
  try {
    const list = await finiteWait(aiAPI.list('image_edit'), 15000)
    if (token !== configRequest || !visible.value) return
    configs.value = (Array.isArray(list) ? list : []).filter((item) => item.service_type === 'image_edit' && item.is_active)
    configId.value = (configs.value.find((item) => item.is_default) || configs.value[0])?.id || null
  } catch (e) { if (token === configRequest && visible.value) error.value = `编辑服务加载失败：${e.message}` }
})
async function generateImage() {
  if (generationDisabled.value) return
  await generate({ configId: configId.value, model: model.value, getMask: () => canvas.value.exportMask() })
}
async function closeDialog(done) { if (await requestClose()) done() }
onMounted(() => {
  removeGuard = router.beforeEach(() => visible.value ? requestClose() : true)
  window.addEventListener('beforeunload', beforeUnload)
})
onBeforeUnmount(() => { removeGuard?.(); window.removeEventListener('beforeunload', beforeUnload) })
</script>

<style scoped>
.editor-layout { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 20px; }
aside { display: flex; flex-direction: column; gap: 10px; }
aside label { font-weight: 600; }
aside .el-button { margin-left: 0; }
.alert { margin-bottom: 12px; }
.note, .privacy-note { font-size: 12px; line-height: 1.6; color: var(--text-secondary); }
.privacy-note { margin-top: 0; }
@media (max-width: 850px) { .editor-layout { grid-template-columns: 1fr; } }
</style>
