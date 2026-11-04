<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { shanghaiToday } from '@domain/datetime'
import {
  buildTodayPlan,
  isPlanForToday,
  MAX_SELECTED_TASKS,
  MAX_STUDY_WINDOWS,
  samePlanResult,
  shanghaiMinuteOfDay,
  TODAY_PLAN_STORAGE_VERSION,
  validateStudyWindows,
  verifyTodayPlan,
} from '@domain/todayPlan'
import { parseTodayPlanPayload } from '@domain/todayPlanRepository'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import LoadingState from '@/components/LoadingState.vue'
import { useSetting } from '@/composables/useSetting'
import {
  loadAllCourses,
  loadAllSchedules,
  loadAllTasks,
  toDomainCourse,
  toDomainSchedule,
  toDomainTask,
} from '@/domain/adapters'

const saved = useSetting('daily_plan.today', {
  decode: (raw) => (raw === null ? null : parseTodayPlanPayload(raw)),
  encode: (payload) => JSON.stringify(payload),
})

const context = reactive({ tasks: [], courses: [], schedules: [] })
const loading = ref(true)
const error = ref('')
const windows = ref([{ start: '19:00', end: '22:00' }])
const selected = reactive({}) // taskId -> minutes(string)
const preview = ref(null)
const previewError = ref('')
const commitMessage = ref('')

const activeTasks = computed(() =>
  context.tasks
    .filter((task) => task.status === 'TODO' || task.status === 'DOING')
    .sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') || b.priority - a.priority),
)
const courseName = (id) => context.courses.find((course) => course.id === id)?.name
const selectedCount = computed(() => Object.keys(selected).length)
const windowCheck = computed(() => validateStudyWindows(windows.value))

const todaysSaved = computed(() => {
  const value = saved.data.value
  return value && isPlanForToday(value.plan.date, new Date()) ? value.plan : null
})

function toggleTask(task) {
  if (selected[task.id] !== undefined) delete selected[task.id]
  else if (selectedCount.value < MAX_SELECTED_TASKS) selected[task.id] = String(task.estimatedMinutes || 60)
}

function selectionsInput() {
  return Object.entries(selected).map(([taskId, minutes]) => ({ taskId: Number(taskId), minutes: Number(minutes) }))
}

function build(now = new Date()) {
  return buildTodayPlan({
    date: shanghaiToday(now),
    now,
    windows: windows.value,
    selections: selectionsInput(),
    tasks: context.tasks,
    schedules: context.schedules,
    courses: context.courses,
  })
}

function generate() {
  previewError.value = ''
  commitMessage.value = ''
  try {
    const plan = build()
    if (plan.inputErrors.length) {
      previewError.value = plan.inputErrors.join('；')
      preview.value = null
      return
    }
    preview.value = plan
  } catch (err) {
    previewError.value = err.message
  }
}

/** 采用：先重新读取数据重算，与预览一致、且没有任何时间块已经开始，才写入。 */
async function commit() {
  previewError.value = ''
  try {
    await loadContext()
    const now = new Date()
    const fresh = build(now)
    if (!samePlanResult(fresh, preview.value)) {
      previewError.value = '任务或课表在预览之后有变化，请重新生成预览后再采用。'
      return
    }
    const verification = verifyTodayPlan(fresh)
    if (!verification.ok) {
      previewError.value = `计划没有通过自检：${verification.errors[0] ?? '未知原因'}`
      return
    }
    const nowMinute = shanghaiMinuteOfDay(now)?.minute ?? 0
    if (fresh.blocks.some((block) => block.startMinute < nowMinute)) {
      previewError.value = '预览里有时间块已经开始了，请重新生成预览。'
      return
    }
    const payload = {
      version: TODAY_PLAN_STORAGE_VERSION,
      date: fresh.date,
      revision: (saved.data.value?.revision ?? 0) + 1,
      savedAt: now.toISOString(),
      anchorEpochMs: fresh.anchorEpochMs,
      windows: windowCheck.value.windows.map(({ start, end }) => ({ start, end })),
      selections: selectionsInput(),
      blocks: fresh.blocks,
      outcomes: fresh.outcomes,
      scheduledMinutes: fresh.scheduledMinutes,
      unscheduledMinutes: fresh.unscheduledMinutes,
      targetMinutes: fresh.targetMinutes,
      windowLabels: fresh.windowLabels,
      contextDigest: fresh.fingerprint.contextDigest,
      algorithmVersion: fresh.fingerprint.algorithmVersion,
    }
    if (await saved.save(payload)) {
      commitMessage.value = '已采用并保存为今日计划。'
      preview.value = null
    } else {
      previewError.value = saved.error.value
    }
  } catch (err) {
    previewError.value = err.message
  }
}

