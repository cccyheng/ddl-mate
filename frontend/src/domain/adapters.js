/**
 * 网页 API 数据 → 手机端共享规则模块（@domain）使用的数据形状。
 *
 * 两端字段名本来就一致（camelCase、deadline 带 +08:00 偏移），差别只有：
 * - 网页任务带的是 `course` 简要对象，规则模块要 `courseId`；
 * - 列表接口分页，这里一次取齐（每页上限 200）。
 */
import { courseApi, scheduleApi, taskApi } from '@/api'

export { toDomainCourse, toDomainSchedule, toDomainTask } from './mappers'

const PAGE_SIZE = 200

/** 全部任务（含已完成 / 已取消），按 id 升序。 */
export async function loadAllTasks() {
  const all = []
  for (let page = 0; page < 100; page += 1) {
    const result = await taskApi.list({ includeDone: true, page, size: PAGE_SIZE })
    all.push(...result.content)
    if (page + 1 >= result.totalPages) break
  }
  return all.sort((a, b) => a.id - b.id)
}

export async function loadAllCourses() {
  return courseApi.list()
}

/** 全部课表行（原始网页形状，带 courseName / courseColor），供今日计划 / 冲突检查使用。 */
export async function loadAllSchedules(courses) {
  const lists = await Promise.all(courses.map((course) => scheduleApi.listByCourse(course.id)))
  return lists.flat()
}
