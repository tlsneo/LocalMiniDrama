import test from 'node:test'
import assert from 'node:assert/strict'

import { getSelectableModels } from '../src/utils/modelSelection.js'

const configs = [
  {
    id: 1,
    service_type: 'text',
    is_active: true,
    is_default: true,
    model: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    default_model: 'deepseek-v4-flash',
  },
  {
    id: 2,
    service_type: 'text',
    is_active: true,
    is_default: false,
    model: ['qwen-plus'],
    default_model: 'qwen-plus',
  },
]

test('uses default active config models when no config is selected', () => {
  assert.deepEqual(getSelectableModels(configs, 'text', null), [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
  ])
})

test('uses selected config models when config is selected', () => {
  assert.deepEqual(getSelectableModels(configs, 'text', 2), ['qwen-plus'])
})

test('image editing models stay isolated from generation and inactive configurations', () => {
  const images = [
    { id: 3, service_type: 'image', is_active: true, is_default: true, model: ['generation'] },
    { id: 4, service_type: 'storyboard_image', is_active: true, is_default: true, model: ['storyboard'] },
    { id: 5, service_type: 'image_edit', is_active: false, is_default: true, model: ['inactive'] },
    { id: 6, service_type: 'image_edit', is_active: true, is_default: true, model: ['custom-edit'] },
    { id: 7, service_type: 'image_edit', is_active: true, model: 'another-edit' },
  ]
  assert.deepEqual(getSelectableModels(images, 'image_edit'), ['custom-edit'])
  assert.deepEqual(getSelectableModels(images, 'image_edit', 7), ['another-edit'])
  for (const id of [3, 4, 5, 99, 0]) {
    assert.deepEqual(getSelectableModels(images, 'image_edit', id), [], `reject config ${id}`)
  }
  assert.deepEqual(getSelectableModels(images, 'image', 6), [])
  assert.deepEqual(getSelectableModels(images, 'storyboard_image', 6), [])
  assert.deepEqual(getSelectableModels(images.slice(0, 3), 'image_edit'), [])
  assert.deepEqual(getSelectableModels(null, 'image_edit'), [])
})
