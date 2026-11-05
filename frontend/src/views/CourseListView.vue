<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ApiError, courseApi, scheduleApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import EmptyState from '@/components/EmptyState.vue'
import LoadingState from '@/components/LoadingState.vue'
import { formatClock, weekdayName, weekdayOptions } from '@/utils/datetime'

const loading = ref(true)
const error = ref('')
const courses = ref([])
const schedules = ref([])

const courseForm = reactive({ code: '', name: '', instructor: '', semester: '', color: '#b4573a', note: '' })
const editingCourseId = ref(null)
const courseFormEl = ref(null)
const scheduleFormEl = ref(null)
/** 正在编辑的表单闪一下高亮，提示"数据已经填到这里了"。 */
const flashForm = ref('')

/** 点「编辑」后表单在列表下方很远处：滚过去、聚焦第一个输入框并高亮，否则看起来像没反应。 */
async function revealForm(which) {
  await nextTick()
  const el = which === 'course' ? courseFormEl.value : scheduleFormEl.value
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  el.querySelector('input, select, textarea')?.focus({ preventScroll: true })
  flashForm.value = ''
  await nextTick()
  flashForm.value = which
  window.setTimeout(() => {
    if (flashForm.value === which) flashForm.value = ''
  }, 1600)
}
const courseBusy = ref(false)
const courseErrors = ref({})

const scheduleForm = reactive({
  courseId: '',
  weekday: 1,
  startTime: '08:00',
  endTime: '09:40',
  location: '',
  periodStart: '',
  periodEnd: '',
  weekRange: '1-16',
  semesterStartDate: '',
  startWeek: '',
  endWeek: '',
  weekPattern: 'ALL',
})
const editingScheduleId = ref(null)
const scheduleBusy = ref(false)
const scheduleErrors = ref({})

/** 记住最近一次填写的教学周设置，新增下一条时自动带出，减少重复输入。 */
const lastScheduleWeeks = reactive({ weekRange: '1-16', semesterStartDate: '', startWeek: '', endWeek: '' })

const scheduleByWeekday = computed(() => {
  const map = new Map()
  for (const item of schedules.value) {
    if (!map.has(item.weekday)) map.set(item.weekday, [])
    map.get(item.weekday).push(item)
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.startTime.localeCompare(b.startTime))
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0])
})