function loadFromSaved() {
  const plan = todaysSaved.value
  const raw = saved.data.value
  if (!plan || !raw) return
  for (const key of Object.keys(selected)) delete selected[key]
  for (const outcome of plan.outcomes) selected[outcome.taskId] = String(outcome.targetMinutes)
}

async function loadContext() {
  const [tasks, courses] = await Promise.all([loadAllTasks(), loadAllCourses()])
  const schedules = await loadAllSchedules(courses)
  context.tasks = tasks.map(toDomainTask)
  context.courses = courses.map(toDomainCourse)
  context.schedules = schedules.map(toDomainSchedule)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    await Promise.all([loadContext(), saved.load()])
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
        <span class="page-head__eyebrow"><AppIcon name="target" :size="15" />规划</span>
        <h1>今日学习计划</h1>
        <p class="page-head__sub">
          设定今天能学习的时段，选几个任务和计划分钟数，自动避开上课时间排出时间块。先预览，确认后才保存。
        </p>
      </div>
    </header>

    <ErrorState v-if="error" :message="error" @retry="load" />
    <LoadingState v-else-if="loading" title="正在读取任务与课表…" />

    <template v-else>
      <section v-if="todaysSaved" class="card card--accent" style="margin-bottom: 16px">
        <div class="card__head">
          <div>
            <h2 class="card__title"><AppIcon name="check" :size="18" />已采用的今日计划</h2>
            <p class="card__hint">
              共 {{ todaysSaved.scheduledMinutes }} 分钟<template v-if="todaysSaved.unscheduledMinutes">，另有
                {{ todaysSaved.unscheduledMinutes }} 分钟没排进去</template>。
            </p>
          </div>
          <button type="button" class="btn btn--sm" @click="loadFromSaved">按它重新调整</button>
        </div>
        <div class="plan-timeline">
          <div v-for="block in todaysSaved.blocks" :key="`${block.taskId}-${block.startMinute}`" class="plan-block">
            <span class="plan-block__time mono">{{ block.startTime }}–{{ block.endTime }}</span>
            <RouterLink :to="`/tasks/${block.taskId}`" class="plan-block__title">{{ block.taskTitle }}</RouterLink>
            <span class="muted small">{{ block.minutes }} 分钟</span>
          </div>
          <p v-if="todaysSaved.blocks.length === 0" class="muted small">计划里没有时间块。</p>
        </div>
      </section>

      <div class="split">
        <section class="card">
          <h2 class="card__title" style="margin-bottom: 12px"><AppIcon name="list" :size="18" />选择今天要推进的任务</h2>
          <p class="card__hint" style="margin-bottom: 12px">
            已选 {{ selectedCount }} / {{ MAX_SELECTED_TASKS }}；分钟数默认取任务的预计用时。
          </p>
          <p v-if="activeTasks.length === 0" class="muted">没有未完成的任务。</p>
          <div v-else class="list-rows">
            <label v-for="task in activeTasks" :key="task.id" class="list-row plan-task">
              <input type="checkbox" :checked="selected[task.id] !== undefined" @change="toggleTask(task)" />
              <span class="list-row__main">
                <span class="list-row__title">{{ task.title }}</span>
                <span class="list-row__meta">
                  {{ courseName(task.courseId) || '未关联课程' }}
                  <template v-if="task.deadline"> · DDL {{ task.deadline.slice(5, 16).replace('T', ' ') }}</template>
                </span>
              </span>
              <span v-if="selected[task.id] !== undefined" class="row" @click.prevent>
                <input
                  v-model="selected[task.id]"
                  type="number"
                  min="1"
                  max="1440"
                  class="plan-task__minutes"
                  aria-label="计划分钟"
                />
                <span class="muted small">分钟</span>
              </span>
            </label>
          </div>
        </section>

        <aside class="stack">
          <section class="card">
            <h2 class="card__title" style="margin-bottom: 12px"><AppIcon name="clock" :size="18" />今天的学习时段</h2>
            <div v-for="(window, index) in windows" :key="index" class="row" style="margin-bottom: 8px">
              <input v-model="window.start" type="time" aria-label="开始" />
              <span class="muted">至</span>
              <input v-model="window.end" type="time" aria-label="结束" />
              <button v-if="windows.length > 1" type="button" class="btn btn--sm btn--ghost" @click="windows.splice(index, 1)">
                移除
              </button>
            </div>
            <button
              v-if="windows.length < MAX_STUDY_WINDOWS"
              type="button"
              class="btn btn--sm btn--ghost"
              @click="windows.push({ start: '14:00', end: '16:00' })"
            >
              <AppIcon name="plus" :size="15" />再加一段
            </button>
            <p v-for="issue in windowCheck.issues" :key="`${issue.index}-${issue.field}`" class="field__error">
              第 {{ issue.index + 1 }} 段：{{ issue.message }}
            </p>
            <button
              type="button"
              class="btn btn--primary btn--block"
              style="margin-top: 14px"
              :disabled="!windowCheck.ok || selectedCount === 0"
              @click="generate"
            >
              生成预览
            </button>
          </section>

          <div v-if="previewError" class="alert alert--danger">{{ previewError }}</div>
          <div v-if="commitMessage" class="alert alert--success">{{ commitMessage }}</div>

          <section v-if="preview" class="card card--accent">
            <h2 class="card__title" style="margin-bottom: 6px">预览</h2>
            <p class="card__hint" style="margin-bottom: 12px">
              排进 {{ preview.scheduledMinutes }} / {{ preview.targetMinutes }} 分钟；课程时间已自动避开。
            </p>
            <div class="plan-timeline">
              <div v-for="block in preview.blocks" :key="`${block.taskId}-${block.startMinute}`" class="plan-block">
                <span class="plan-block__time mono">{{ block.startTime }}–{{ block.endTime }}</span>
                <span class="plan-block__title">{{ block.taskTitle }}</span>
                <span class="muted small">{{ block.minutes }} 分钟</span>
              </div>
            </div>
            <div v-if="preview.busyIntervals.length" class="small muted" style="margin-top: 10px">
              上课占用：<span v-for="busy in preview.busyIntervals" :key="busy.start">{{ busy.start }}–{{ busy.end }} </span>
            </div>
            <ul v-if="preview.hasUnscheduled" class="small plan-unscheduled">
              <li v-for="outcome in preview.outcomes.filter((o) => o.unscheduled)" :key="outcome.taskId">
                {{ outcome.taskTitle }}：{{ outcome.unscheduled.text }}
              </li>
            </ul>
            <p v-for="warning in preview.warnings" :key="warning" class="small muted">{{ warning }}</p>
            <button
              type="button"
              class="btn btn--primary btn--block"
              style="margin-top: 12px"
              :disabled="saved.saving.value || preview.emptyPlan"
              @click="commit"
            >
              采用并保存
            </button>
          </section>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.plan-timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plan-block {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--primary);
}

.plan-block__title {
  font-weight: 600;
  color: var(--text);
  overflow-wrap: anywhere;
}

.plan-task {
  cursor: pointer;
}

.plan-task__minutes {
  width: 84px;
}

.plan-unscheduled {
  margin: 10px 0 0;
  padding-left: 18px;
  color: var(--warn);
}

@media (max-width: 560px) {
  .plan-block {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
</style>
