/**
 * 各功能之间的联动小工具（专注 ↔ 任务、提醒、复习安排 ↔ 考试、今日计划 ↔ 任务）。
 *
 * 专注记录沿用手机端格式：只保存当时的「学习内容 + 课程名」快照，不保存任务 id。
 * 所以「这条任务专注了多久」按标题 + 课程名匹配统计，页面上会写明是按名称匹配的。
 *
 * 这里只放纯函数（可在 Node 测试里直接用）；写设置的操作在 reminderStore.js。
 */
const recordMs = (record) => record.intervals.reduce((sum, i) => sum + i.end - i.start, 0)

/** 与任务同名（课程也一致或任务没有课程）的专注记录汇总。 */
export function focusForTask(store, task) {
  if (!store || !task) return { ms: 0, count: 0, lastEndedAt: null }
  const courseName = task.course?.name ?? ''
  const title = task.title.trim()
  let ms = 0
  let count = 0
  let lastEndedAt = null
  for (const record of store.records) {
    if (record.title !== title) continue
    if (courseName && record.courseName && record.courseName !== courseName) continue
    ms += recordMs(record)
    count += 1
    lastEndedAt = Math.max(lastEndedAt ?? 0, record.endedAt)
  }
  return { ms, count, lastEndedAt }
}

/** 去专注页并带上任务（以及可选的计划分钟数）。 */
export function focusRouteFor(taskId, minutes) {
  const query = { taskId: String(taskId) }
  if (minutes) query.minutes = String(minutes)
  return { name: 'focus', query }
}

/** 某个考试的复习进度：安排里的复习任务完成了几个（已删除的单独计数）。 */
export function revisionProgress(plans, examId, tasksById) {
  let total = 0
  let done = 0
  let missing = 0
  for (const plan of plans) {
    if (plan.examId !== examId) continue
    for (const id of plan.taskIds) {
      const task = tasksById.get(id)
      if (!task) {
        missing += 1
        continue
      }
      total += 1
      if (task.status === 'DONE') done += 1
    }
  }
  return { total, done, missing }
}

/** 这条任务属于哪份复习安排（返回考试 id 与标题），不属于返回 null。 */
export function revisionPlanOf(plans, taskId) {
  const plan = plans.find((p) => p.taskIds.includes(taskId))
  return plan ? { examId: plan.examId, examTitle: plan.examTitle } : null
}
