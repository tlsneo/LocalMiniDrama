import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ref, computed, watch } from 'vue'

const source = readFileSync(new URL('../src/components/AIConfigContent.vue', import.meta.url), 'utf8')
// Exercise the existing form handlers without adding a component-testing framework.
function component(aiAPI = {}) {
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*$/gm, '')
  return new Function('ref', 'computed', 'watch', 'onMounted', 'aiAPI', 'ElMessage', `${script}
    return { form, formRef, editingId, saving, list, onServiceTypeChange, onProviderChange,
      availableProviderOptions, availableModels, endpointPreviewInfo, rules, getBaseUrlForProvider,
      submit, openEdit, importConfigs, serviceTypeLabel }
  `)(ref, computed, watch, () => {}, aiAPI, { success() {}, error() {}, warning() {} })
}

test('editing type clears generation defaults and never infers protocols, models or URLs', () => {
  const ui = component()
  Object.assign(ui.form.value, {
    service_type: 'image_edit', provider: 'gemini', api_protocol: 'gemini',
    base_url: 'https://old.invalid', api_key: 'old-key', endpoint: '/generate', query_endpoint: '/tasks',
    modelText: 'old-model', default_model: 'old-model', kling_access_key: 'old-ak', voice_id: 'old-voice',
  })
  ui.onServiceTypeChange()
  for (const key of ['provider', 'api_protocol', 'base_url', 'api_key', 'endpoint', 'query_endpoint', 'modelText', 'default_model', 'kling_access_key', 'voice_id']) {
    assert.equal(ui.form.value[key], '', key)
  }
  assert.deepEqual(ui.availableProviderOptions.value.map((p) => p.id), ['__custom__'])
  ui.form.value.provider = 'gemini'
  ui.onProviderChange('gemini')
  assert.equal(ui.form.value.base_url, '')
  assert.equal(ui.form.value.api_protocol, '')
  assert.deepEqual(ui.availableModels.value, [])
  assert.equal(ui.endpointPreviewInfo.value, null)
  assert.equal(ui.getBaseUrlForProvider('gemini'), '')
  assert.equal(ui.serviceTypeLabel('image_edit'), '图片编辑')
  assert.match(source, /v-model="form.service_type" :disabled="!!editingId"/)
})

test('editing auth is optional; legacy validation is preserved and failed validation stops submission', async () => {
  let writes = 0
  const ui = component({ create: async () => { writes++ }, update: async () => { writes++ } })
  ui.form.value.service_type = 'image_edit'
  assert.equal(ui.rules.value.base_url[0].required, false)
  let error
  ui.rules.value.api_key[0].validator(null, '', (e) => { error = e })
  assert.equal(error, undefined)
  ui.form.value.service_type = 'image'
  assert.equal(ui.rules.value.base_url[0].required, true)
  ui.rules.value.api_key[0].validator(null, '', (e) => { error = e })
  assert.ok(error instanceof Error)
  for (const validate of [async () => false, async () => { throw new Error('invalid') }]) {
    ui.formRef.value = { validate }
    await ui.submit()
    assert.equal(writes, 0)
    assert.equal(ui.saving.value, false)
  }
})

test('editing imports preserve protocol/settings and later form saves do not replace them', async () => {
  const imported = {
    service_type: 'image_edit', name: 'Draft', provider: 'custom', api_protocol: 'future-protocol',
    model: ['custom-model'], endpoint: '/user-supplied', query_endpoint: '/user-query',
    settings: '{"vendor_setting":"preserved"}',
  }
  let created, updated
  const ui = component({
    create: async (body) => { created = body },
    update: async (id, body) => { updated = body },
    list: async () => [{ ...imported, id: 10 }],
  })
  await ui.importConfigs({ target: { files: [{ text: async () => JSON.stringify([imported]) }], value: 'file' } })
  for (const key of Object.keys(imported)) assert.deepEqual(created[key], imported[key], key)
  ui.openEdit({ ...imported, id: 10 })
  ui.formRef.value = { validate: async () => true }
  await ui.submit()
  assert.equal(updated.service_type, 'image_edit')
  assert.equal(updated.api_protocol, imported.api_protocol)
  assert.equal(updated.endpoint, imported.endpoint)
  assert.equal(updated.query_endpoint, imported.query_endpoint)
  assert.equal(Object.hasOwn(updated, 'settings'), false, 'omitted settings are preserved by updateConfig')
})
