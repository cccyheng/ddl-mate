<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { analyzeDdlPressure, CONCENTRATION_THRESHOLD, formatMinutes } from '@domain/ddlPressure'
import {
  readStoredStudyReferenceMinutes,
  STUDY_REFERENCE_RANGE_MESSAGE,
  studyReferenceSaveGuard,
  studyReferenceToDraft,
} from '@domain/studyReference'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import LoadingState from '@/components/LoadingState.vue'
import { settingsApi } from '@/api'
import { useSetting } from '@/composables/useSetting'
import { loadAllTasks, toDomainTask } from '@/domain/adapters'
import { shortDayLabel } from '@/utils/dateKeys'

const REFERENCE_KEY = 'pressure.daily_study_reference_minutes'
const reference = useSetting(REFERENCE_KEY, {
  decode: (raw) => readStoredStudyReferenceMinutes(raw),
  encode: (minutes) => String(minutes),
})

const tasks = ref([])
const loading = ref(true)
const error = ref('')
const draft = ref('')
const saveMessage = ref('')

const analysis = computed(() =>
  analyzeDdlPressure({ tasks: tasks.value, referenceMinutes: reference.data.value, now: new Date() }),
)

const maxDayMinutes = computed(() =>
  Math.max(60, reference.data.value ?? 0, ...analysis.value.days.map((day) => day.knownMinutes)),
)

const guard = computed(() => studyReferenceSaveGuard(draft.value, reference.data.value))

const STATUS_TEXT = {
  empty: '无到期',
  unset: '未设参考',
  within: '在参考内',
  incomplete: '有任务缺预计用时',
  exceeds: '超出参考',
}

function statusTone(day) {
  if (day.status === 'exceeds' || day.concentrated) return 'danger'
  if (day.status === 'incomplete') return 'warn'
  return 'primary'
}

