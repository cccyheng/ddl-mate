/** 反馈角色与未读数：侧栏的红点和反馈页共用。 */
import { reactive } from 'vue'
import { feedbackApi } from '@/api'

export const feedbackState = reactive({ admin: false, unread: 0, resetPending: 0 })

export async function refreshFeedbackRole() {
  try {
    const role = await feedbackApi.role()
    feedbackState.admin = Boolean(role.admin)
    feedbackState.unread = Number(role.unread) || 0
    feedbackState.resetPending = Number(role.resetPending) || 0
  } catch {
    feedbackState.admin = false
    feedbackState.unread = 0
    feedbackState.resetPending = 0
  }
}
