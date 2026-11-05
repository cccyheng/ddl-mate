import { http, attachmentUrl } from './client'

export { attachmentUrl }
// 组件里需要 `err instanceof ApiError` 判断错误类型（例如课程删除 409 的二次确认）
export { ApiError } from './client'

export const metaApi = {
  enums: () => http.get('/meta/enums'),
  /** 附件与批量导入的真实上限（图片大小 / 张数 / 来源数 / 候选数）。 */
  storageLimits: () => http.get('/meta/storage-limits'),
};

/** 单人登录（只在服务器版启用；本机版 me() 恒为已登录）。 */
export const authApi = {
  me: () => http.get('/auth/me'),
  login: (username, password) => http.post('/auth/login', { username, password }),
  logout: () => http.post('/auth/logout'),
  setup: (token, password) => http.post('/auth/setup', { token, password }),
  register: (username, password, displayName) => http.post('/auth/register', { username, password, displayName }),
}

export const profileApi = {
  get: () => http.get('/profile'),
  update: (displayName) => http.put('/profile', { displayName }),
}

export const courseApi = {
  list: (keyword) => http.get('/courses', { keyword }),
  get: (id) => http.get(`/courses/${id}`),
  create: (payload) => http.post('/courses', payload),
  update: (id, payload) => http.put(`/courses/${id}`, payload),
  remove: (id, force = false) => http.del(`/courses/${id}`, { force }),
}

export const scheduleApi = {
  list: (weekday, date) => http.get('/schedules', { weekday, date }),
  today: () => http.get('/schedules/today'),
  byDate: (date) => http.get('/schedules/by-date', { date }),
  importBatch: (payload) => http.post('/schedules/import', payload),
  listByCourse: (courseId) => http.get(`/courses/${courseId}/schedules`),
  create: (courseId, payload) => http.post(`/courses/${courseId}/schedules`, payload),
  update: (courseId, scheduleId, payload) =>
    http.put(`/courses/${courseId}/schedules/${scheduleId}`, payload),
  remove: (courseId, scheduleId) => http.del(`/courses/${courseId}/schedules/${scheduleId}`),
}

/** 月历：一次拿到当月每天的课程与任务 DDL。 */
export const calendarApi = {
  month: (year, month) => http.get('/calendar', { year, month }),
}

export const taskApi = {
  list: (params) => http.get('/tasks', params),
  deadlines: (params) => http.get('/tasks/deadlines', params),
  today: () => http.get('/tasks/today'),
  calendar: (year, month) => http.get('/tasks/calendar', { year, month }),
  byDate: (date) => http.get('/tasks/by-date', { date }),
  stats: () => http.get('/tasks/stats'),
  get: (id) => http.get(`/tasks/${id}`),
  create: (payload) => http.post('/tasks', payload),
  update: (id, payload) => http.put(`/tasks/${id}`, payload),
  patch: (id, payload) => http.patch(`/tasks/${id}`, payload),
  changeStatus: (id, status) => http.patch(`/tasks/${id}/status`, { status }),
  remove: (id) => http.del(`/tasks/${id}`),

  /**
   * V1.2 时间助手：简短时间短语 → 明确时间（可选结合课程课表）。
   * 只读接口：不会创建 / 修改任何数据；只有用户显式「采用」后前端才改表单或候选。
   */
  resolveTime: (payload) => http.post('/tasks/resolve-time', payload),

  /**
   * 「通知 → 待办」批量导入（multipart）。
   * `notice` 是 JSON 部分，`files` 可重复出现且顺序必须与 JSON 里的 fileIndex 一致；
   * 表单由 importPayload.js 的 toFormData 组装，保证与本地测试用同一套顺序。
   */
  importNotices: (formData, options) => http.upload('/tasks/import-notices', formData, options),
}

/**
 * 键值设置（专注记录、今日计划、模板、复习安排……）。取值是与手机端相同格式的字符串，
 * 写入必须带读到的 revision；被别处改过会得到 409 SETTING_CONFLICT。
 */
/** 问题反馈：用户提交 / 看自己的；站长看全部、处理、回复。 */
export const feedbackApi = {
  submit: (payload) => http.post('/feedback', payload),
  mine: () => http.get('/feedback/mine'),
  role: () => http.get('/feedback/role'),
  all: (status) => http.get('/admin/feedback', { status }),
  update: (id, payload) => http.patch(`/admin/feedback/${id}`, payload),
}

export const settingsApi = {
  get: (key) => http.get(`/settings/${encodeURIComponent(key)}`),
  listByPrefix: (prefix) => http.get('/settings', { prefix }),
  put: (key, value, expectedRevision) =>
    http.put(`/settings/${encodeURIComponent(key)}`, { value, expectedRevision }),
  remove: (key) => http.del(`/settings/${encodeURIComponent(key)}`),
}

/** 整库备份：导出 JSON → 预览（只读校验）→ 确认后整体替换恢复。 */
export const backupApi = {
  export: () => http.get('/backup/export'),
  preview: (backup) => http.post('/backup/preview', backup),
  restore: (backup) => http.post('/backup/restore', backup),
}

export const sourceApi = {
  listByTask: (taskId) => http.get(`/tasks/${taskId}/sources`),
  list: () => http.get('/sources'),
  create: (taskId, payload) => http.post(`/tasks/${taskId}/sources`, payload),
  get: (id) => http.get(`/sources/${id}`),
  remove: (id) => http.del(`/sources/${id}`),
  upload: (id, files) => {
    const formData = new FormData()
    for (const file of files) formData.append('file', file)
    return http.upload(`/sources/${id}/attachments`, formData)
  },
  removeAttachment: (id) => http.del(`/attachments/${id}`),
}
