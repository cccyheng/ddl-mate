<script setup>
/**
 * 任务详情里的「联动」卡：开始专注 / 累计专注、截止提醒、今日计划里的时间块、考试与复习的互相跳转。
 * 每一块独立读取，读不到只隐藏那一块，不影响详情页本身。
 */
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { decodeFocus, FOCUS_KEY, formatFocusDuration } from '@domain/focusTime'
import { historyLabel } from '@domain/focusHistory'
import { decodeExamRevisionStore } from '@domain/examRevisionRepository'
import {
  decodeTaskReminder,
  evaluateTaskReminderEligibility,
  formatReminderMoment,
  REMINDER_LEAD_OPTIONS,
} from '@domain/taskReminder'
import { isPlanForToday } from '@domain/todayPlan'
import { parseTodayPlanPayload } from '@domain/todayPlanRepository'
import AppIcon from '@/components/AppIcon.vue'
import { settingsApi, taskApi } from '@/api'
import { toDomainTask } from '@/domain/mappers'
import { SETTING_KEYS } from '@/domain/settingKeys'
import { focusForTask, focusRouteFor, revisionPlanOf, revisionProgress } from '@/domain/links'
import { saveTaskReminder } from '@/domain/reminderStore'

const props = defineProps({ task: { type: Object, required: true } })

const focusStore = ref(null)
const reminder = ref(null) // { revision, intent }
const reminderError = ref('')
const plan = ref(null)
const plans = ref([])
const revisionTasks = ref(new Map())

const domainTask = computed(() => toDomainTask(props.task))
const active = computed(() => props.task.status === 'TODO' || props.task.status === 'DOING')
const focus = computed(() => focusForTask(focusStore.value, props.task))
const lead = computed(() => (reminder.value?.intent?.enabled ? reminder.value.intent.leadMinutes : 0))
const reminderStatus = computed(() => {
  if (!lead.value) return null
  const check = evaluateTaskReminderEligibility(domainTask.value, lead.value, Date.now())
  return check.eligible ? `将在 ${formatReminderMoment(check.triggerAtMs)} 提醒（页面开着时）` : check.reason
})
const planBlocks = computed(() => plan.value?.blocks.filter((b) => b.taskId === props.task.id) ?? [])
const parentExam = computed(() => revisionPlanOf(plans.value, props.task.id))
const examProgress = computed(() =>
  props.task.type === 'EXAM' ? revisionProgress(plans.value, props.task.id, revisionTasks.value) : null,
)

async function setLead(value) {
  reminderError.value = ''
  const next = Number(value)
  if (next) {
    const check = evaluateTaskReminderEligibility(domainTask.value, next, Date.now())
    if (!check.eligible) {
      reminderError.value = check.reason
      return
    }
  }
  try {
    reminder.value = await saveTaskReminder(props.task.id, next, reminder.value)
  } catch (err) {
    reminderError.value = err.message
  }
}

onMounted(async () => {
  const [focusRes, reminderRes, planRes, examRes] = await Promise.allSettled([
    settingsApi.get(FOCUS_KEY),
    settingsApi.get(SETTING_KEYS.taskReminder(props.task.id)),
    settingsApi.get(SETTING_KEYS.TODAY_PLAN),
    settingsApi.get(SETTING_KEYS.EXAM_REVISION),
  ])
  if (focusRes.status === 'fulfilled') {
    try {
      focusStore.value = decodeFocus(focusRes.value.value ?? null)
    } catch {
      focusStore.value = null
    }
  }
  if (reminderRes.status === 'fulfilled' && reminderRes.value.value) {
    const decoded = decodeTaskReminder(reminderRes.value.value, props.task.id)
    if (decoded.ok) reminder.value = { revision: reminderRes.value.revision, intent: decoded.intent }
  } else if (reminderRes.status === 'fulfilled') {
    reminder.value = null
  }
  if (planRes.status === 'fulfilled' && planRes.value.value) {
    const parsed = parseTodayPlanPayload(planRes.value.value)
    plan.value = parsed && isPlanForToday(parsed.plan.date, new Date()) ? parsed.plan : null
  }
  if (examRes.status === 'fulfilled') {
    try {
      plans.value = decodeExamRevisionStore(examRes.value.value ?? null).plans
    } catch {
      plans.value = []
    }
    if (props.task.type === 'EXAM') {
      const ids = plans.value.filter((p) => p.examId === props.task.id).flatMap((p) => p.taskIds)
      const found = await Promise.all(ids.map((id) => taskApi.get(id).catch(() => null)))
      revisionTasks.value = new Map(found.filter(Boolean).map((t) => [t.id, t]))
    }
  }
})
</script>

<template>
  <section class="card links-card">
    <div class="links-grid">
      <div class="links-cell">
        <span class="section-title"><AppIcon name="timer" :size="14" /> 专注</span>
        <strong class="links-value">{{ focus.count ? formatFocusDuration(focus.ms).slice(0, 5) : '还没有' }}</strong>
        <span class="small muted">
          <template v-if="focus.count">{{ focus.count }} 次 · 最近 {{ historyLabel(focus.lastEndedAt).slice(5, 16) }}</template>
          <template v-else>按任务名匹配专注记录</template>
        </span>
        <RouterLink v-if="active" class="btn btn--sm btn--primary" :to="focusRouteFor(task.id)">
          <AppIcon name="play" :size="14" />开始专注
        </RouterLink>
      </div>

      <div class="links-cell">
        <span class="section-title"><AppIcon name="bell" :size="14" /> 截止提醒</span>
        <select :value="lead" aria-label="截止提醒" :disabled="!active || !task.deadline" @change="setLead($event.target.value)">
          <option :value="0">不提醒</option>
          <option v-for="option in REMINDER_LEAD_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <span v-if="reminderError" class="field__error">{{ reminderError }}</span>
        <span v-else-if="reminderStatus" class="small muted">{{ reminderStatus }}</span>
        <span v-else-if="!task.deadline" class="small muted">设置截止时间后才能提醒</span>
      </div>

      <div v-if="planBlocks.length" class="links-cell">
        <span class="section-title"><AppIcon name="target" :size="14" /> 今日计划</span>
        <div v-for="block in planBlocks" :key="block.startMinute" class="row small">
          <span class="mono">{{ block.startTime }}–{{ block.endTime }}</span>
          <RouterLink v-if="active" class="btn btn--sm" :to="focusRouteFor(task.id, block.minutes)">专注 {{ block.minutes }} 分钟</RouterLink>
        </div>
      </div>

      <div v-if="examProgress" class="links-cell">
        <span class="section-title"><AppIcon name="exam" :size="14" /> 复习进度</span>
        <template v-if="examProgress.total">
          <strong class="links-value">{{ examProgress.done }}/{{ examProgress.total }}</strong>
          <span class="progress"><span class="progress__bar" :style="{ width: `${(examProgress.done / examProgress.total) * 100}%` }" /></span>
        </template>
        <span v-else class="small muted">还没有复习安排</span>
        <RouterLink class="small" to="/exams">去安排复习</RouterLink>
      </div>

      <div v-if="parentExam" class="links-cell">
        <span class="section-title"><AppIcon name="exam" :size="14" /> 所属考试</span>
        <RouterLink :to="`/tasks/${parentExam.examId}`" class="links-value">{{ parentExam.examTitle }}</RouterLink>
        <span class="small muted">这是为该考试生成的复习任务</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.links-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 18px;
}

.links-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.links-cell .section-title {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0;
}

.links-cell .progress {
  width: 100%;
}

.links-value {
  font-size: 1.15rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
</style>
