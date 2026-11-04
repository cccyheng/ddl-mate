<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import {
  analyzeLearningReport,
  currentLearningWeek,
  formatLearningReportRate,
  LEARNING_REPORT_WEEKDAY_LABELS,
  learningWeekHistoryBounds,
  selectLearningReportTasks,
  shiftLearningWeek,
  shortDateKey,
} from '@domain/learningReport'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import LoadingState from '@/components/LoadingState.vue'
import { loadAllCourses, loadAllTasks, toDomainCourse, toDomainTask } from '@/domain/adapters'

const tasks = ref([])
const courses = ref([])
const loading = ref(true)
const error = ref('')
const week = ref(currentLearningWeek(new Date()))
const filter = ref({ kind: 'completedThisWeek' })

const bounds = computed(() => learningWeekHistoryBounds(new Date()))
const canPrev = computed(() => bounds.value && week.value.startDateKey > bounds.value.earliest.startDateKey)
const canNext = computed(() => bounds.value && week.value.startDateKey < bounds.value.current.startDateKey)
const isCurrent = computed(() => bounds.value && week.value.startDateKey === bounds.value.current.startDateKey)

const analysis = computed(() =>
  week.value
    ? analyzeLearningReport({ tasks: tasks.value, courses: courses.value, weekStartDateKey: week.value.startDateKey, now: new Date() })
    : null,
)
const maxCompleted = computed(() => Math.max(1, ...(analysis.value?.days ?? []).map((day) => day.completedCount)))
const filtered = computed(() => (analysis.value ? selectLearningReportTasks(analysis.value, filter.value) : []))
const courseName = (id) => courses.value.find((course) => course.id === id)?.name

const FILTERS = [
  { kind: 'completedThisWeek', label: '本周完成' },
  { kind: 'due', label: '本周到期' },
  { kind: 'dueOpen', label: '到期未完成' },
  { kind: 'overdue', label: '当前逾期' },
]

function shift(delta) {
  const next = shiftLearningWeek(week.value.startDateKey, delta)
  if (next) week.value = next
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [allTasks, allCourses] = await Promise.all([loadAllTasks(), loadAllCourses()])
    tasks.value = allTasks.map(toDomainTask)
    courses.value = allCourses.map(toDomainCourse)
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
        <span class="page-head__eyebrow"><AppIcon name="chart" :size="15" />规划</span>
        <h1>学习周报</h1>
        <p class="page-head__sub">按上海时间周一到周日统计完成、到期与逾期；「完成」以真实完成时间为准。</p>
      </div>
      <div v-if="week" class="row">
        <button type="button" class="btn btn--sm" :disabled="!canPrev" @click="shift(-1)">上一周</button>
        <span class="chip chip--active" style="cursor: default">
          {{ shortDateKey(week.startDateKey) }} – {{ shortDateKey(week.endDateKey) }}{{ isCurrent ? '（本周）' : '' }}
        </span>
        <button type="button" class="btn btn--sm" :disabled="!canNext" @click="shift(1)">下一周</button>
      </div>
    </header>

    <ErrorState v-if="error" :message="error" @retry="load" />
    <LoadingState v-else-if="loading || !analysis" title="正在统计…" />

    <template v-else>
      <div class="metric-grid" style="margin-bottom: 16px">
        <div class="metric">
          <span class="metric__value">{{ analysis.totals.completedThisWeek }}</span>
          <span class="metric__label">本周完成</span>
        </div>
        <div class="metric">
          <span class="metric__value">{{ analysis.totals.dueTotal }}</span>
          <span class="metric__label">本周到期</span>
        </div>
        <div class="metric">
          <span class="metric__value">{{ formatLearningReportRate(analysis.dueCompletionRate) }}</span>
          <span class="metric__label">到期完成率</span>
        </div>
        <div class="metric">
          <span class="metric__value">{{ analysis.totals.overdue }}</span>
          <span class="metric__label">当前逾期</span>
        </div>
      </div>

      <div class="split">
        <section class="card">
          <h2 class="card__title" style="margin-bottom: 14px"><AppIcon name="chart" :size="18" />每天完成</h2>
          <div class="bar-chart">
            <div v-for="day in analysis.days" :key="day.dateKey" class="bar-chart__col">
              <span class="bar-chart__value">{{ day.completedCount || '' }}</span>
              <span class="bar-chart__bar" :style="{ height: `${Math.max(2, (day.completedCount / maxCompleted) * 100)}%` }" />
              <span class="bar-chart__label">{{ LEARNING_REPORT_WEEKDAY_LABELS[day.weekday - 1] }}</span>
            </div>
          </div>

          <div class="row" style="margin: 20px 0 12px">
            <button
              v-for="option in FILTERS"
              :key="option.kind"
              type="button"
              class="chip"
              :class="{ 'chip--active': filter.kind === option.kind }"
              @click="filter = { kind: option.kind }"
            >
              {{ option.label }}
            </button>
          </div>
          <p v-if="filtered.length === 0" class="muted small">这一类没有任务。</p>
          <div v-else class="list-rows">
            <RouterLink v-for="task in filtered" :key="task.id" class="list-row report-row" :to="`/tasks/${task.id}`">
              <div class="list-row__main">
                <div class="list-row__title">{{ task.title }}</div>
                <div class="list-row__meta">
                  {{ courseName(task.courseId) || '未关联课程' }}
                  <template v-if="task.deadline"> · DDL {{ task.deadline.slice(0, 16).replace('T', ' ') }}</template>
                </div>
              </div>
              <AppIcon name="chevronRight" :size="16" />
            </RouterLink>
          </div>
          <p v-if="analysis.totals.doneMissingCompletion" class="muted small" style="margin-top: 10px">
            有 {{ analysis.totals.doneMissingCompletion }} 个已完成任务缺少完成时间，未计入「本周完成」。
          </p>
        </section>

        <aside class="card">
          <h2 class="card__title" style="margin-bottom: 12px"><AppIcon name="book" :size="18" />按课程</h2>
          <p v-if="analysis.courseGroups.length === 0" class="muted small">本周没有到期任务。</p>
          <div v-else class="stack">
            <button
              v-for="group in analysis.courseGroups"
              :key="String(group.courseId)"
              type="button"
              class="course-group"
              :class="{ 'course-group--active': filter.kind === 'course' && filter.courseId === group.courseId }"
              @click="filter = { kind: 'course', courseId: group.courseId }"
            >
              <span class="row row--between">
                <strong>{{ group.courseName || '未关联课程' }}</strong>
                <span class="small muted">{{ group.dueDone }}/{{ group.dueTotal }}</span>
              </span>
              <span class="progress" style="margin-top: 6px">
                <span
                  class="progress__bar"
                  :style="{ width: `${group.dueTotal ? (group.dueDone / group.dueTotal) * 100 : 0}%` }"
                />
              </span>
              <span v-if="group.overdue" class="small text-danger">{{ group.overdue }} 个逾期</span>
            </button>
          </div>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.report-row {
  color: inherit;
}

.report-row:hover {
  text-decoration: none;
  background: var(--surface-soft);
}

.course-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.course-group:hover {
  border-color: var(--border-strong);
}

.course-group--active {
  border-color: var(--primary-line);
  background: var(--primary-tint);
}

.text-danger {
  color: var(--clay-dark);
}
</style>
