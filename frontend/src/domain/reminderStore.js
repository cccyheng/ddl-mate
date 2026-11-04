import { encodeTaskReminder, TASK_REMINDER_VERSION } from '@domain/taskReminder'
import { settingsApi } from '@/api'
import { SETTING_KEYS } from '@/domain/settingKeys'

/**
 * 保存一条任务的截止提醒（lead = 0 表示关闭）。
 * `current` 是 `{ revision, intent }`（从未设置过传 null）；返回新的 `{ revision, intent }`。
 */
export async function saveTaskReminder(taskId, lead, current) {
  const intent = {
    version: TASK_REMINDER_VERSION,
    taskId,
    enabled: lead > 0,
    leadMinutes: lead || current?.intent?.leadMinutes || 30,
    revision: (current?.intent?.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  }
  const saved = await settingsApi.put(SETTING_KEYS.taskReminder(taskId), encodeTaskReminder(intent), current?.revision ?? 0)
  window.dispatchEvent(new Event('ddlmate:reminders-changed'))
  return { revision: saved.revision, intent }
}
