import { computed, ref, shallowRef } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { imageEditAPI } from '@/api/imageEdit'
import { generationProblem, hasUnadoptedChanges, nextRound, sessionBusy, recoveryPhase, prepareAndCommit, syncReceipt } from '@/utils/imageEdit'

const visible = ref(false)
const context = shallowRef(null)
const session = shallowRef(null)
const prompt = ref('')
const selected = ref(false)
const comparing = ref(false)
const phase = ref('')
const error = ref('')
const synced = ref(false)
const initialInputId = ref(null)
const busy = computed(() => visible.value && (['opening', 'requesting', 'reconciling', 'syncing', 'closing'].includes(phase.value) || (phase.value !== 'uncertain' && sessionBusy(session.value?.state))))
const dirty = computed(() => hasUnadoptedChanges(session.value, prompt.value, selected.value, initialInputId.value))
let timer, epoch = 0, waitStarted = 0, polling = false, reconciliationError = ''
const POLL_LIMIT = 10 * 60 * 1000
const RECONCILE_LIMIT = 45000

function accept(next) {
  const round = nextRound(session.value, next, prompt.value, comparing.value)
  prompt.value = round.prompt
  comparing.value = round.comparing
  if (round.resetMask) selected.value = false
  session.value = next
  if (next.error) error.value = next.error
  if (['expired', 'discarded'].includes(next.state)) error.value = '编辑会话已结束或过期，请关闭后重新打开'
}
function schedule(delay = 20000) {
  clearTimeout(timer)
  if (visible.value && session.value && !['expired', 'discarded'].includes(session.value.state) && ['', 'reconciling', 'sync_pending'].includes(phase.value)) timer = setTimeout(poll, delay)
}
function uncertainty(message = '状态未确认。请重查；关闭不会取消任务、回滚采用或删除文件。') {
  phase.value = 'uncertain'
  error.value = message
  clearTimeout(timer)
}
async function poll() {
  if (polling || !visible.value || !session.value) return
  polling = true
  const token = epoch
  try {
    const next = await imageEditAPI.get(session.value.id)
    if (token !== epoch || !['', 'reconciling', 'sync_pending'].includes(phase.value)) return
    // A heartbeat begun before a mutation must not roll back its newer revision.
    if (next.revision < session.value.revision) return
    accept(next)
    if (next.receipt) {
      if (phase.value !== 'sync_pending') error.value = '文件已保存，等待同步来源。请点击“重试页面同步”，不会重复采用。'
      phase.value = 'sync_pending'
      return
    }
    if (next.state === 'generating' && phase.value === 'reconciling') {
      phase.value = ''
      error.value = '已确认生成任务仍在处理中；未重新提交请求。'
    }
    if (!sessionBusy(next.state)) {
      if (phase.value === 'reconciling' && !next.error) error.value = `${reconciliationError ? reconciliationError + '。' : ''}会话状态已确认，请核对图片后继续操作；请求未自动重发。`
      phase.value = ''
      waitStarted = 0
    } else if (waitStarted && Date.now() - waitStarted > (phase.value === 'reconciling' ? RECONCILE_LIMIT : POLL_LIMIT)) {
      uncertainty()
      return
    }
  } catch (e) {
    if (token !== epoch || !['', 'reconciling', 'sync_pending'].includes(phase.value)) return
    if (session.value.receipt) {
      phase.value = 'sync_pending'
      error.value = `文件已保存，心跳连接失败：${e.message}。可重试同一回执的页面同步。`
      return
    }
    if (phase.value !== 'reconciling') { phase.value = 'reconciling'; waitStarted = Date.now() }
    error.value = `连接中断，正在核对会话：${e.message}`
    if (Date.now() - waitStarted >= RECONCILE_LIMIT) { uncertainty(); return }
  } finally {
    polling = false
    if (token === epoch) schedule(sessionBusy(session.value?.state) || phase.value === 'reconciling' ? 1500 : 20000)
  }
}
function reconcile(e) {
  reconciliationError = e?.message || ''
  error.value = `请求结果尚未确认，正在查询原会话；不会自动重发。${e?.message || ''}`
  phase.value = 'reconciling'
  waitStarted = Date.now()
  schedule(0)
}
async function open(value) {
  if (visible.value) { ElMessage.warning('请先结束当前图片编辑'); return false }
  if (!value?.source || !value?.target || typeof value.onAdopted !== 'function') throw new Error('图片编辑缺少来源、目标或采用回调')
  context.value = { ...value, source: { ...value.source }, target: { ...value.target } }
  visible.value = true
  prompt.value = ''
  selected.value = false
  comparing.value = false
  synced.value = false
  initialInputId.value = null
  session.value = null
  reconciliationError = ''
  error.value = ''
  phase.value = 'opening'
  const token = ++epoch
  try {
    const { source, target, expected_ref } = context.value
    const created = await imageEditAPI.create({ source, target, ...(expected_ref !== undefined ? { expected_ref } : {}) })
    if (token !== epoch) return false
    accept(created)
    initialInputId.value = created.input_id
    phase.value = ''
    schedule()
    return true
  } catch (e) {
    if (token === epoch) { error.value = `无法读取原图：${e.message}`; phase.value = '' }
    return false
  }
}
async function generate({ configId, model, getMask }) {
  if (busy.value || phase.value || !['editing', 'comparing'].includes(session.value?.state)) return
  const problem = generationProblem({ session: session.value, prompt: prompt.value, configId, model, selected: selected.value })
  if (problem) { error.value = problem; return }
  clearTimeout(timer)
  phase.value = 'requesting'
  error.value = ''
  let sent = false
  try {
    const mask = await getMask()
    // Recheck the actual exported selection rather than trusting a past brush action.
    const mismatch = generationProblem({ session: session.value, prompt: prompt.value, configId, model, selected: !!mask })
    if (mismatch) throw new Error(mismatch)
    const body = { request_id: crypto.randomUUID(), expected_revision: session.value.revision, input_id: session.value.input_id, config_id: configId, model, prompt: prompt.value, ...(mask ? { mask } : {}) }
    sent = true
    const response = await imageEditAPI.generate(session.value.id, body)
    accept(response.session)
    phase.value = ''
    waitStarted = Date.now()
    schedule(1500)
  } catch (e) {
    if (sent) reconcile(e)
    else { phase.value = ''; error.value = e.message; schedule() }
  }
}
function back() {
  if (!busy.value && !phase.value && session.value?.state === 'comparing') comparing.value = false
}
async function continueEditing() {
  if (busy.value || phase.value || session.value?.state !== 'comparing') return
  clearTimeout(timer)
  phase.value = 'requesting'
  error.value = ''
  try {
    accept(await imageEditAPI.continue(session.value.id, { expected_revision: session.value.revision, result_id: session.value.result_id }))
    phase.value = ''
    schedule()
  } catch (e) { reconcile(e) }
}
async function finishSync() {
  if (busy.value || !session.value?.receipt) return
  clearTimeout(timer)
  phase.value = 'syncing'
  error.value = ''
  try {
    if (!synced.value) {
      await syncReceipt(context.value, session.value)
      synced.value = true
    }
  } catch (e) {
    phase.value = 'sync_pending'
    error.value = `文件已保存，页面同步失败：${e.message}。仅重试同一回执，不会重复采用。`
    schedule()
    return
  }
  // finish transfers no ownership: a cleanup error cannot undo a committed receipt.
  try { await imageEditAPI.finish(session.value.id) }
  catch { ElMessage.warning('图片已采用；临时文件清理稍后由后台重试') }
  ElMessage.success(context.value.target.type === 'page' ? '已应用到当前输入（原表单仍需按原流程保存）' : '图片已采用')
  reset()
}
async function adopt() {
  if (busy.value || phase.value || !['comparing', 'prepared'].includes(session.value?.state)) return
  clearTimeout(timer)
  phase.value = 'requesting'
  error.value = ''
  try {
    const id = session.value.id
    accept(await prepareAndCommit(session.value, context.value, (body) => imageEditAPI.adopt(id, body), accept))
    phase.value = recoveryPhase(session.value)
    await finishSync()
  } catch (e) { reconcile(e) }
}
function reset() {
  clearTimeout(timer)
  epoch++
  visible.value = false
  session.value = null
  context.value = null
  phase.value = ''
}
async function requestClose() {
  if (!visible.value) return true
  if (busy.value) { ElMessage.warning('正在处理图片，请等待完成或状态核对结束'); return false }
  let protectedResult = phase.value === 'uncertain' || !!session.value?.receipt
  if (protectedResult || dirty.value) {
    try {
      await ElMessageBox.confirm(protectedResult
        ? '关闭不会撤销已提交的采用，也不会删除状态未确认的文件。来源可能尚未同步，确定关闭？'
        : '放弃本次编辑？未采用的结果将不再保留。', '关闭图片编辑', {
        confirmButtonText: protectedResult ? '保留结果并关闭' : '放弃并关闭', cancelButtonText: '继续编辑', type: 'warning'
      })
    } catch { return false }
  }
  if (busy.value) return false
  protectedResult = phase.value === 'uncertain' || !!session.value?.receipt
  // Unknown/committed states must never enter a destructive discard path.
  if (!protectedResult && session.value && !['expired', 'discarded'].includes(session.value.state)) {
    clearTimeout(timer)
    phase.value = 'closing'
    try {
      const next = await imageEditAPI.discard(session.value.id)
      if (next.receipt) {
        accept(next)
        phase.value = 'sync_pending'
        error.value = '服务端已经采用，未执行放弃。请同步来源或保留结果关闭。'
        return false
      }
    } catch (e) { reconcile(e); return false }
  }
  reset()
  return true
}
function recheck() {
  if (busy.value || !session.value) return
  reconcile()
}
function beforeUnload(event) {
  if (visible.value && (busy.value || dirty.value || phase.value)) {
    event.preventDefault()
    event.returnValue = ''
  }
}
export function useImageEditor() {
  return { visible, context, session, prompt, selected, comparing, phase, error, busy, dirty, open, generate, back, continueEditing, adopt, finishSync, requestClose, recheck, beforeUnload }
}
