/** 网页 API 数据 → @domain 规则模块的数据形状（纯函数，无网络依赖，可在 Node 测试里直接用）。 */

export function toDomainTask(task) {
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? null,
    courseId: task.course?.id ?? null,
    type: task.type,
    // 网页的「已归档」在规则模块里等同手机端的「已取消」：都不再计入压力、计划与提醒
    status: task.status === 'ARCHIVED' ? 'CANCELLED' : task.status,
    priority: task.priority,
    deadline: task.deadline ?? null,
    estimatedMinutes: task.estimatedMinutes ?? null,
    submitRequirement: task.submitRequirement ?? null,
    submitMethod: task.submitMethod ?? null,
    completedAt: task.completedAt ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

export function toDomainCourse(course) {
  return {
    id: course.id,
    code: course.code ?? '',
    name: course.name,
    instructor: course.instructor ?? null,
    semester: course.semester ?? null,
    color: course.color ?? null,
    note: course.note ?? null,
    createdAt: course.createdAt,
    updatedAt: course.updatedAt,
  }
}

/** 网页接口的时刻是 `HH:mm:ss`，规则模块要 `HH:mm`。 */
const clock = (value) => (typeof value === 'string' ? value.slice(0, 5) : value)

export function toDomainSchedule(schedule) {
  return {
    id: schedule.id,
    courseId: schedule.courseId,
    weekday: schedule.weekday,
    startTime: clock(schedule.startTime),
    endTime: clock(schedule.endTime),
    location: schedule.location ?? null,
    periodStart: schedule.periodStart ?? null,
    periodEnd: schedule.periodEnd ?? null,
    weekRange: schedule.weekRange ?? null,
    semesterStartDate: schedule.semesterStartDate ?? null,
    startWeek: schedule.startWeek ?? null,
    endWeek: schedule.endWeek ?? null,
    weekPattern: schedule.weekPattern ?? 'ALL',
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  }
}
