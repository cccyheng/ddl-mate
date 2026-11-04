<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { buildCourseConflicts, COURSE_CONFLICTS_WINDOW_DAYS } from '@domain/courseConflicts'
import { shanghaiToday } from '@domain/datetime'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import LoadingState from '@/components/LoadingState.vue'
import { loadAllCourses, loadAllSchedules, toDomainCourse, toDomainSchedule } from '@/domain/adapters'
import { shortDayLabel } from '@/utils/dateKeys'

const result = ref(null)
const loading = ref(true)
const error = ref('')

const byDate = computed(() => {
  const groups = new Map()
  for (const pair of result.value?.pairs ?? []) {
    if (!groups.has(pair.dateKey)) groups.set(pair.dateKey, [])
    groups.get(pair.dateKey).push(pair)
  }
  return [...groups.entries()]
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    const courses = await loadAllCourses()
    const schedules = await loadAllSchedules(courses)
    result.value = buildCourseConflicts({
      schedules: schedules.map(toDomainSchedule),
      courses: courses.map(toDomainCourse),
      fromDateKey: shanghaiToday(new Date()),
    })
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <header class="page-head">
      <div>
        <span class="page-head__eyebrow"><AppIcon name="conflict" :size="15" />课程</span>
        <h1>课表冲突检查</h1>
        <p class="page-head__sub">
          检查从今天起 {{ COURSE_CONFLICTS_WINDOW_DAYS }} 天里真实会上的课（含单双周、教学周范围），只有时间真正重叠才算冲突；前后紧挨着不算。
        </p>
      </div>
      <button type="button" class="btn" @click="load">重新检查</button>
    </header>

    <ErrorState v-if="error" :message="error" @retry="load" />
    <LoadingState v-else-if="loading" title="正在检查…" />

    <template v-else-if="result">
      <div v-if="result.status === 'unavailable'" class="alert alert--warn">{{ result.reason }}</div>
      <template v-else>
        <div class="metric-grid" style="margin-bottom: 16px">
          <div class="metric">
            <span class="metric__value">{{ result.pairCount }}</span>
            <span class="metric__label">冲突对数</span>
          </div>
          <div class="metric">
            <span class="metric__value">{{ result.dateCount }}</span>
            <span class="metric__label">涉及天数</span>
          </div>
          <div class="metric">
            <span class="metric__value">{{ result.validScheduleCount }}/{{ result.scheduleCount }}</span>
            <span class="metric__label">参与检查的课表行</span>
          </div>
        </div>

        <section v-if="result.pairCount === 0" class="card card--accent">
          <h2 class="card__title"><AppIcon name="check" :size="18" />{{ result.fromDateKey }} 至 {{ result.toDateKey }} 没有冲突</h2>
        </section>

        <section v-for="[dateKey, pairs] in byDate" :key="dateKey" class="card">
          <h2 class="section-title">{{ shortDayLabel(dateKey) }}</h2>
          <div class="stack">
            <div v-for="pair in pairs" :key="pair.key" class="conflict">
              <div class="conflict__overlap">
                <span class="badge badge--danger">重叠 {{ pair.overlapStart }}–{{ pair.overlapEnd }}</span>
                <span class="muted small">{{ pair.overlapMinutes }} 分钟</span>
              </div>
              <div class="conflict__pair">
                <RouterLink
                  v-for="side in [pair.left, pair.right]"
                  :key="side.scheduleId"
                  class="conflict__side"
                  :to="side.courseId ? `/courses/${side.courseId}` : '/courses'"
                >
                  <strong>{{ side.courseName }}</strong>
                  <span class="small muted">{{ side.startTime }}–{{ side.endTime }} · {{ side.location || '地点未填' }}</span>
                  <span class="small muted">{{ side.weekLabel }}</span>
                </RouterLink>
              </div>
            </div>
          </div>
        </section>

        <section v-if="result.warnings.length" class="card card--soft">
          <h2 class="section-title">有 {{ result.skippedCount }} 条课表数据不完整，未参与检查</h2>
          <ul class="small" style="margin: 0; padding-left: 18px">
            <li v-for="(warning, index) in result.warnings" :key="index">{{ warning.message }}</li>
          </ul>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.conflict {
  padding: 12px;
  border: 1px solid var(--danger-line);
  border-radius: var(--radius);
  background: var(--surface-warm);
}

.conflict__overlap {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.conflict__pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px;
}

.conflict__side {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
}

.conflict__side:hover {
  text-decoration: none;
  border-color: var(--border-strong);
}
</style>
