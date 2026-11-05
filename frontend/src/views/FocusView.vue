<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  applyFocusAction,
  decodeFocus,
  FOCUS_KEY,
  focusClockIssue,
  focusDayStart,
  focusDuration,
  focusRemaining,
  focusTarget,
  focusTotal,
  formatFocusDuration,
} from '@domain/focusTime'
import { historyDrafts, historyIntervals, historyLabel } from '@domain/focusHistory'
import {
  changeWeeklyGoal,
  decodeWeeklyGoals,
  goalDuration,
  goalWeek,
  WEEKLY_GOAL_KEY,
  weeklyGoalProgress,
} from '@domain/weeklyGoal'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import LoadingState from '@/components/LoadingState.vue'
import { useRoute } from 'vue-router'
import { courseApi, taskApi } from '@/api'
import { loadAllTasks } from '@/domain/adapters'
import { useSetting } from '@/composables/useSetting'
import { dateKeyOf, shiftDateKey, weekdayShort } from '@/utils/dateKeys'

const focus = useSetting(FOCUS_KEY, { decode: decodeFocus, encode: (s) => JSON.stringify(s) })
const goals = useSetting(WEEKLY_GOAL_KEY, { decode: decodeWeeklyGoals, encode: (s) => JSON.stringify(s) })

const courses = ref([])
const loadError = ref('')
const actionError = ref('')
const now = ref(Date.now())
let ticker = null

const route = useRoute()
const form = reactive({ mode: 'pomodoro', title: '', courseName: '', courseId: null, taskChoice: '', focusMinutes: 25, restMinutes: 5 })

/* ---------- 这次专注：课程 + 正在做的事 ---------- */
const openTasks = ref([])
const TYPE_PREFIX = { EXAM: '考试', HOMEWORK: '作业', REPORT: '报告', PROJECT: '项目' }
const courseTasks = computed(() =>
  openTasks.value
    .filter((t) => (t.course?.id ?? null) === form.courseId)
    .sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999')),
)
function taskLabel(task) {
  const prefix = TYPE_PREFIX[task.type]
  const due = task.deadline ? ` · ${task.deadline.slice(5, 10).replace('-', '/')}` : ''
  return `${prefix && !task.title.startsWith('复习') ? `${prefix}：` : ''}${task.title}${due}`
}
watch(
  () => form.courseId,
  (id) => {
    form.courseName = courses.value.find((c) => c.id === id)?.name ?? ''
    if (form.taskChoice !== 'custom') form.taskChoice = ''
  },
)
watch(
  () => form.taskChoice,
  (choice) => {
    if (choice === '' || choice === 'custom') return
    const task = openTasks.value.find((t) => t.id === choice)
    if (!task) return
    form.title = task.title.slice(0, 200)
    const minutes = Number(task.estimatedMinutes)
    if (form.mode === 'pomodoro' && Number.isInteger(minutes) && minutes >= 15 && minutes <= 90) form.focusMinutes = minutes
  },
)
const subjectTitle = computed(() => (active.value ? active.value.title : form.title.trim() || '自习'))
const subjectCourse = computed(() => (active.value ? active.value.courseName : form.courseName))
const BASE_FOCUS_PRESETS = [15, 25, 45, 60, 90]
/** 从今日计划带来的分钟数不在常用档位里时，临时加一个档位，方便看到当前选择。 */
const FOCUS_PRESETS = computed(() =>
  BASE_FOCUS_PRESETS.includes(Number(form.focusMinutes))
    ? BASE_FOCUS_PRESETS
    : [...BASE_FOCUS_PRESETS, Number(form.focusMinutes)].sort((a, b) => a - b),
)
const REST_PRESETS = [5, 10, 15]

const store = computed(() => focus.data.value)
const active = computed(() => store.value?.active ?? null)
const clockIssue = computed(() => focusClockIssue(active.value, now.value))
const isRest = computed(() => active.value?.timer?.kind === 'rest')
const running = computed(() => active.value?.runningSince != null)

