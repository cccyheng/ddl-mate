/** 网页端用到的设置键（与手机端 app_settings 的键名一致，后端白名单见 SettingsService）。 */
export const SETTING_KEYS = {
  TASK_TEMPLATES: 'task_templates.v1',
  TASK_RECURRENCE: 'task_recurrence.v1',
  TODAY_PLAN: 'daily_plan.today',
  STUDY_REFERENCE: 'pressure.daily_study_reference_minutes',
  EXAM_REVISION: 'exam_revision.v1',
  CLASS_REMINDER: 'class_reminder.v1',
  SEMESTER_START_MONDAY: 'teaching_week.semester_start_monday',
  CALIBRATED_WEEK: 'teaching_week.calibrated_week',
  CALIBRATED_TODAY: 'teaching_week.calibrated_today',
  CALIBRATED_AT: 'teaching_week.calibrated_at',
  taskSteps: (taskId) => `task_steps.${taskId}`,
  taskReminder: (taskId) => `task_reminder.${taskId}`,
}
