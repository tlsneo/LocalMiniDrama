// A generation model/endpoint is not an editing protocol. Do not guess a provider API.
// TODO(image-edit-api): 用户已确认暂缓真实接口对接；协议就绪后接入 edit/capabilities、
// 编辑专用连接测试及前端能力展示。清单见 docs/ai-image-edit-implementation-plan.md §12.4。
// 对接验收前保持 unavailable/503，不回退普通生图，不提供模拟成功结果。
const UNAVAILABLE = '图片编辑协议尚未对接；请等待模型后端接口就绪，不会回退为普通生图';

function capabilities() {
  return { available: false, text_edit: false, mask_edit: false, reason: UNAVAILABLE };
}

async function edit() {
  const error = new Error(UNAVAILABLE);
  error.status = 503;
  error.code = 'IMAGE_EDIT_UNAVAILABLE';
  throw error;
}

module.exports = { capabilities, edit };