const elapsedMs = computed(() => (active.value ? focusDuration(active.value, now.value) : 0))
const remainingMs = computed(() => (active.value?.timer ? focusRemaining(active.value, now.value) : null))
const timeUp = computed(() => remainingMs.value === 0)

const dialText = computed(() => {
  if (!active.value) return formatFocusDuration(form.mode === 'pomodoro' ? form.focusMinutes * 60000 : 0)
  return formatFocusDuration(remainingMs.value ?? elapsedMs.value)
})

/** 倒计时：圆环随剩余缩短；正计时：每 60 分钟转一圈。 */
const DIAL_R = 132
const DIAL_C = 2 * Math.PI * DIAL_R
const dialOffset = computed(() => {
  if (!active.value) return form.mode === 'pomodoro' ? 0 : DIAL_C
  if (active.value.timer) return DIAL_C * (1 - elapsedMs.value / focusTarget(active.value))
  return DIAL_C * (1 - (elapsedMs.value % 3600000) / 3600000)
})

/** 表盘刻度：60 格，每 5 格一个长刻度。 */
const DIAL_TICKS = Array.from({ length: 60 }, (_, i) => {
  const angle = (i / 60) * Math.PI * 2
  const outer = 146
  const inner = i % 5 === 0 ? 138 : 142
  return {
    x1: 150 + outer * Math.cos(angle),
    y1: 150 + outer * Math.sin(angle),
    x2: 150 + inner * Math.cos(angle),
    y2: 150 + inner * Math.sin(angle),
    major: i % 5 === 0,
  }
})

const dialLabel = computed(() => {
  if (!active.value) return form.mode === 'pomodoro' ? '番茄专注' : '正计时'
  if (clockIssue.value) return '需要处理'
  if (timeUp.value) return isRest.value ? '休息结束' : '专注时间到'
  if (!running.value) return '已暂停'
  return isRest.value ? '休息中' : '专注中'
})

/* ---------- 统计 ---------- */
const todayKey = computed(() => dateKeyOf(now.value))
const todayMs = computed(() => {
  if (!store.value) return 0
  const start = focusDayStart(todayKey.value)
  return focusTotal(store.value, start, start + 86400000, now.value)
})
const weekKey = computed(() => goalWeek(now.value))
const progress = computed(() =>
  store.value && goals.data.value ? weeklyGoalProgress(goals.data.value, store.value, weekKey.value, now.value) : null,
)
const last7 = computed(() => {
  if (!store.value) return []
  const days = []
  for (let i = 6; i >= 0; i -= 1) {
    const key = shiftDateKey(todayKey.value, -i)
    const start = focusDayStart(key)
    days.push({ key, label: i === 0 ? '今天' : weekdayShort(key), ms: focusTotal(store.value, start, start + 86400000, now.value) })
  }
  return days
})
const maxDayMs = computed(() => Math.max(60000, ...last7.value.map((d) => d.ms)))

const recentRecords = computed(() => (store.value ? [...store.value.records].reverse().slice(0, 30) : []))
const recordDuration = (record) => record.intervals.reduce((sum, i) => sum + i.end - i.start, 0)

/* ---------- 动作 ---------- */
async function run(action) {
  actionError.value = ''
  let next
  try {
    next = applyFocusAction(store.value, action, Date.now())
  } catch (err) {
    actionError.value = err.message
    return false
  }
  const ok = await focus.save(next)
  if (!ok) {
    actionError.value = focus.error.value
    if (focus.conflict.value) await focus.load().catch(() => {})
  }
  return ok
}

function start() {
  const title = form.title.trim() || '自习'
  const timer =
    form.mode === 'pomodoro'
      ? { kind: 'focus', focusMinutes: Number(form.focusMinutes), restMinutes: Number(form.restMinutes) }
      : undefined
  return run({ type: 'start', title, courseName: form.courseName, timer })
}

function discard() {
  if (!window.confirm('放弃这次专注？已计时的时长不会保存。')) return
  run({ type: 'discard' })
}

