/**
 * 模板与重复规则里可选的任务类型。
 *
 * 模板 / 规则以手机端格式存储（键名与 JSON 结构相同），手机端不认识网页的「实验 / 报告」、
 * 网页也没有手机端的「事务」，所以这里只提供两端都有的类型，存下来的数据两边都能读。
 */
export const SHARED_TASK_TYPES = [
  { value: 'HOMEWORK', label: '作业' },
  { value: 'PROJECT', label: '课程设计' },
  { value: 'EXAM', label: '考试' },
  { value: 'PRESENTATION', label: '展示/答辩' },
  { value: 'READING', label: '阅读' },
  { value: 'OTHER', label: '其他' },
]

export const PRIORITY_OPTIONS = [
  { value: 1, label: '最低' },
  { value: 2, label: '较低' },
  { value: 3, label: '普通' },
  { value: 4, label: '较高' },
  { value: 5, label: '紧急' },
]

/**
 * 规则模块产生的截止（北京时间墙上时间 `YYYY-MM-DDTHH:mm` 或只到日期）→ 网页接口要的带偏移时间。
 * 只到日期的按当天 23:59 截止（与手机端「当天结束前」同义）。
 */
export function deadlineForWeb(value) {
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T23:59:00+08:00`
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(value)
  if (match && !/[+-]\d{2}:?\d{2}$|Z$/.test(value)) return `${match[1]}T${match[2]}:00+08:00`
  return value
}

/** 规则模块的任务草稿 → POST /api/tasks 的请求体。 */
export function draftToTaskRequest(draft) {
  const minutes = draft.estimatedMinutes === '' ? null : Number(draft.estimatedMinutes)
  return {
    title: draft.title,
    description: draft.description || null,
    courseId: draft.courseId ?? null,
    type: draft.type,
    status: 'TODO',
    priority: draft.priority,
    deadline: deadlineForWeb(draft.deadline),
    // 网页接口的预计用时下限是 1 分钟；手机端允许的 0 在这里按「未填」处理
    estimatedMinutes: minutes && minutes > 0 ? minutes : null,
    submitRequirement: draft.submitRequirement || null,
    submitMethod: draft.submitMethod || null,
  }
}
