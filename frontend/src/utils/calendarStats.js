/**
 * 月历统计（纯函数，便于单测）。
 *
 * 后端月历接口会把整月**每一天**都返回（没有安排的日期是空数组），
 * 因此"有安排的天数"必须只统计课程或 DDL 非空的日期，不能直接取 days.size。
 */
export function summarizeMonth(days) {
  const entries = days instanceof Map ? [...days.values()] : Object.values(days || {})
  let taskCount = 0
  let courseCount = 0
  let activeDays = 0
  for (const entry of entries) {
    const tasks = entry?.tasks?.length || 0
    const schedules = entry?.schedules?.length || 0
    taskCount += tasks
    courseCount += schedules
    if (tasks || schedules) activeDays += 1
  }
  return { taskCount, courseCount, activeDays }
}
