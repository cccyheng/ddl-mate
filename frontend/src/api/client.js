/**
 * 统一的 API 请求封装。
 *
 * - 所有请求走相对路径 /api，开发时由 Vite 代理到后端 8080，构建后由后端同源托管
 * - 后端错误统一是 { status, code, message, fieldErrors }，这里转成 ApiError 抛出
 * - 网络不通、后端没启动时给出可读的中文提示
 */

const BASE = '/api'

export class ApiError extends Error {
  constructor({ status, code, message, fieldErrors, path }) {
    super(message || '请求失败')
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.fieldErrors = fieldErrors || []
    this.path = path
  }

  get isNotFound() {
    return this.status === 404
  }

  /** 把 fieldErrors 转成 { 字段: 提示 } 便于表单展示。 */
  fieldErrorMap() {
    const map = {}
    for (const item of this.fieldErrors) {
      if (!map[item.field]) map[item.field] = item.message
    }
    return map
  }
}

function buildQuery(params) {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.append(key, value)
  }
  const query = search.toString()
  return query ? `?${query}` : ''
}

async function request(method, path, { body, params, formData, signal } = {}) {
  const url = `${BASE}${path}${buildQuery(params)}`
  const options = { method, signal, headers: {} }

  if (formData) {
    options.body = formData
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }

  let response
  try {
    response = await fetch(url, options)
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new ApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      message: '无法连接后端服务，请确认后端已在 127.0.0.1:8080 启动',
    })
  }

  if (response.status === 204) return null

  const contentType = response.headers.get('content-type') || ''
  const isJson = contentType.includes('application/json')
  const payload = isJson ? await response.json().catch(() => null) : null

  if (!response.ok) {
    if (payload) {
      throw new ApiError(payload)
    }
    throw new ApiError({
      status: response.status,
      code: 'HTTP_ERROR',
      message: `请求失败（HTTP ${response.status}）`,
    })
  }

  return isJson ? payload : response
}

export const http = {
  get: (path, params, options) => request('GET', path, { params, ...options }),
  post: (path, body, options) => request('POST', path, { body, ...options }),
  put: (path, body, options) => request('PUT', path, { body, ...options }),
  patch: (path, body, options) => request('PATCH', path, { body, ...options }),
  del: (path, params, options) => request('DELETE', path, { params, ...options }),
  upload: (path, formData, options) => request('POST', path, { formData, ...options }),
}

/** 下载/构建附件地址（直接给 <img> 或 <a> 用）。 */
export function attachmentUrl(id, download = false) {
  return `${BASE}/attachments/${id}${download ? '?download=true' : ''}`
}