/* ---------- 全屏 ---------- */
const dialCard = ref(null)
const isFullscreen = ref(false)
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.()
  else dialCard.value?.requestFullscreen?.()
}
function onFullscreenChange() {
  isFullscreen.value = document.fullscreenElement === dialCard.value
}

/* ---------- 每周目标 ---------- */
const goalDraft = ref('')
const goalError = ref('')
async function saveGoal(clear = false) {
  goalError.value = ''
  const minutes = clear ? null : Math.round(Number(goalDraft.value) * 60)
  let next
  try {
    next = changeWeeklyGoal(goals.data.value, weekKey.value, minutes, Date.now())
  } catch (err) {
    goalError.value = err.message
    return
  }
  if (await goals.save(next)) goalDraft.value = ''
  else goalError.value = goals.error.value
}

/* ---------- 补记 / 更正 ---------- */
const editor = reactive({ open: false, id: undefined, title: '', courseName: '', intervals: [], error: '' })

function openEditor(record) {
  const nowWall = historyLabel(Date.now()).slice(0, 16).replace(' ', 'T')
  Object.assign(editor, {
    open: true,
    id: record?.id,
    title: record?.title ?? '',
    courseName: record?.courseName ?? '',
    intervals: record ? historyDrafts(record.intervals) : [{ start: nowWall, end: nowWall }],
    error: '',
  })
}

async function saveEditor() {
  editor.error = ''
  try {
    const intervals = historyIntervals(editor.intervals)
    const action = { type: 'historySave', title: editor.title, courseName: editor.courseName, intervals }
    if (editor.id !== undefined) action.id = editor.id
    applyFocusAction(store.value, action, Date.now())
    if (await run(action)) editor.open = false
    else editor.error = actionError.value
  } catch (err) {
    editor.error = err.message
  }
}

async function deleteRecord(record) {
  if (!window.confirm(`删除「${record.title}」这条专注记录？`)) return
  await run({ type: 'historyDelete', id: record.id })
}

onMounted(async () => {
  ticker = window.setInterval(() => {
    now.value = Date.now()
  }, 500)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  try {
    const [, , courseList, taskList] = await Promise.all([
      focus.load(),
      goals.load(),
      courseApi.list(),
      loadAllTasks().catch(() => []),
    ])
    courses.value = courseList
    openTasks.value = taskList.filter((t) => !['DONE', 'CANCELLED', 'ARCHIVED'].includes(t.status))
    await prefillFromRoute()
  } catch (err) {
    loadError.value = err.message
  }
})

/** 从任务详情 / 今日计划跳过来：带上任务名、课程和计划分钟数（已有计时进行中时不覆盖）。 */
const prefillNote = ref('')
async function prefillFromRoute() {
  const taskId = Number(route.query.taskId)
  if (!Number.isSafeInteger(taskId) || taskId <= 0) return
  if (store.value?.active) {
    prefillNote.value = '已有一次专注正在进行，先结束它再开始新的。'
    return
  }
  const task = await taskApi.get(taskId).catch(() => null)
  if (!task) return
  form.courseId = task.course?.id ?? null
  form.courseName = task.course?.name ?? ''
  await Promise.resolve()
  form.taskChoice = openTasks.value.some((t) => t.id === task.id) ? task.id : 'custom'
  form.title = task.title.slice(0, 200)
  const minutes = Number(route.query.minutes)
  if (Number.isInteger(minutes) && minutes >= 1) {
    form.mode = 'pomodoro'
    form.focusMinutes = Math.min(180, minutes)
  }
  prefillNote.value = `已带入任务「${task.title}」${form.mode === 'pomodoro' ? `，专注 ${form.focusMinutes} 分钟` : ''}。`
}

onBeforeUnmount(() => {
  window.clearInterval(ticker)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
})
</script>

