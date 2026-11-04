/** 领域错误：携带可直接展示给用户的中文说明与字段名（表单可定位到具体输入框）。 */

export type FieldErrors = Record<string, string>

export class ValidationError extends Error {
  override readonly name = 'ValidationError'
  readonly fields: FieldErrors

  constructor(message: string, fields: FieldErrors = {}) {
    super(message)
    this.fields = fields
  }
}

/** 课程仍被任务/课表引用时的删除保护。 */
export class CourseInUseError extends Error {
  override readonly name = 'CourseInUseError'
  readonly courseId: number
  readonly taskCount: number
  readonly scheduleCount: number

  constructor(courseId: number, taskCount: number, scheduleCount: number) {
    super(
      `课程仍被 ${taskCount} 个任务、${scheduleCount} 条课表引用。` +
        `确认继续只会删除课表，任务会保留但变为“未关联课程”。`,
    )
    this.courseId = courseId
    this.taskCount = taskCount
    this.scheduleCount = scheduleCount
  }
}

/** 目标记录不存在。 */
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError'
  constructor(message: string) {
    super(message)
  }
}

/** 课表时间/星期冲突（同一门课同一时段重复）。 */
export class ScheduleConflictError extends Error {
  override readonly name = 'ScheduleConflictError'
  constructor(message: string) {
    super(message)
  }
}
