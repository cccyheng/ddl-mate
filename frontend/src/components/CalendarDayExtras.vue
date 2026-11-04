<script setup>
/** 日历日期详情的补充：这一天的专注记录与时长、（今天的）计划时间块、当天的考试与提醒。 */
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { decodeFocus, FOCUS_KEY, focusDayStart, focusTotal, formatFocusDuration } from '@domain/focusTime'
import { historyLabel } from '@domain/focusHistory'
import { decodeTaskReminder, evaluateTaskReminderEligibility, formatReminderMoment } from '@domain/taskReminder'
import { parseTodayPlanPayload } from '@domain/todayPlanRepository'
import AppIcon from '@/components/AppIcon.vue'
import { settingsApi, taskApi } from '@/api'
import { toDomainTask } from '@/domain/mappers'
import { SETTING_KEYS } from '@/domain/settingKeys'
import { dateKeyOf } from '@/utils/dateKeys'

const props = defineProps({ dateKey: { type: String, required: true } })

const focusMs = ref(0)
const records = ref([])
const blocks = ref([])
const exams = ref([])
const reminders = ref([])
const loaded = ref(false)

const isToday = computed(() => props.dateKey === dateKeyOf(Date.now()))

onMounted(async () => {
  const start = focusDayStart(props.dateKey)
  const end = start + 86400000
  const [focusRow, planRow, dayTasks, reminderRows] = await Promise.allSettled([
    settingsApi.get(FOCUS_KEY),
    settingsApi.get(SETTING_KEYS.TODAY_PLAN),
    taskApi.byDate(props.dateKey),
    settingsApi.listByPrefix('task_reminder.'),
  ])
  if (focusRow.status === 'fulfilled') {
    try {
      const store = decodeFocus(focusRow.value.value ?? null)
      focusMs.value = focusTotal(store, start, end, Date.now())
      records.value = store.records.filter((r) => r.startedAt < end && r.endedAt > start)
    } catch {
      records.value = []
    }
  }
  if (planRow.status === 'fulfilled' && planRow.value.value) {
    const parsed = parseTodayPlanPayload(planRow.value.value)
    if (parsed && parsed.plan.date === props.dateKey) blocks.value = parsed.plan.blocks
  }
  if (dayTasks.status === 'fulfilled') {
    exams.value = dayTasks.value.filter((t) => t.type === 'EXAM')
    if (reminderRows.status === 'fulfilled') {
      const byId = new Map(dayTasks.value.map((t) => [t.id, t]))
      for (const row of reminderRows.value) {
        const decoded = decodeTaskReminder(row.value)
        const task = decoded.ok && decoded.intent.enabled ? byId.get(decoded.intent.taskId) : null
        if (!task) continue
        const check = evaluateTaskReminderEligibility(toDomainTask(task), decoded.intent.leadMinutes, Date.now())
        if (check.eligible) reminders.value.push({ task, at: check.triggerAtMs })
      }
    }
  }
  loaded.value = true
})
</script>

<template>
  <section v-if="loaded" class="card day-extras">
    <div class="day-extras__grid">
      <div>
        <h2 class="section-title"><AppIcon name="timer" :size="14" /> 专注</h2>
        <strong class="day-extras__value">{{ formatFocusDuration(focusMs).slice(0, 5) }}</strong>
        <ul v-if="records.length" class="day-extras__list small">
          <li v-for="record in records" :key="record.id">
            {{ historyLabel(record.startedAt).slice(11, 16) }} {{ record.title }}
          </li>
        </ul>
        <p v-else class="muted small">这一天没有专注记录。</p>
        <RouterLink v-if="isToday" class="small" to="/focus">去专注</RouterLink>
      </div>

      <div>
        <h2 class="section-title"><AppIcon name="target" :size="14" /> 学习计划</h2>
        <ul v-if="blocks.length" class="day-extras__list small">
          <li v-for="block in blocks" :key="`${block.taskId}-${block.startMinute}`">
            <span class="mono">{{ block.startTime }}–{{ block.endTime }}</span>
            <RouterLink :to="`/tasks/${block.taskId}`">{{ block.taskTitle }}</RouterLink>
          </li>
        </ul>
        <p v-else class="muted small">{{ isToday ? '今天还没有采用计划。' : '计划只保存当天的一份。' }}</p>
        <RouterLink v-if="isToday" class="small" to="/plan/today">{{ blocks.length ? '调整计划' : '做今日计划' }}</RouterLink>
      </div>

      <div v-if="exams.length || reminders.length">
        <h2 class="section-title"><AppIcon name="bell" :size="14" /> 考试与提醒</h2>
        <ul class="day-extras__list small">
          <li v-for="exam in exams" :key="`e${exam.id}`">
            <span class="badge badge--danger">考试</span>
            <RouterLink :to="`/tasks/${exam.id}`">{{ exam.title }}</RouterLink>
          </li>
          <li v-for="item in reminders" :key="`r${item.task.id}`">
            <span class="badge badge--primary">提醒</span>
            {{ formatReminderMoment(item.at) }} · {{ item.task.title }}
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.day-extras {
  margin-top: 16px;
}

.day-extras__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 20px;
}

.day-extras .section-title {
  display: flex;
  align-items: center;
  gap: 4px;
}

.day-extras__value {
  display: block;
  font-size: 1.4rem;
  font-variant-numeric: tabular-nums;
  margin-bottom: 6px;
}

.day-extras__list {
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-wrap: anywhere;
}

.day-extras__list li {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
</style>
