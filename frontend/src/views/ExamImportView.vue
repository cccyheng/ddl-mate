<script setup>
/**
 * 考试抓取：从教务系统导入考试，每场考试成为一条「考试」类 DDL（截止 = 考试开始时间）。
 * 已有的同课程同名考试：时间/地点变了就更新，没变就跳过；还没排时间的导入为「未定日期」。
 */
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { taskApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import { loadAllCourses, loadAllTasks } from '@/domain/adapters'
import { examDeadline, examDescription, examMinutes, examTitle, parseAcademicExams, PENDING_EXAMS_KEY } from '@/import/academicExams'
import { todayInBeijing } from '@domain/teachingWeek'

const today = todayInBeijing()
const loading = ref(true)
const error = ref('')
const courses = ref([])
const tasks = ref([])
const rows = ref([])
const sourceLabel = ref('')
const busy = ref(false)
const result = ref(null)
const fileInput = ref(null)

function normalize(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase()
}

function matchCourse(exam) {
  return (
    (exam.code && courses.value.find((c) => normalize(c.code) === normalize(exam.code))) ||
    courses.value.find((c) => normalize(c.name) === normalize(exam.name)) ||
    null
  )
}

function sameInstant(a, b) {
  if (!a && !b) return true
  if (!a || !b) return false
  return new Date(a).getTime() === new Date(b).getTime()
}

/** 接口返回的任务里课程是 course 对象（没有 courseId 字段）。 */
function taskCourseId(task) {
  return task.course?.id ?? task.courseId ?? null
}

/** 已有的同一场考试（同课程、同标题的考试类 DDL）。 */
function existingFor(row) {
  return (
    tasks.value.find(
      (t) => t.type === 'EXAM' && normalize(t.title) === normalize(row.title) && (row.courseId ? taskCourseId(t) === row.courseId : true),
    ) || null
  )
}

function planOf(row) {
  const existing = existingFor(row)
  if (!existing) return { action: 'create', existing: null }
  const changed =
    !sameInstant(existing.deadline ?? null, row.deadline) ||
    (existing.description || '') !== row.description ||
    taskCourseId(existing) !== row.courseId
  return { action: changed ? 'update' : 'same', existing }
}

function toRow(exam, index) {
  const course = matchCourse(exam)
  const row = {
    key: `${index}-${exam.code}-${exam.category}-${exam.date}`,
    exam,
    title: examTitle(exam),
    courseId: course ? course.id : null,
    deadline: examDeadline(exam),
    description: examDescription(exam),
    minutes: examMinutes(exam),
    past: Boolean(exam.date && exam.date < today),
    selected: false,
  }
  const plan = planOf(row)
  row.selected = !row.past && plan.action !== 'same'
  return row
}

const planned = computed(() => rows.value.map((row) => ({ row, ...planOf(row) })))
const selectedCount = computed(() => planned.value.filter((p) => p.row.selected && p.action !== 'same').length)

/** 课程和已有考试读完之后才能匹配课程、判断新建/更新。 */
let resolveReady
const ready = new Promise((resolve) => {
  resolveReady = resolve
})

async function load(exams, label) {
  await ready
  sourceLabel.value = label
  result.value = null
  rows.value = exams.map(toRow)
}

async function onFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  error.value = ''
  if (file.size > 30 * 1024 * 1024) {
    error.value = '文件太大（超过 30 MB）。'
    return
  }
  const parsed = parseAcademicExams(await file.text())
  if (parsed.error) {
    error.value = parsed.error
    return
  }
  await load(parsed.exams, file.name)
}

async function submit() {
  busy.value = true
  error.value = ''
  const summary = { created: 0, updated: 0, failed: [] }
  for (const { row, action, existing } of planned.value) {
    if (!row.selected || action === 'same') continue
    const title = row.title.trim().slice(0, 200)
    if (!title) continue
    try {
      if (action === 'update' && existing) {
        await taskApi.update(existing.id, {
          title,
          description: row.description,
          courseId: row.courseId,
          type: 'EXAM',
          status: existing.status,
          priority: existing.priority,
          deadline: row.deadline,
          estimatedMinutes: row.minutes ?? existing.estimatedMinutes ?? null,
          submitRequirement: existing.submitRequirement ?? null,
          submitMethod: existing.submitMethod ?? null,
        })
        summary.updated += 1
      } else {
        await taskApi.create({
          title,
          description: row.description,
          courseId: row.courseId,
          type: 'EXAM',
          priority: 4,
          deadline: row.deadline,
          estimatedMinutes: row.minutes,
        })
        summary.created += 1
      }
    } catch (err) {
      summary.failed.push(`${title}：${err.message}`)
    }
  }
  try {
    tasks.value = await loadAllTasks()
  } catch {
    /* 下次进页面再刷新 */
  }
  rows.value = rows.value.map((row) => ({ ...row, selected: false }))
  result.value = summary
  busy.value = false
}