<template>
  <div>
    <header class="page-head">
      <div>
        <span class="page-head__eyebrow"><AppIcon name="timer" :size="15" />专注</span>
        <h1>专注时间</h1>
        <p class="page-head__sub">正计时或番茄钟，记录真实学习时长；刷新页面不会丢失正在进行的计时。</p>
      </div>
    </header>

    <ErrorState v-if="loadError" :message="loadError" @retry="$router.go(0)" />
    <LoadingState v-else-if="!store || !goals.data.value" title="正在读取专注记录…" />

    <div v-else class="focus-layout">
      <section ref="dialCard" class="card focus-stage" :class="{ 'focus-stage--fullscreen': isFullscreen }">
        <div class="row row--between focus-stage__head">
          <div v-if="!active" class="seg" role="tablist" aria-label="计时方式">
            <button
              v-for="option in [
                { value: 'pomodoro', label: '番茄钟' },
                { value: 'stopwatch', label: '正计时' },
              ]"
              :key="option.value"
              type="button"
              role="tab"
              class="seg__item"
              :class="{ 'seg__item--active': form.mode === option.value }"
              :aria-selected="form.mode === option.value"
              @click="form.mode = option.value"
            >
              {{ option.label }}
            </button>
          </div>
          <span v-else class="badge" :class="isRest ? 'badge--info' : 'badge--primary'">{{ isRest ? '休息' : active.timer ? '番茄钟' : '正计时' }}</span>
          <button type="button" class="icon-btn" :title="isFullscreen ? '退出全屏' : '全屏专注'" @click="toggleFullscreen">
            <AppIcon :name="isFullscreen ? 'close' : 'spark'" :size="18" />
          </button>
        </div>

        <div class="focus-stage__body">
          <div class="focus-stage__dial">
            <div class="focus-subject">
              <span v-if="subjectCourse" class="focus-subject__course"><AppIcon name="book" :size="14" />{{ subjectCourse }}</span>
              <span class="focus-subject__title">{{ subjectTitle }}</span>
            </div>
            <div class="dial" :class="{ 'dial--rest': isRest }">
              <svg viewBox="0 0 300 300" aria-hidden="true">
                <defs>
                  <linearGradient id="dialGradient" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" class="dial__stop-a" />
                    <stop offset="100%" class="dial__stop-b" />
                  </linearGradient>
                </defs>
                <line
                  v-for="(tick, i) in DIAL_TICKS"
                  :key="i"
                  :x1="tick.x1"
                  :y1="tick.y1"
                  :x2="tick.x2"
                  :y2="tick.y2"
                  class="dial__tick"
                  :class="{ 'dial__tick--major': tick.major }"
                />
                <circle class="dial__track" cx="150" cy="150" :r="DIAL_R" fill="none" stroke-width="14" />
                <circle
                  class="dial__arc"
                  cx="150"
                  cy="150"
                  :r="DIAL_R"
                  fill="none"
                  stroke="url(#dialGradient)"
                  stroke-width="14"
                  stroke-linecap="round"
                  :stroke-dasharray="DIAL_C"
                  :stroke-dashoffset="dialOffset"
                />
              </svg>
              <div class="dial__center" role="timer" aria-live="off">
                <span class="dial__label">{{ dialLabel }}</span>
                <span class="dial__time">{{ dialText }}</span>
                <span v-if="active?.timer && !isRest" class="dial__sub">共 {{ active.timer.focusMinutes }} 分钟 · 休息 {{ active.timer.restMinutes }} 分钟</span>
                <span v-else-if="!active && form.mode === 'pomodoro'" class="dial__sub">之后休息 {{ form.restMinutes }} 分钟</span>
              </div>
            </div>
          </div>

          <div class="focus-stage__panel">
            <div v-if="clockIssue" class="alert alert--warn">
              {{ clockIssue }}
              <div class="row" style="margin-top: 8px">
                <button type="button" class="btn btn--sm" @click="run({ type: 'recover' })">舍弃未确认的计时段</button>
              </div>
            </div>
            <div v-if="actionError" class="alert alert--danger">{{ actionError }}</div>
            <div v-if="prefillNote && !active" class="alert alert--success">{{ prefillNote }}</div>

            <!-- 未开始：这次专注 + 时长 -->
            <div v-if="!active" class="stack focus-setup">
              <h2 class="focus-setup__title">这次专注</h2>
              <label class="field">
                <span class="field__label">课程</span>
                <select v-model="form.courseId">
                  <option :value="null">不关联课程</option>
                  <option v-for="course in courses" :key="course.id" :value="course.id">{{ course.name }}</option>
                </select>
              </label>
              <label class="field">
                <span class="field__label">正在做</span>
                <select v-model="form.taskChoice">
                  <option value="">{{ courseTasks.length ? '选择这门课的任务 / 复习…' : form.courseId ? '这门课暂时没有待办，自己填写' : '先选课程，或自己填写' }}</option>
                  <option v-for="task in courseTasks" :key="task.id" :value="task.id">{{ taskLabel(task) }}</option>
                  <option value="custom">自己填写…</option>
                </select>
              </label>
              <label v-if="form.taskChoice === 'custom' || form.taskChoice === ''" class="field">
                <span class="field__label">内容</span>
                <input v-model="form.title" type="text" maxlength="200" placeholder="例如：复习第三章（留空记为「自习」）" />
              </label>
              <div v-if="form.mode === 'pomodoro'" class="stack" style="gap: 10px">
                <div class="row">
                  <span class="muted small focus-setup__label">专注</span>
                  <button
                    v-for="m in FOCUS_PRESETS"
                    :key="m"
                    type="button"
                    class="chip"
                    :class="{ 'chip--active': Number(form.focusMinutes) === m }"
                    @click="form.focusMinutes = m"
                  >
                    {{ m }} 分钟
                  </button>
                </div>
                <div class="row">
                  <span class="muted small focus-setup__label">休息</span>
                  <button
                    v-for="m in REST_PRESETS"
                    :key="m"
                    type="button"
                    class="chip"
                    :class="{ 'chip--active': Number(form.restMinutes) === m }"
                    @click="form.restMinutes = m"
                  >
                    {{ m }} 分钟
                  </button>
                </div>
              </div>
              <button type="button" class="btn btn--primary btn--lg focus-start" :disabled="focus.saving.value" @click="start">
                <AppIcon name="play" :size="18" />开始{{ form.mode === 'pomodoro' ? '番茄专注' : '计时' }}
              </button>
            </div>

            <!-- 进行中：控制 -->
            <div v-else class="stack focus-controls">
              <template v-if="timeUp && !isRest">
                <button type="button" class="btn btn--primary btn--lg" @click="run({ type: 'finishAndRest' })">保存并休息</button>
                <button type="button" class="btn btn--lg" @click="run({ type: 'finish' })">保存并结束</button>
              </template>
              <template v-else-if="isRest">
                <button type="button" class="btn btn--primary btn--lg" @click="run({ type: 'nextFocus' })">开始下一轮</button>
                <button type="button" class="btn btn--lg" @click="run({ type: 'finish' })">结束休息</button>
              </template>
              <template v-else>
                <button v-if="running" type="button" class="btn btn--lg" :disabled="!!clockIssue" @click="run({ type: 'pause' })">
                  <AppIcon name="pause" :size="18" />暂停
                </button>
                <button v-else type="button" class="btn btn--primary btn--lg" :disabled="!!clockIssue" @click="run({ type: 'resume' })">
                  <AppIcon name="play" :size="18" />继续
                </button>
                <button type="button" class="btn btn--lg" :disabled="!!clockIssue" @click="run({ type: 'finish' })">
                  <AppIcon name="stop" :size="16" />结束并保存
                </button>
                <button v-if="active.timer" type="button" class="btn btn--lg" :disabled="!!clockIssue" @click="run({ type: 'finishAndRest' })">
                  提前休息
                </button>
              </template>
              <button type="button" class="btn btn--ghost" @click="discard">放弃</button>
            </div>
          </div>
        </div>
      </section>

      <div class="split">
      <aside class="stack">
        <section class="card">
          <h2 class="section-title">今日与本周</h2>
          <div class="metric-grid">
            <div class="metric">
              <span class="metric__value">{{ formatFocusDuration(todayMs).slice(0, 5) }}</span>
              <span class="metric__label">今天已专注（时:分）</span>
            </div>
            <div class="metric">
              <span class="metric__value">{{ formatFocusDuration(progress?.elapsedMs ?? 0).slice(0, 5) }}</span>
              <span class="metric__label">本周已专注</span>
            </div>
          </div>
          <div class="bar-chart" style="margin-top: 18px" aria-label="最近 7 天专注时长">
            <div v-for="day in last7" :key="day.key" class="bar-chart__col" :title="`${day.key}：${formatFocusDuration(day.ms)}`">
              <span class="bar-chart__value">{{ Math.round(day.ms / 60000) || '' }}</span>
              <span class="bar-chart__bar" :style="{ height: `${Math.max(2, (day.ms / maxDayMs) * 100)}%` }" />
              <span class="bar-chart__label">{{ day.label }}</span>
            </div>
          </div>
          <p class="muted small" style="margin: 8px 0 0">柱上数字为分钟；只统计已结束或已暂停保存的时段。</p>
        </section>

        <section class="card">
          <div class="card__head">
            <div>
              <h2 class="card__title"><AppIcon name="target" :size="18" />本周目标</h2>
              <p class="card__hint">按上海时间周一到周日统计，只能设置当前这一周。</p>
            </div>
          </div>
          <template v-if="progress?.targetMinutes">
            <div class="row row--between small">
              <span>目标 {{ goalDuration(progress.targetMinutes) }}</span>
              <strong>{{ progress.percent }}%</strong>
            </div>
            <div class="progress" style="margin: 8px 0">
              <span class="progress__bar" :style="{ width: `${progress.percent}%` }" />
            </div>
            <p class="muted small" style="margin: 0">
              {{ progress.remainingMs ? `还差 ${formatFocusDuration(progress.remainingMs).slice(0, 5)}` : '本周目标已达成 🎉' }}
            </p>
          </template>
          <p v-else class="muted small">还没有设置本周目标。</p>
          <div class="row" style="margin-top: 12px">
            <input
              v-model="goalDraft"
              type="number"
              min="0.25"
              max="168"
              step="0.25"
              inputmode="decimal"
              placeholder="小时，如 10"
              aria-label="本周目标（小时）"
              style="max-width: 140px"
            />
            <button type="button" class="btn btn--sm btn--primary" :disabled="!goalDraft || goals.saving.value" @click="saveGoal()">
              保存
            </button>
            <button v-if="progress?.targetMinutes" type="button" class="btn btn--sm btn--ghost" @click="saveGoal(true)">清除</button>
          </div>
          <p v-if="goalError" class="field__error">{{ goalError }}</p>
        </section>
      </aside>

      <section class="card focus-records">
        <div class="card__head">
          <div>
            <h2 class="card__title"><AppIcon name="clock" :size="18" />专注记录</h2>
            <p class="card__hint">最近 30 条；可以补记忘了计时的学习，或更正记错的时间。</p>
          </div>
          <button type="button" class="btn btn--sm" :disabled="!!active" @click="openEditor(null)">
            <AppIcon name="plus" :size="16" />补记
          </button>
        </div>
        <p v-if="recentRecords.length === 0" class="muted">还没有专注记录。开始第一次专注吧。</p>
        <div v-else class="list-rows">
          <div v-for="record in recentRecords" :key="record.id" class="list-row">
            <div class="list-row__main">
              <div class="list-row__title">
                {{ record.title }}
                <span v-if="record.history" class="badge badge--muted">{{ record.history.kind === 'manual' ? '补记' : '已更正' }}</span>
              </div>
              <div class="list-row__meta">
                {{ historyLabel(record.startedAt).slice(0, 16) }} – {{ historyLabel(record.endedAt).slice(11, 16) }}
                <template v-if="record.courseName"> · {{ record.courseName }}</template>
                <template v-if="record.intervals.length > 1"> · {{ record.intervals.length }} 段</template>
              </div>
            </div>
            <strong class="mono">{{ formatFocusDuration(recordDuration(record)) }}</strong>
            <button type="button" class="btn btn--sm btn--ghost" :disabled="!!active" @click="openEditor(record)">更正</button>
            <button type="button" class="btn btn--sm btn--ghost" :disabled="!!active" @click="deleteRecord(record)">删除</button>
          </div>
        </div>
      </section>
      </div>
    </div>

    <div v-if="editor.open" class="modal-backdrop" @click.self="editor.open = false">
      <div class="modal" role="dialog" aria-modal="true" aria-label="专注记录">
        <h2 class="card__title" style="margin-bottom: 14px">{{ editor.id === undefined ? '补记专注' : '更正专注记录' }}</h2>
        <div class="stack">
          <label class="field">
            <span class="field__label">学习内容</span>
            <input v-model="editor.title" type="text" maxlength="200" />
          </label>
          <label class="field">
            <span class="field__label">课程（可选）</span>
            <select v-model="editor.courseName">
              <option value="">不关联课程</option>
              <option v-if="editor.courseName && !courses.some((c) => c.name === editor.courseName)" :value="editor.courseName">
                {{ editor.courseName }}（历史名称）
              </option>
              <option v-for="course in courses" :key="course.id" :value="course.name">{{ course.name }}</option>
            </select>
          </label>
          <div v-for="(interval, index) in editor.intervals" :key="index" class="row">
            <input v-model="interval.start" type="datetime-local" aria-label="开始" />
            <span class="muted">至</span>
            <input v-model="interval.end" type="datetime-local" aria-label="结束" />
            <button
              v-if="editor.intervals.length > 1"
              type="button"
              class="btn btn--sm btn--ghost"
              @click="editor.intervals.splice(index, 1)"
            >
              移除
            </button>
          </div>
          <button
            type="button"
            class="btn btn--sm btn--ghost"
            style="align-self: flex-start"
            @click="editor.intervals.push({ ...editor.intervals.at(-1) })"
          >
            <AppIcon name="plus" :size="15" />再加一段
          </button>
          <p class="muted small" style="margin: 0">时间按北京时间填写；不能是未来时间，也不能与其他记录重叠。</p>
          <p v-if="editor.error" class="field__error">{{ editor.error }}</p>
          <div class="row" style="justify-content: flex-end">
            <button type="button" class="btn btn--ghost" @click="editor.open = false">取消</button>
            <button type="button" class="btn btn--primary" :disabled="focus.saving.value" @click="saveEditor">保存</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.focus-layout {
  display: grid;
  gap: var(--space-4);
}

