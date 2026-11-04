<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { shanghaiToday } from '@domain/datetime'
import { buildRevisionPreview, EXAM_REVISION_LIMITS, listExams } from '@domain/examRevision'
import { decodeExamRevisionStore, EXAM_PLAN_LIMIT } from '@domain/examRevisionRepository'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import LoadingState from '@/components/LoadingState.vue'
import { taskApi } from '@/api'
import { useSetting } from '@/composables/useSetting'
import { loadAllCourses, loadAllTasks, toDomainTask } from '@/domain/adapters'
import { SETTING_KEYS } from '@/domain/settingKeys'
import { revisionProgress } from '@/domain/links'
import { deadlineForWeb } from '@/domain/taskTypes'
import { shiftDateKey } from '@/utils/dateKeys'

const plans = useSetting(SETTING_KEYS.EXAM_REVISION, {
  decode: decodeExamRevisionStore,
  encode: (store) => JSON.stringify(store),
})

const tasks = ref([])
const courses = ref([])
const loading = ref(true)
const error = ref('')

const exams = computed(() => listExams(tasks.value, new Date()))
const active = computed(() => exams.value.filter((e) => ['today', 'upcoming', 'undated'].includes(e.phase)))
const past = computed(() => exams.value.filter((e) => !['today', 'upcoming', 'undated'].includes(e.phase)))
const courseName = (id) => courses.value.find((c) => c.id === id)?.name
const plansFor = (examId) => (plans.data.value?.plans ?? []).filter((p) => p.examId === examId)
const tasksById = computed(() => new Map(tasks.value.map((t) => [t.id, t])))
const progressOf = (exam) => revisionProgress(plans.data.value?.plans ?? [], exam.task.id, tasksById.value)

const PHASE_TONE = { today: 'danger', upcoming: 'primary', undated: 'warn', overdue: 'muted', done: 'success', cancelled: 'muted' }
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

const editor = reactive({
  open: false,
  exam: null,
  startDate: '',
  endDate: '',
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  topicsText: '',
  minutes: 60,
  preview: null,
  error: '',
  busy: false,
})

function openRevision(summary) {
  const today = shanghaiToday(new Date())
  const dayBefore = summary.date ? shiftDateKey(summary.date, -1) : today
  Object.assign(editor, {
    open: true,
    exam: summary.task,
    startDate: today,
    endDate: dayBefore < today ? today : dayBefore,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    topicsText: '',
    minutes: 60,
    preview: null,
    error: '',
    busy: false,
  })
}

function draftInput() {
  return {
    startDate: editor.startDate,
    endDate: editor.endDate,
    weekdays: editor.weekdays,
    topics: editor.topicsText.split('\n').map((t) => t.trim()).filter(Boolean),
    minutes: Number(editor.minutes),
  }
}

function toggleWeekday(day) {
  const set = new Set(editor.weekdays)
  if (set.has(day)) set.delete(day)
  else set.add(day)
  editor.weekdays = [...set].sort((a, b) => a - b)
}

function preview() {
  editor.error = ''
  const result = buildRevisionPreview(editor.exam, draftInput(), new Date())
  editor.preview = result.ok ? result.preview : null
  if (!result.ok) editor.error = result.reason
}

