import request from '@/utils/request'

const options = { timeout: 15000 }
const path = (id) => `/image-edits/${encodeURIComponent(id)}`
export const imageEditAPI = {
  create: (body) => request.post('/image-edits', body, options),
  get: (id) => request.get(path(id), { timeout: 10000 }),
  generate(id, body) {
    const form = new FormData()
    for (const [key, value] of Object.entries(body)) {
      if (value != null) {
        if (key === 'mask') form.append(key, value, 'mask.png')
        else form.append(key, String(value))
      }
    }
    return request.post(`${path(id)}/generate`, form, { ...options, headers: { 'Content-Type': undefined } })
  },
  continue: (id, body) => request.post(`${path(id)}/continue`, body, options),
  adopt: (id, body) => request.post(`${path(id)}/adopt`, body, options),
  finish: (id) => request.post(`${path(id)}/finish`, {}, options),
  discard: (id) => request.delete(path(id), options)
}