async function saveReference() {
  saveMessage.value = ''
  if (!guard.value.canSave) return
  let ok
  if (guard.value.minutes === null) {
    try {
      await settingsApi.remove(REFERENCE_KEY)
      await reference.load()
      ok = true
    } catch (err) {
      reference.error.value = err.message
      ok = false
    }
  } else {
    ok = await reference.save(guard.value.minutes)
  }
  if (ok) {
    draft.value = studyReferenceToDraft(reference.data.value)
    saveMessage.value = '已保存'
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [all] = await Promise.all([loadAllTasks(), reference.load()])
    tasks.value = all.map(toDomainTask)
    draft.value = studyReferenceToDraft(reference.data.value)
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
        <span class="page-head__eyebrow"><AppIcon name="gauge" :size="15" />规划</span>
        <h1>DDL 压力分析</h1>
        <p class="page-head__sub">
          未来 7 天（上海时间）每天到期多少任务、已填预计用时合计多少。只是统计，不会改动任何任务。
        </p>
      </div>
    </header>

    <ErrorState v-if="error" :message="error" @retry="load" />
    <LoadingState v-else-if="loading" title="正在分析…" />

    <template v-else>
      <div class="metric-grid" style="margin-bottom: 16px">
        <div class="metric">
          <span class="metric__value">{{ analysis.includedCount }}</span>
          <span class="metric__label">7 天内到期</span>
        </div>
        <div class="metric">
          <span class="metric__value">{{ formatMinutes(analysis.includedKnownMinutes) }}</span>
          <span class="metric__label">已填预计用时合计</span>
        </div>
        <div class="metric">
          <span class="metric__value" :class="{ 'text-danger': analysis.overdue.length }">{{ analysis.overdue.length }}</span>
          <span class="metric__label">已逾期（未计入各天）</span>
        </div>
        <div class="metric">
          <span class="metric__value">{{ analysis.includedUnknownEstimateCount }}</span>
          <span class="metric__label">缺预计用时</span>
        </div>
      </div>

      <div class="split">
        <section class="card">
          <div class="card__head">
            <div>
              <h2 class="card__title"><AppIcon name="chart" :size="18" />每日负荷</h2>
              <p class="card__hint">
                一天到期 ≥ {{ CONCENTRATION_THRESHOLD }} 个任务记为「扎堆」。缺预计用时的任务不按 0 计入。
              </p>
            </div>
          </div>

          <div class="bar-chart" aria-label="未来 7 天已填预计用时">
            <div v-for="day in analysis.days" :key="day.dateKey" class="bar-chart__col">
              <span class="bar-chart__value">{{ day.taskCount || '' }}</span>
              <span
                class="bar-chart__bar"
                :class="{
                  'bar-chart__bar--danger': statusTone(day) === 'danger',
                  'bar-chart__bar--warn': statusTone(day) === 'warn',
                }"
                :style="{ height: `${Math.max(2, (day.knownMinutes / maxDayMinutes) * 100)}%` }"
              />
              <span class="bar-chart__label">{{ day.isToday ? '今天' : shortDayLabel(day.dateKey).slice(6) }}</span>
            </div>
          </div>
          <p class="muted small" style="margin: 6px 0 16px">柱高 = 已填预计用时；柱上数字 = 当天到期任务数。</p>

          <div class="list-rows">
            <div v-for="day in analysis.days" :key="day.dateKey" class="list-row pressure-day">
              <div class="list-row__main">
                <div class="list-row__title">
                  {{ day.isToday ? '今天' : shortDayLabel(day.dateKey) }}
                  <span class="badge" :class="`badge--${statusTone(day) === 'primary' ? 'muted' : statusTone(day)}`">
                    {{ STATUS_TEXT[day.status] }}
                  </span>
                  <span v-if="day.concentrated" class="badge badge--danger">扎堆</span>
                </div>
                <div class="list-row__meta">
                  {{ day.taskCount }} 个到期 · 已填 {{ formatMinutes(day.knownMinutes) }}
                  <template v-if="day.unknownEstimateCount"> · {{ day.unknownEstimateCount }} 个缺用时</template>
                  <template v-if="day.excessMinutes"> · 超出 {{ formatMinutes(day.excessMinutes) }}</template>
                </div>
                <RouterLink
                  v-if="day.tasks.length"
                  class="btn btn--sm pressure-day__plan"
                  :to="{ name: 'today-plan', query: { tasks: day.tasks.map((t) => t.id).join(',') } }"
                >
                  <AppIcon name="target" :size="14" />今天推进这些
                </RouterLink>
                <div v-if="day.tasks.length" class="row pressure-day__tasks">
                  <RouterLink v-for="task in day.tasks" :key="task.id" class="chip" :to="`/tasks/${task.id}`">
                    {{ task.title }}
                    <span class="muted">{{ task.estimatedMinutes != null ? formatMinutes(task.estimatedMinutes) : '缺用时' }}</span>
                  </RouterLink>
                </div>
              </div>
            </div>
          </div>
        </section>

        <aside class="stack">
          <section class="card">
            <h2 class="card__title"><AppIcon name="clock" :size="18" />每日可用学习时间</h2>
            <p class="card__hint">用来与每天的预计用时比较；不设置也可以，只是不做比较。</p>
            <div class="row" style="margin-top: 12px">
              <input
                v-model="draft"
                type="text"
                inputmode="numeric"
                placeholder="分钟，如 120"
                aria-label="每日可用学习时间（分钟）"
                style="max-width: 160px"
              />
              <button
                type="button"
                class="btn btn--sm btn--primary"
                :disabled="!guard.canSave || reference.saving.value"
                @click="saveReference"
              >
                {{ guard.minutes === null && guard.dirty ? '清除' : '保存' }}
              </button>
            </div>
            <p v-if="guard.reason" class="field__error">{{ guard.reason }}</p>
            <p v-else-if="reference.error.value" class="field__error">{{ reference.error.value }}</p>
            <p v-else-if="saveMessage" class="muted small">{{ saveMessage }}</p>
            <p v-else class="muted small">{{ STUDY_REFERENCE_RANGE_MESSAGE }}</p>
          </section>

          <section v-if="analysis.overdue.length || analysis.missingDeadline.length || analysis.beyondWindow.length" class="card">
            <h2 class="section-title">未计入 7 天的任务</h2>
            <div class="stack small">
              <div v-if="analysis.overdue.length">
                <strong class="text-danger">已逾期 {{ analysis.overdue.length }}</strong>
                <div class="row" style="margin-top: 6px">
                  <RouterLink v-for="task in analysis.overdue" :key="task.id" class="chip" :to="`/tasks/${task.id}`">
                    {{ task.title }}
                  </RouterLink>
                </div>
              </div>
              <div v-if="analysis.missingDeadline.length">
                <strong>没有截止时间 {{ analysis.missingDeadline.length }}</strong>
                <div class="row" style="margin-top: 6px">
                  <RouterLink v-for="task in analysis.missingDeadline" :key="task.id" class="chip" :to="`/tasks/${task.id}`">
                    {{ task.title }}
                  </RouterLink>
                </div>
              </div>
              <p v-if="analysis.beyondWindow.length" class="muted" style="margin: 0">
                另有 {{ analysis.beyondWindow.length }} 个任务在 7 天之后到期。
              </p>
            </div>
          </section>

          <section v-if="!analysis.hasAnyTask" class="card card--soft">
            <p class="muted" style="margin: 0">未来 7 天没有到期任务。</p>
            <RouterLink class="btn btn--sm" to="/tasks/new" style="margin-top: 10px">新建任务</RouterLink>
          </section>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pressure-day__tasks {
  margin-top: 8px;
}

.pressure-day__plan {
  margin-top: 8px;
}

.text-danger {
  color: var(--clay-dark);
}
</style>
