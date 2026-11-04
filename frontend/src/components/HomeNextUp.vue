<script setup>
/**
 * 首页「接下来」：把最近的一节课、下一个计划时间块、最近的 DDL 串成一张卡，每项都能直接去做。
 * 各项独立读取，读不到的那一项不显示。
 */
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { isPlanForToday, shanghaiMinuteOfDay } from '@domain/todayPlan'
import { parseTodayPlanPayload } from '@domain/todayPlanRepository'
import AppIcon from '@/components/AppIcon.vue'
import { scheduleApi, settingsApi, taskApi } from '@/api'
import { focusRouteFor } from '@/domain/links'
import { SETTING_KEYS } from '@/domain/settingKeys'
import { dateKeyOf, shiftDateKey } from '@/utils/dateKeys'
import { remainingLabel } from '@/utils/datetime'

const nextClass = ref(null)
const nextBlock = ref(null)
const nextDeadline = ref(null)
const loaded = ref(false)

const clockMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}

const empty = computed(() => loaded.value && !nextClass.value && !nextBlock.value && !nextDeadline.value)

onMounted(async () => {
  const nowMinute = shanghaiMinuteOfDay(new Date())?.minute ?? 0
  const today = dateKeyOf(Date.now())
  const tomorrow = shiftDateKey(today, 1)
  const [todayClasses, tomorrowClasses, planRow, deadlines] = await Promise.allSettled([
    scheduleApi.today(),
    scheduleApi.byDate(tomorrow),
    settingsApi.get(SETTING_KEYS.TODAY_PLAN),
    taskApi.deadlines({ sort: 'deadline' }),
  ])

  if (todayClasses.status === 'fulfilled') {
    const upcoming = todayClasses.value
      .filter((s) => clockMinutes(s.endTime) > nowMinute)
      .sort((a, b) => a.startTime.localeCompare(b.startTime))[0]
    if (upcoming) nextClass.value = { ...upcoming, when: clockMinutes(upcoming.startTime) <= nowMinute ? '正在上' : '今天' }
  }
  if (!nextClass.value && tomorrowClasses.status === 'fulfilled') {
    const first = [...tomorrowClasses.value].sort((a, b) => a.startTime.localeCompare(b.startTime))[0]
    if (first) nextClass.value = { ...first, when: '明天' }
  }

  if (planRow.status === 'fulfilled' && planRow.value.value) {
    const parsed = parseTodayPlanPayload(planRow.value.value)
    if (parsed && isPlanForToday(parsed.plan.date, new Date())) {
      nextBlock.value = parsed.plan.blocks.find((b) => b.endMinute > nowMinute) ?? null
      if (nextBlock.value) nextBlock.value = { ...nextBlock.value, running: nextBlock.value.startMinute <= nowMinute }
    }
  }

  if (deadlines.status === 'fulfilled') {
    const now = Date.now()
    nextDeadline.value =
      deadlines.value.find(
        (t) => t.deadline && t.status !== 'DONE' && t.status !== 'ARCHIVED' && new Date(t.deadline).getTime() >= now,
      ) ?? null
  }
  loaded.value = true
})
</script>

<template>
  <section class="card next-up">
    <h2 class="section-title" style="margin-bottom: 10px">接下来</h2>
    <p v-if="!loaded" class="muted small" style="margin: 0">正在读取…</p>
    <p v-else-if="empty" class="muted small" style="margin: 0">今天和明天没有课，也没有待办截止或计划。</p>
    <div v-else class="next-up__rows">
      <div v-if="nextClass" class="next-up__row">
        <span class="next-up__icon"><AppIcon name="book" :size="18" /></span>
        <span class="next-up__main">
          <span class="next-up__label">{{ nextClass.when }} · {{ nextClass.startTime.slice(0, 5) }}–{{ nextClass.endTime.slice(0, 5) }}</span>
          <strong>{{ nextClass.courseName }}</strong>
          <span class="small muted">{{ nextClass.location || '地点未填' }}</span>
        </span>
        <RouterLink class="btn btn--sm" :to="`/courses/${nextClass.courseId}`">课程</RouterLink>
      </div>

      <div v-if="nextBlock" class="next-up__row">
        <span class="next-up__icon"><AppIcon name="target" :size="18" /></span>
        <span class="next-up__main">
          <span class="next-up__label">{{ nextBlock.running ? '计划进行中' : '下一个计划' }} · {{ nextBlock.startTime }}–{{ nextBlock.endTime }}</span>
          <strong>{{ nextBlock.taskTitle }}</strong>
          <span class="small muted">{{ nextBlock.minutes }} 分钟</span>
        </span>
        <RouterLink class="btn btn--sm btn--primary" :to="focusRouteFor(nextBlock.taskId, nextBlock.minutes)">
          <AppIcon name="play" :size="13" />专注
        </RouterLink>
      </div>
      <div v-else-if="loaded" class="next-up__row next-up__row--hint">
        <span class="next-up__icon"><AppIcon name="target" :size="18" /></span>
        <span class="next-up__main small muted">今天还没有剩余的计划时间块。</span>
        <RouterLink class="btn btn--sm" to="/plan/today">做今日计划</RouterLink>
      </div>

      <div v-if="nextDeadline" class="next-up__row">
        <span class="next-up__icon next-up__icon--clay"><AppIcon name="clock" :size="18" /></span>
        <span class="next-up__main">
          <span class="next-up__label">最近的 DDL · {{ remainingLabel(nextDeadline.deadline).text }}</span>
          <RouterLink :to="`/tasks/${nextDeadline.id}`" class="next-up__title">{{ nextDeadline.title }}</RouterLink>
          <span class="small muted">{{ nextDeadline.course?.name || '未关联课程' }}</span>
        </span>
        <RouterLink class="btn btn--sm" :to="focusRouteFor(nextDeadline.id, nextDeadline.estimatedMinutes)">
          <AppIcon name="play" :size="13" />专注
        </RouterLink>
      </div>
    </div>
  </section>
</template>

<style scoped>
.next-up {
  margin-bottom: 20px;
}

.next-up__rows {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}

.next-up__row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: var(--radius);
  background: var(--surface-soft);
  border: 1px solid var(--border);
  min-width: 0;
}

.next-up__row--hint {
  border-style: dashed;
}

.next-up__icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 11px;
  background: var(--primary-soft);
  color: var(--primary);
}

.next-up__icon--clay {
  background: var(--clay-soft);
  color: var(--clay);
}

.next-up__main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.next-up__label {
  color: var(--text-muted);
  font-size: 0.78rem;
}

.next-up__title {
  font-weight: 700;
  color: var(--text);
}
</style>