.focus-stage {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: clamp(18px, 3vw, 32px);
  background:
    radial-gradient(120% 90% at 20% 0%, var(--primary-tint), transparent 60%),
    var(--surface);
}

.focus-stage__head {
  min-height: 40px;
}

.focus-stage__body {
  display: grid;
  gap: clamp(18px, 3vw, 36px);
  align-items: center;
}

@media (min-width: 1180px) {
  .focus-stage__body {
    grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
  }
}

.focus-stage__dial .dial {
  width: min(420px, 100%);
}

.focus-stage__dial {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.focus-subject {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  text-align: center;
}

.focus-subject__course {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 12px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 13px;
  font-weight: 600;
}

.focus-subject__title {
  font-size: clamp(1.15rem, 2.4vw, 1.5rem);
  font-weight: 700;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}

.focus-stage__panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.focus-setup__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
}

.focus-setup__label {
  width: 2.5em;
}

.focus-start {
  width: 100%;
  justify-content: center;
}

.focus-controls .btn {
  width: 100%;
  justify-content: center;
}

.focus-stage--fullscreen {
  justify-content: center;
  padding: 5vh 6vw;
  border-radius: 0;
  background: var(--bg);
}

.focus-stage--fullscreen .dial {
  width: min(560px, 72vh);
}

.focus-records {
  grid-column: 1 / -1;
}
</style>
