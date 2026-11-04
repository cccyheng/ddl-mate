<script setup>
/**
 * 首页「学习概览」：今日专注、今日计划、7 天 DDL 压力的入口小卡。
 * 自己独立读取，读不到时只隐藏数字，不影响首页其他内容。
 */
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { analyzeDdlPressure } from '@domain/ddlPressure'
import { decodeFocus, FOCUS_KEY, focusDayStart, focusTotal, formatFocusDuration } from '@domain/focusTime'
import { readStoredStudyReferenceMinutes } from '@domain/studyReference'
import { isPlanForToday } from '@domain/todayPlan'
import { parseTodayPlanPayload } from '@domain/todayPlanRepository'
import AppIcon from '@/components/AppIcon.vue'
import { settingsApi } from '@/api'
import { loadAllTasks, toDomainTask } from '@/domain/adapters'
import { dateKeyOf } from '@/utils/dateKeys'

const focusMs = ref(null)
const focusRunning = ref(false)
const plan = ref(undefined)
const pressure = ref(null)

const planText = computed(() => {
  if (plan.value === undefined) return '—'
  if (!plan.value) return '未制定'
  return `${plan.value.blocks.length} 段 · ${plan.value.scheduledMinutes} 分钟`
})

const busiest = computed(() => {
  if (!pressure.value) return null
  return [...pressure.value.days].sort((a, b) => b.taskCount - a.taskCount)[0]
})

onMounted(async () => {
  const now = Date.now()
  const [focusRes, planRes, refRes, tasksRes] = await Promise.allSettled([
    settingsApi.get(FOCUS_KEY),
    settingsApi.get('daily_plan.today'),
    settingsApi.get('pressure.daily_study_reference_minutes'),
    loadAllTasks(),
  ])
  if (focusRes.status === 'fulfilled') {
    try {
      const store = decodeFocus(focusRes.value.value ?? null)
      const start = focusDayStart(dateKeyOf(now))
      focusMs.value = focusTotal(store, start, start + 86400000, now)
      focusRunning.value = !!store.active
    } catch {
      focusMs.value = null
    }
  }
  if (planRes.status === 'fulfilled') {
    const parsed = planRes.value.value ? parseTodayPlanPayload(planRes.value.value) : null
    plan.value = parsed && isPlanForToday(parsed.plan.date, new Date()) ? parsed.plan : null
  }
  if (tasksRes.status === 'fulfilled') {
    const referenceMinutes = refRes.status === 'fulfilled' ? readStoredStudyReferenceMinutes(refRes.value.value) : null
    pressure.value = analyzeDdlPressure({ tasks: tasksRes.value.map(toDomainTask), referenceMinutes, now: new Date() })
  }
})
</script>

<template>
  <div class="study-strip">
    <RouterLink class="study-tile card card--interactive" to="/focus">
      <span class="study-tile__icon"><AppIcon name="timer" :size="20" /></span>
      <span class="study-tile__body">
        <span class="study-tile__label">今日专注{{ focusRunning ? ' · 计时中' : '' }}</span>
        <span class="study-tile__value">{{ focusMs === null ? '—' : formatFocusDuration(focusMs).slice(0, 5) }}</span>
      </span>
    </RouterLink>
    <RouterLink class="study-tile card card--interactive" to="/plan/today">
      <span class="study-tile__icon"><AppIcon name="target" :size="20" /></span>
      <span class="study-tile__body">
        <span class="study-tile__label">今日计划</span>
        <span class="study-tile__value">{{ planText }}</span>
      </span>
    </RouterLink>
    <RouterLink class="study-tile card card--interactive" to="/plan/pressure">
      <span class="study-tile__icon"><AppIcon name="gauge" :size="20" /></span>
      <span class="study-tile__body">
        <span class="study-tile__label">7 天 DDL 压力</span>
        <span class="study-tile__value">
          <template v-if="!pressure">—</template>
          <template v-else-if="pressure.includedCount === 0">轻松</template>
          <template v-else>{{ pressure.includedCount }} 个到期<template v-if="busiest?.concentrated"> · 有扎堆</template></template>
        </span>
      </span>
    </RouterLink>
  </div>
</template>

<style scoped>
.study-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: var(--space-3);
  margin-bottom: 20px;
}

.study-tile {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  color: inherit;
}

.study-tile:hover {
  text-decoration: none;
}

.study-tile + .study-tile {
  margin-top: 0;
}

.study-tile__icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex: none;
  border-radius: 12px;
  background: var(--primary-soft);
  color: var(--primary);
}

.study-tile__body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.study-tile__label {
  color: var(--text-muted);
  font-size: 0.8rem;
}

.study-tile__value {
  font-size: 1.12rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
</style>
