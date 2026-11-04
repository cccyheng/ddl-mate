<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
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
import { courseApi } from '@/api'
import { useSetting } from '@/composables/useSetting'
import { dateKeyOf, shiftDateKey, weekdayShort } from '@/utils/dateKeys'

const focus = useSetting(FOCUS_KEY, { decode: decodeFocus, encode: (s) => JSON.stringify(s) })
const goals = useSetting(WEEKLY_GOAL_KEY, { decode: decodeWeeklyGoals, encode: (s) => JSON.stringify(s) })

const courses = ref([])
const loadError = ref('')
const actionError = ref('')
const now = ref(Date.now())
let ticker = null

const form = reactive({ mode: 'pomodoro', title: '', courseName: '', focusMinutes: 25, restMinutes: 5 })
const FOCUS_PRESETS = [15, 25, 45, 60, 90]
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
const DIAL_R = 116
const DIAL_C = 2 * Math.PI * DIAL_R
const dialOffset = computed(() => {
  if (!active.value) return form.mode === 'pomodoro' ? 0 : DIAL_C
  if (active.value.timer) return DIAL_C * (1 - elapsedMs.value / focusTarget(active.value))
  return DIAL_C * (1 - (elapsedMs.value % 3600000) / 3600000)
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
    const [, , courseList] = await Promise.all([focus.load(), goals.load(), courseApi.list()])
    courses.value = courseList
  } catch (err) {
    loadError.value = err.message
  }
})

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

    <div v-else class="split">
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
          <div v-else class="focus-stage__now">
            <strong>{{ active.title }}</strong>
            <span v-if="active.courseName" class="muted small"> · {{ active.courseName }}</span>
          </div>
          <button type="button" class="icon-btn" :title="isFullscreen ? '退出全屏' : '全屏专注'" @click="toggleFullscreen">
            <AppIcon :name="isFullscreen ? 'close' : 'spark'" :size="18" />
          </button>
        </div>

        <div class="dial" :class="{ 'dial--rest': isRest }">
          <svg viewBox="0 0 260 260" aria-hidden="true">
            <circle class="dial__track" cx="130" cy="130" :r="DIAL_R" fill="none" stroke-width="12" />
            <circle
              class="dial__arc"
              cx="130"
              cy="130"
              :r="DIAL_R"
              fill="none"
              stroke-width="12"
              stroke-linecap="round"
              :stroke-dasharray="DIAL_C"
              :stroke-dashoffset="dialOffset"
            />
          </svg>
          <div class="dial__center" role="timer" aria-live="off">
            <span class="dial__time">{{ dialText }}</span>
            <span class="dial__label">{{ dialLabel }}</span>
          </div>
        </div>

        <div v-if="clockIssue" class="alert alert--warn">
          {{ clockIssue }}
          <div class="row" style="margin-top: 8px">
            <button type="button" class="btn btn--sm" @click="run({ type: 'recover' })">舍弃未确认的计时段</button>
          </div>
        </div>
        <div v-if="actionError" class="alert alert--danger">{{ actionError }}</div>

        <!-- 未开始：设置 -->
        <div v-if="!active" class="stack focus-setup">
          <div class="form-grid">
            <label class="field">
              <span class="field__label">学习内容</span>
              <input v-model="form.title" type="text" maxlength="200" placeholder="例如：复习第三章（留空记为「自习」）" />
            </label>
            <label class="field">
              <span class="field__label">课程（可选）</span>
              <select v-model="form.courseName">
                <option value="">不关联课程</option>
                <option v-for="course in courses" :key="course.id" :value="course.name">{{ course.name }}</option>
              </select>
            </label>
          </div>
          <div v-if="form.mode === 'pomodoro'" class="stack">
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
          <button type="button" class="btn btn--primary btn--lg" :disabled="focus.saving.value" @click="start">
            <AppIcon name="play" :size="18" />开始{{ form.mode === 'pomodoro' ? '番茄专注' : '计时' }}
          </button>
        </div>

        <!-- 进行中：控制 -->
        <div v-else class="row focus-controls">
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
      </section>

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
.focus-stage {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.focus-stage__head {
  min-height: 40px;
}

.focus-stage__now {
  min-width: 0;
  overflow-wrap: anywhere;
}

.focus-stage--fullscreen {
  justify-content: center;
  padding: 6vh 8vw;
  border-radius: 0;
  background: var(--bg);
}

.focus-stage--fullscreen .dial {
  width: min(460px, 70vh);
}

.focus-setup__label {
  width: 2.5em;
}

.focus-controls {
  justify-content: center;
}

.focus-records {
  grid-column: 1 / -1;
}
</style>