const courseById = computed(() => {
  const map = new Map()
  for (const course of courses.value) map.set(course.id, course)
  return map
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [courseList, scheduleList] = await Promise.all([courseApi.list(), scheduleApi.list()])
    courses.value = courseList
    schedules.value = scheduleList
    if (!scheduleForm.courseId && courseList.length) scheduleForm.courseId = courseList[0].id
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

function resetCourseForm() {
  editingCourseId.value = null
  courseErrors.value = {}
  Object.assign(courseForm, { code: '', name: '', instructor: '', semester: '', color: '#b4573a', note: '' })
}

function startEditCourse(course) {
  editingCourseId.value = course.id
  courseErrors.value = {}
  Object.assign(courseForm, {
    code: course.code,
    name: course.name,
    instructor: course.instructor || '',
    semester: course.semester || '',
    color: course.color || '#b4573a',
    note: course.note || '',
  })
  revealForm('course')
}

async function saveCourse() {
  courseBusy.value = true
  courseErrors.value = {}
  error.value = ''
  try {
    const payload = { ...courseForm }
    if (editingCourseId.value) {
      await courseApi.update(editingCourseId.value, payload)
    } else {
      await courseApi.create(payload)
    }
    resetCourseForm()
    await load()
  } catch (err) {
    if (err instanceof ApiError) courseErrors.value = err.fieldErrorMap()
    error.value = err.message
  } finally {
    courseBusy.value = false
  }
}

async function removeCourse(course) {
  if (!window.confirm(`确定删除课程「${course.name}」？`)) return
  try {
    await courseApi.remove(course.id, false)
    await load()
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      if (window.confirm(`${err.message}\n\n点「确定」按上述安全方式强制删除。`)) {
        try {
          await courseApi.remove(course.id, true)
          await load()
        } catch (inner) {
          error.value = inner.message
        }
      }
    } else {
      error.value = err.message
    }
  }
}

function resetScheduleForm() {  editingScheduleId.value = null
  scheduleErrors.value = {}
  Object.assign(scheduleForm, {
    courseId: courses.value.length ? courses.value[0].id : '',
    weekday: 1,
    startTime: '08:00',
    endTime: '09:40',
    location: '',
    periodStart: '',
    periodEnd: '',
    weekRange: lastScheduleWeeks.weekRange,
    semesterStartDate: scheduleForm.semesterStartDate || lastScheduleWeeks.semesterStartDate,
    startWeek: lastScheduleWeeks.startWeek,
    endWeek: lastScheduleWeeks.endWeek,
    weekPattern: scheduleForm.weekPattern || 'ALL',
  })
}

function startEditSchedule(schedule) {
  editingScheduleId.value = schedule.id
  scheduleErrors.value = {}
  Object.assign(scheduleForm, {
    courseId: schedule.courseId,
    weekday: schedule.weekday,
    startTime: formatClock(schedule.startTime),
    endTime: formatClock(schedule.endTime),
    location: schedule.location || '',
    periodStart: schedule.periodStart || '',
    periodEnd: schedule.periodEnd || '',
    weekRange: schedule.weekRange || '',
    semesterStartDate: schedule.semesterStartDate || '',
    startWeek: schedule.startWeek ?? '',
    endWeek: schedule.endWeek ?? '',
    weekPattern: schedule.weekPattern || 'ALL',
  })
  revealForm('schedule')
}

async function saveSchedule() {
  if (!scheduleForm.courseId) {
    error.value = '请先创建一门课程，再添加课表'
    return
  }
  scheduleBusy.value = true
  scheduleErrors.value = {}
  error.value = ''
  const payload = {
    weekday: Number(scheduleForm.weekday),
    startTime: scheduleForm.startTime,
    endTime: scheduleForm.endTime,
    location: scheduleForm.location.trim() || null,
    periodStart: scheduleForm.periodStart === '' ? null : Number(scheduleForm.periodStart),
    periodEnd: scheduleForm.periodEnd === '' ? null : Number(scheduleForm.periodEnd),
    weekRange: scheduleForm.weekRange.trim() || null,
    semesterStartDate: scheduleForm.semesterStartDate || null,
    startWeek: scheduleForm.startWeek === '' ? null : Number(scheduleForm.startWeek),
    endWeek: scheduleForm.endWeek === '' ? null : Number(scheduleForm.endWeek),
    weekPattern: scheduleForm.weekPattern || 'ALL',
  }
  try {
    if (editingScheduleId.value) {
      await scheduleApi.update(scheduleForm.courseId, editingScheduleId.value, payload)
    } else {
      await scheduleApi.create(scheduleForm.courseId, payload)
    }
    // 记住最近填写的学期起点与周次，减少重复输入
    Object.assign(lastScheduleWeeks, {
      weekRange: scheduleForm.weekRange || '1-16',
      semesterStartDate: scheduleForm.semesterStartDate || '',
      startWeek: scheduleForm.startWeek === '' ? '' : Number(scheduleForm.startWeek),
      endWeek: scheduleForm.endWeek === '' ? '' : Number(scheduleForm.endWeek),
    })
    resetScheduleForm()
    await load()
  } catch (err) {
    if (err instanceof ApiError) scheduleErrors.value = err.fieldErrorMap()
    error.value = err.message
  } finally {
    scheduleBusy.value = false
  }
}

async function removeSchedule(schedule) {
  if (!window.confirm('确定删除这条课表？')) return
  try {
    await scheduleApi.remove(schedule.courseId, schedule.id)
    await load()
  } catch (err) {
    error.value = err.message
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>编辑课程</h1>
        <p class="page-head__sub">增删改课程和每周上课安排，支持照片导入与单双周设置。</p>
      </div>
      <div class="row">
        <RouterLink class="btn" to="/courses">
          <AppIcon name="chevronRight" :size="16" style="transform: rotate(180deg)" />
          返回课表
        </RouterLink>
        <RouterLink class="btn btn--primary" to="/courses/import-schedule">
          <AppIcon name="camera" :size="17" />
          照片导入课表
        </RouterLink>
      </div>
    </div>

    <ErrorState v-if="error && !courses.length" :message="error" @retry="load" />
    <LoadingState v-else-if="loading" title="正在加载课程与课表…" />
    <template v-else>
      <div v-if="error" class="alert alert--danger" style="margin-bottom: 16px">{{ error }}</div>

      <section class="card">
        <div class="card__head">
          <div>
            <div class="card__title">
              <AppIcon name="book" :size="18" />
              课程（{{ courses.length }}）
            </div>
            <p class="card__hint">点击课程名称，查看关联任务与上课安排。</p>
          </div>
        </div>

        <div v-if="courses.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>课程代码</th>
                <th>名称</th>
                <th>教师</th>
                <th>学期</th>
                <th>任务</th>
                <th>课表</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="course in courses" :key="course.id">
                <td>
                  <span class="dot" :style="{ background: course.color || '#65746b' }" />
                  <span class="mono">{{ course.code }}</span>
                </td>
                <td>
                  <RouterLink :to="`/courses/${course.id}`">{{ course.name }}</RouterLink>
                </td>
                <td>{{ course.instructor || '—' }}</td>
                <td>{{ course.semester || '—' }}</td>
                <td>{{ course.taskCount }}</td>
                <td>{{ course.scheduleCount }}</td>
                <td>
                  <div class="row">
                    <button class="btn btn--sm" type="button" @click="startEditCourse(course)">编辑</button>
                    <button class="btn btn--sm btn--danger" type="button" @click="removeCourse(course)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <EmptyState v-else icon="book" title="还没有课程" description="先建一门课，再给它排课表和添加任务。" />

        <hr class="divider" />

        <div ref="courseFormEl" class="edit-form" :class="{ 'edit-form--active': editingCourseId, 'edit-form--flash': flashForm === 'course' }">
        <h3 style="margin-bottom: 12px">{{ editingCourseId ? `编辑课程：${courseForm.name || courseForm.code}` : '新增课程' }}</h3>
        <div class="form-grid">
          <label class="field" :class="{ 'field--invalid': courseErrors.code }">
            <span class="field__label">课程代码<span class="field__required">*</span></span>
            <input v-model="courseForm.code" type="text" maxlength="32" placeholder="CS201" />
            <span v-if="courseErrors.code" class="field__error">{{ courseErrors.code }}</span>
          </label>
          <label class="field" :class="{ 'field--invalid': courseErrors.name }">
            <span class="field__label">课程名称<span class="field__required">*</span></span>
            <input v-model="courseForm.name" type="text" maxlength="128" placeholder="数据结构" />
            <span v-if="courseErrors.name" class="field__error">{{ courseErrors.name }}</span>
          </label>
          <label class="field">
            <span class="field__label">任课教师</span>
            <input v-model="courseForm.instructor" type="text" maxlength="64" placeholder="王老师" />
          </label>
          <label class="field">
            <span class="field__label">学期</span>
            <input v-model="courseForm.semester" type="text" maxlength="32" placeholder="2025-2026 第二学期" />
          </label>
          <label class="field">
            <span class="field__label">显示颜色</span>
            <input v-model="courseForm.color" type="color" />
          </label>
          <label class="field">
            <span class="field__label">备注</span>
            <input v-model="courseForm.note" type="text" maxlength="500" placeholder="可选" />
          </label>
        </div>
        <div class="row" style="margin-top: 12px">
          <button class="btn btn--primary" type="button" :disabled="courseBusy" @click="saveCourse">
            {{ editingCourseId ? '保存课程' : '新增课程' }}
          </button>
          <button v-if="editingCourseId" class="btn btn--ghost" type="button" @click="resetCourseForm">
            取消编辑
          </button>
        </div>
        </div>
      </section>

      <section class="card">
        <div class="card__head">
          <div>
            <div class="card__title">
              <AppIcon name="calendar" :size="18" />
              课表（{{ schedules.length }} 条）
            </div>
            <p class="card__hint">按星期查看课程；填写学期起点后，可按教学周和单双周显示。</p>
          </div>
        </div>

        <div v-if="schedules.length" class="stack">
          <div v-for="[weekday, list] in scheduleByWeekday" :key="weekday">
            <h4 style="margin-bottom: 6px">{{ weekdayName(weekday) }}</h4>
            <ul class="task-list">
              <li v-for="schedule in list" :key="schedule.id" class="task-item">
                <div class="task-item__main">
                  <div class="task-item__title">
                    <span class="dot" :style="{ background: (courseById.get(schedule.courseId) || {}).color || '#65746b' }" />
                    {{ schedule.courseName }}
                  </div>
                  <div class="task-item__meta">
                    <span>{{ formatClock(schedule.startTime) }} – {{ formatClock(schedule.endTime) }}</span>
                    <span v-if="schedule.location">{{ schedule.location }}</span>
                    <span v-if="schedule.periodStart">第 {{ schedule.periodStart }}–{{ schedule.periodEnd }} 节</span>
                    <span>{{ schedule.weekSummary }}</span>
                    <span v-if="!schedule.teachingWeeksConfigured" class="badge badge--warn">
                      建议补学期起点后启用教学周
                    </span>
                  </div>
                </div>
                <div class="task-item__side">
                  <div class="row">
                    <button class="btn btn--sm" type="button" @click="startEditSchedule(schedule)">编辑</button>
                    <button class="btn btn--sm btn--danger" type="button" @click="removeSchedule(schedule)">
                      删除
                    </button>
                  </div>
                </div>
              </li>
            </ul>
          </div>
        </div>
        <EmptyState v-else icon="calendar" title="还没有课表" description="添加课表后，首页会自动显示今日课程。" />

        <hr class="divider" />

        <div ref="scheduleFormEl" class="edit-form" :class="{ 'edit-form--active': editingScheduleId, 'edit-form--flash': flashForm === 'schedule' }">
        <h3 style="margin-bottom: 12px">{{ editingScheduleId ? `编辑课表：${courseById.get(scheduleForm.courseId)?.name || ''}` : '新增课表' }}</h3>
        <div class="form-grid">
          <label class="field" :class="{ 'field--invalid': scheduleErrors.courseId }">
            <span class="field__label">课程<span class="field__required">*</span></span>
            <select v-model="scheduleForm.courseId">
              <option v-for="course in courses" :key="course.id" :value="course.id">
                {{ course.code }} {{ course.name }}
              </option>
            </select>
          </label>
          <label class="field" :class="{ 'field--invalid': scheduleErrors.weekday }">
            <span class="field__label">星期<span class="field__required">*</span></span>
            <select v-model="scheduleForm.weekday">
              <option v-for="option in weekdayOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
            <span v-if="scheduleErrors.weekday" class="field__error">{{ scheduleErrors.weekday }}</span>
          </label>
          <label class="field" :class="{ 'field--invalid': scheduleErrors.startTime }">
            <span class="field__label">开始时间<span class="field__required">*</span></span>
            <input v-model="scheduleForm.startTime" type="time" required />
            <span v-if="scheduleErrors.startTime" class="field__error">{{ scheduleErrors.startTime }}</span>
          </label>
          <label class="field" :class="{ 'field--invalid': scheduleErrors.endTime }">
            <span class="field__label">结束时间<span class="field__required">*</span></span>
            <input v-model="scheduleForm.endTime" type="time" required />
            <span v-if="scheduleErrors.endTime" class="field__error">{{ scheduleErrors.endTime }}</span>
          </label>
          <label class="field">
            <span class="field__label">地点</span>
            <input v-model="scheduleForm.location" type="text" maxlength="128" placeholder="教三 305" />
          </label>
          <label class="field">
            <span class="field__label">起始节次</span>
            <input v-model="scheduleForm.periodStart" type="number" min="1" max="12" placeholder="1" />
          </label>
          <label class="field">
            <span class="field__label">结束节次</span>
            <input v-model="scheduleForm.periodEnd" type="number" min="1" max="12" placeholder="2" />
          </label>
          <label class="field">
            <span class="field__label">教学周范围（文字，可留空）</span>
            <input v-model="scheduleForm.weekRange" type="text" maxlength="32" placeholder="1-16" />
          </label>
          <label class="field">
            <span class="field__label">学期第一周周一</span>
            <input v-model="scheduleForm.semesterStartDate" type="date" />
            <span class="field__hint">填写后才按起止周与单双周过滤；必须选周一</span>
          </label>
          <label class="field">
            <span class="field__label">起始教学周</span>
            <input v-model="scheduleForm.startWeek" type="number" min="1" max="53" placeholder="1" />
          </label>
          <label class="field">
            <span class="field__label">结束教学周</span>
            <input v-model="scheduleForm.endWeek" type="number" min="1" max="53" placeholder="16" />
          </label>
          <label class="field">
            <span class="field__label">上课周次</span>
            <select v-model="scheduleForm.weekPattern">
              <option value="ALL">每周</option>
              <option value="ODD">单周</option>
              <option value="EVEN">双周</option>
            </select>
          </label>
        </div>
        <div class="row" style="margin-top: 12px">
          <button class="btn btn--primary" type="button" :disabled="scheduleBusy || !courses.length" @click="saveSchedule">
            {{ editingScheduleId ? '保存课表' : '新增课表' }}
          </button>
          <button v-if="editingScheduleId" class="btn btn--ghost" type="button" @click="resetScheduleForm">
            取消编辑
          </button>
          <span v-if="!courses.length" class="small muted">请先新增课程</span>
        </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.edit-form {
  scroll-margin-top: 90px;
  border-radius: var(--radius-lg, 14px);
  transition: background-color 0.4s ease, box-shadow 0.4s ease;
}
.edit-form--active {
  padding: 14px;
  margin: 0 -14px;
  background: color-mix(in srgb, var(--primary) 7%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 35%, transparent);
}
.edit-form--flash {
  box-shadow: inset 0 0 0 2px var(--primary), 0 0 0 4px color-mix(in srgb, var(--primary) 25%, transparent);
}
</style>