onMounted(async () => {
  try {
    ;[courses.value, tasks.value] = await Promise.all([loadAllCourses(), loadAllTasks()])
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
    resolveReady()
  }
  // 课表导入页（书签 / 抓包文件）顺带收到的考试，交接到这里
  try {
    const pending = sessionStorage.getItem(PENDING_EXAMS_KEY)
    if (pending) {
      sessionStorage.removeItem(PENDING_EXAMS_KEY)
      const data = JSON.parse(pending)
      if (Array.isArray(data.exams) && data.exams.length) await load(data.exams, data.label || '学校教务系统')
    }
  } catch {
    /* 没有交接数据 */
  }
})

const actionLabel = { create: '新建', update: '更新时间/地点', same: '已导入，无变化' }
</script>

<template>
  <div>
    <header class="page-head">
      <div>
        <span class="page-head__eyebrow"><AppIcon name="exam" :size="15" />考试与复习</span>
        <h1>考试抓取</h1>
        <p class="page-head__sub">从学校教务系统「我的考试」导入考试安排。每场考试成为一条「考试」DDL，截止时间就是开考时间，考场和座位号写在说明里。</p>
      </div>
      <div class="row">
        <RouterLink class="btn" to="/exams">返回考试与复习</RouterLink>
      </div>
    </header>

    <section class="card">
      <h2 class="card__title" style="margin-bottom: 8px"><AppIcon name="upload" :size="18" />选择数据</h2>
      <p class="card__hint" style="margin-bottom: 12px">
        两种方式：用 <RouterLink to="/tools/school-import">课程抓取</RouterLink> 的书签时会顺带抓到本学期考试；
        或者选择在教务系统「我的考试」页面抓包导出的 <span class="mono">.har</span> 文件。文件只在浏览器里读取，不上传。
      </p>
      <button type="button" class="btn btn--primary" :disabled="busy" @click="fileInput?.click()">选择抓包文件</button>
      <input ref="fileInput" type="file" accept=".har,.json,.html,.htm" hidden @change="onFile" />
      <p v-if="error" class="field__error" style="margin-top: 10px">{{ error }}</p>
    </section>

    <section v-if="loading" class="card"><p class="muted small" style="margin: 0">正在读取你的课程和考试…</p></section>

    <section v-else-if="rows.length" class="card">
      <h2 class="card__title" style="margin-bottom: 6px">核对考试（{{ rows.length }} 场）</h2>
      <p class="card__hint" style="margin-bottom: 12px">
        来源：{{ sourceLabel }}。已经考过的默认不勾选；学校还没排时间的会导入为「未定日期」，排定后再导入一次就会补上时间和考场。
      </p>
      <div class="table-wrap">
        <table class="table exam-table">
          <thead>
            <tr>
              <th>导入</th>
              <th>考试</th>
              <th>关联课程</th>
              <th>时间</th>
              <th>考场 / 座位</th>
              <th>处理</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in planned" :key="item.row.key" :class="{ muted: item.row.past || item.action === 'same' }">
              <td><input v-model="item.row.selected" type="checkbox" :disabled="item.action === 'same'" /></td>
              <td><input v-model="item.row.title" type="text" maxlength="200" style="min-width: 180px" /></td>
              <td>
                <select v-model="item.row.courseId">
                  <option :value="null">不关联课程</option>
                  <option v-for="course in courses" :key="course.id" :value="course.id">{{ course.name }}</option>
                </select>
              </td>
              <td class="small">
                <template v-if="item.row.exam.date">
                  {{ item.row.exam.date }} {{ item.row.exam.startTime }}~{{ item.row.exam.endTime }}
                  <span v-if="item.row.past" class="badge">已考过</span>
                </template>
                <span v-else class="badge badge--warn">时间未安排</span>
              </td>
              <td class="small">
                {{ item.row.exam.location || '—' }}<template v-if="item.row.exam.seat"> · {{ item.row.exam.seat }} 号</template>
              </td>
              <td class="small">{{ actionLabel[item.action] }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="row" style="margin-top: 14px; gap: 12px; align-items: center">
        <button type="button" class="btn btn--primary" :disabled="busy || !selectedCount" @click="submit">
          {{ busy ? '正在导入…' : `导入勾选的 ${selectedCount} 场考试` }}
        </button>
        <span v-if="!selectedCount && !result" class="small muted">没有要导入的考试：勾选左边的方框。</span>
      </div>
    </section>

    <section v-if="result" class="card card--accent">
      <h2 class="card__title" style="margin-bottom: 8px"><AppIcon name="check" :size="18" />导入完成</h2>
      <p class="small" style="margin: 0 0 6px">新建 {{ result.created }} 场，更新 {{ result.updated }} 场。</p>
      <ul v-if="result.failed.length" class="small field__error" style="margin: 0 0 6px; padding-left: 18px">
        <li v-for="line in result.failed" :key="line">{{ line }}</li>
      </ul>
      <RouterLink class="btn btn--sm" to="/exams">去考试与复习看看 / 安排复习</RouterLink>
    </section>
  </div>
</template>

<style scoped>
.exam-table select,
.exam-table input[type='text'] {
  width: 100%;
}
.exam-table select {
  min-width: 140px;
}
tr.muted td {
  opacity: 0.6;
}
</style>
