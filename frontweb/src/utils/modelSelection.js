export function parseModelList(models, defaultModel = '') {
  if (Array.isArray(models)) {
    return models.map((m) => String(m).trim()).filter(Boolean)
  }
  if (typeof models === 'string') {
    return models.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean)
  }
  return defaultModel ? [String(defaultModel).trim()].filter(Boolean) : []
}

export function getSelectableModels(configs, serviceType, configId) {
  const list = (Array.isArray(configs) ? configs : [])
    .filter((c) => c.service_type === serviceType && c.is_active)
  const config = configId != null && configId !== ''
    ? list.find((c) => c.id === configId)
    : list.find((c) => c.is_default) || list[0]

  if (!config) return []
  return parseModelList(config.model, config.default_model)
}