/** 创建：重新读取考试并重算，指纹一致才逐条创建复习任务，最后记录这份安排。 */
async function createRevision() {
  editor.busy = true
  editor.error = ''
  try {
    const store = await plans.load()
    if (store.plans.length >= EXAM_PLAN_LIMIT) throw new Error('复习安排已达到保存上限。')
    const fresh = toDomainTask(await taskApi.get(editor.exam.id))
    const result = buildRevisionPreview(fresh, draftInput(), new Date())
    if (!result.ok) throw new Error(result.reason)
    if (result.preview.fingerprint !== editor.preview.fingerprint) throw new Error('考试或日期已变化，请重新预览后再创建。')

    const taskIds = []
    for (const session of result.preview.sessions) {
      const created = await taskApi.create({
        title: session.title,
        description: `为「${fresh.title}」复习：${session.topic}`,
        courseId: fresh.courseId,
        type: 'OTHER',
        status: 'TODO',
        priority: 3,
        deadline: deadlineForWeb(session.date),
        estimatedMinutes: session.minutes,
      })
      taskIds.push(created.id)
    }
    const plan = {
      id: store.nextId,
      examId: fresh.id,
      examTitle: fresh.title,
      createdAt: new Date().toISOString(),
      fingerprint: result.preview.fingerprint,
      taskIds,
    }
    const next = { version: 1, nextId: store.nextId + 1, plans: [...store.plans, plan] }
    if (!(await plans.save(next))) throw new Error(`复习任务已创建，但安排记录没保存：${plans.error.value}`)
    editor.open = false
    await load()
  } catch (err) {
    editor.error = err.message
  } finally {
    editor.busy = false
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [all, courseList] = await Promise.all([loadAllTasks(), loadAllCourses(), plans.load()])
    tasks.value = all.map(toDomainTask)
    courses.value = courseList
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
        <span class="page-head__eyebrow"><AppIcon name="exam" :size="15" />考试</span>
        <h1>考试与复习</h1>
        <p class="page-head__sub">类型为「考试」的任务都在这里；可以按主题把复习排到考前的日子，生成普通任务。</p>
      </div>
      <RouterLink class="btn btn--primary" :to="{ path: '/tasks/new', query: { type: 'EXAM' } }">
        <AppIcon name="plus" :size="16" />新建考试
      </RouterLink>
    </header>

    <ErrorState v-if="error" :message="error" @retry="load" />
    <LoadingState v-else-if="loading" title="正在读取考试…" />

    <template v-else>
      <section v-if="exams.length === 0" class="card card--soft">
        <p class="muted" style="margin: 0">还没有考试。新建任务时把类型选为「考试」即可。</p>
      </section>

      <div v-if="active.length" class="grid grid--3" style="margin-bottom: 20px">
        <article v-for="exam in active" :key="exam.task.id" class="card card--interactive exam-card">
          <div class="row row--between">
            <span class="badge" :class="`badge--${PHASE_TONE[exam.phase]}`">{{ exam.label }}</span>
            <span v-if="exam.days !== null && exam.days >= 0" class="exam-card__days">{{ exam.days }}<small>天</small></span>
          </div>
          <RouterLink :to="`/tasks/${exam.task.id}`" class="exam-card__title">{{ exam.task.title }}</RouterLink>
          <p class="muted small" style="margin: 0">
            {{ courseName(exam.task.courseId) || '未关联课程' }}
            <template v-if="exam.task.deadline"> · {{ exam.task.deadline.slice(0, 16).replace('T', ' ') }}</template>
          </p>
          <template v-if="plansFor(exam.task.id).length">
            <div class="row row--between small" style="margin-top: 8px">
              <span>复习进度 {{ progressOf(exam).done }}/{{ progressOf(exam).total }}</span>
              <span v-if="progressOf(exam).missing" class="muted">{{ progressOf(exam).missing }} 个已删除</span>
            </div>
            <span class="progress">
              <span
                class="progress__bar"
                :style="{ width: `${progressOf(exam).total ? (progressOf(exam).done / progressOf(exam).total) * 100 : 0}%` }"
              />
            </span>
          </template>
          <div class="row" style="margin-top: auto; padding-top: 12px">
            <button type="button" class="btn btn--sm btn--primary" :disabled="exam.phase !== 'upcoming'" @click="openRevision(exam)">
              安排复习
            </button>
          </div>
        </article>
      </div>

      <section v-if="past.length" class="card">
        <h2 class="section-title">已结束 / 已完成</h2>
        <div class="list-rows">
          <RouterLink v-for="exam in past" :key="exam.task.id" :to="`/tasks/${exam.task.id}`" class="list-row exam-row">
            <span class="list-row__main">
              <span class="list-row__title">{{ exam.task.title }}</span>
              <span class="list-row__meta">{{ courseName(exam.task.courseId) || '未关联课程' }} · {{ exam.label }}</span>
            </span>
            <AppIcon name="chevronRight" :size="16" />
          </RouterLink>
        </div>
      </section>
    </template>

    <div v-if="editor.open" class="modal-backdrop" @click.self="editor.open = false">
      <div class="modal modal--wide" role="dialog" aria-modal="true" aria-label="安排复习">
        <h2 class="card__title" style="margin-bottom: 4px">安排复习：{{ editor.exam.title }}</h2>
        <p class="card__hint" style="margin-bottom: 14px">
          复习最晚到考试前一天；主题按顺序轮流排到选中的日子，每次最多 {{ EXAM_REVISION_LIMITS.maxSessions }} 次。
        </p>
        <div class="stack">
          <div class="form-grid">
            <label class="field">
              <span class="field__label">开始日期</span>
              <input v-model="editor.startDate" type="date" />
            </label>
            <label class="field">
              <span class="field__label">结束日期</span>
              <input v-model="editor.endDate" type="date" />
            </label>
            <label class="field">
              <span class="field__label">每次预计（分钟）</span>
              <input v-model="editor.minutes" type="number" min="1" max="1440" />
            </label>
          </div>
          <div class="row">
            <span class="muted small">星期</span>
            <button
              v-for="(label, index) in WEEKDAYS"
              :key="index"
              type="button"
              class="chip"
              :class="{ 'chip--active': editor.weekdays.includes(index + 1) }"
              @click="toggleWeekday(index + 1)"
            >
              周{{ label }}
            </button>
          </div>
          <label class="field">
            <span class="field__label">复习主题（每行一个）</span>
            <textarea v-model="editor.topicsText" rows="4" placeholder="第一章 绪论&#10;第二章 线性表&#10;真题一套" />
          </label>
          <button type="button" class="btn" style="align-self: flex-start" @click="preview">预览安排</button>
          <p v-if="editor.error" class="field__error">{{ editor.error }}</p>
          <div v-if="editor.preview" class="list-rows">
            <div v-for="session in editor.preview.sessions" :key="session.date" class="list-row">
              <span class="mono small">{{ session.date }}</span>
              <span class="list-row__main">{{ session.title }}</span>
              <span class="muted small">{{ session.minutes }} 分钟</span>
            </div>
          </div>
          <div class="row" style="justify-content: flex-end">
            <button type="button" class="btn btn--ghost" @click="editor.open = false">取消</button>
            <button
              type="button"
              class="btn btn--primary"
              :disabled="!editor.preview || editor.busy"
              @click="createRevision"
            >
              {{ editor.busy ? '正在创建…' : `创建 ${editor.preview?.sessions.length ?? 0} 个复习任务` }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.exam-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 0;
}

.exam-card + .exam-card {
  margin-top: 0;
}

.exam-card__title {
  font-size: 1.05rem;
  font-weight: 680;
  color: var(--text);
  overflow-wrap: anywhere;
}

.exam-card__days {
  font-size: 1.6rem;
  font-weight: 760;
  color: var(--primary);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.exam-card__days small {
  font-size: 0.8rem;
  margin-left: 2px;
  color: var(--text-muted);
}

.exam-row {
  color: inherit;
}

.exam-row:hover {
  text-decoration: none;
  background: var(--surface-soft);
}

.modal--wide {
  width: min(720px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  overflow-y: auto;
}
</style>
