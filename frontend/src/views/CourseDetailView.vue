<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ApiError, courseApi, scheduleApi, taskApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import EmptyState from '@/components/EmptyState.vue'
import LoadingState from '@/components/LoadingState.vue'
import TaskItem from '@/components/TaskItem.vue'
import { formatClock, weekdayOptions } from '@/utils/datetime'

const route = useRoute()
const courseId = Number(route.params.id)

const loading = ref(true)
const error = ref('')
const course = ref(null)
const schedules = ref([])
const tasks = ref([])
const busy = ref(false)

const form = reactive({
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
const editingId = ref(null)
const fieldErrors = ref({})

async function load() {
  loading.value = true
  error.value = ''
  try {
    course.value = await courseApi.get(courseId)
    schedules.value = await scheduleApi.listByCourse(courseId)
    const page = await taskApi.list({ courseId, includeDone: true, size: 100 })
    tasks.value = page.content
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

function resetForm() {
  editingId.value = null
  fieldErrors.value = {}
  Object.assign(form, {
    weekday: 1,
    startTime: '08:00',
    endTime: '09:40',
    location: '',
    periodStart: '',
    periodEnd: '',
    weekRange: '1-16',
    semesterStartDate: form.semesterStartDate || '',
    startWeek: form.startWeek || '',
    endWeek: form.endWeek || '',
    weekPattern: form.weekPattern || 'ALL',
  })
}

function startEdit(schedule) {
  editingId.value = schedule.id
  fieldErrors.value = {}
  Object.assign(form, {
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
}

async function save() {
  busy.value = true
  fieldErrors.value = {}
  error.value = ''
  const payload = {
    weekday: Number(form.weekday),
    startTime: form.startTime,
    endTime: form.endTime,
    location: form.location.trim() || null,
    periodStart: form.periodStart === '' ? null : Number(form.periodStart),
    periodEnd: form.periodEnd === '' ? null : Number(form.periodEnd),
    weekRange: form.weekRange.trim() || null,
    semesterStartDate: form.semesterStartDate || null,
    startWeek: form.startWeek === '' ? null : Number(form.startWeek),
    endWeek: form.endWeek === '' ? null : Number(form.endWeek),
    weekPattern: form.weekPattern || 'ALL',
  }
  try {
    if (editingId.value) {
      await scheduleApi.update(courseId, editingId.value, payload)
    } else {
      await scheduleApi.create(courseId, payload)
    }
    resetForm()
    await load()
  } catch (err) {
    if (err instanceof ApiError) fieldErrors.value = err.fieldErrorMap()
    error.value = err.message
  } finally {
    busy.value = false
  }
}

async function remove(schedule) {
  if (!window.confirm('确定删除这条课表？')) return
  try {
    await scheduleApi.remove(courseId, schedule.id)
    await load()
  } catch (err) {
    error.value = err.message
  }
}

async function toggleStatus(task) {
  const closed = task.status === 'DONE' || task.status === 'ARCHIVED'
  try {
    await taskApi.changeStatus(task.id, closed ? 'TODO' : 'DONE')
    await load()
  } catch (err) {
    error.value = err.message
  }
}

const openTasks = computed(() => tasks.value.filter((task) => task.status === 'TODO' || task.status === 'DOING'))
const closedTasks = computed(() => tasks.value.filter((task) => task.status === 'DONE' || task.status === 'ARCHIVED'))

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>{{ course ? course.name : '课程详情' }}</h1>
        <p class="page-head__sub" v-if="course">
          <span class="mono">{{ course.code }}</span> · {{ course.instructor || '未填教师' }} ·
          {{ course.semester || '未填学期' }}
        </p>
      </div>
      <RouterLink class="btn" to="/courses/manage">返回课程列表</RouterLink>
    </div>

    <LoadingState v-if="loading" title="正在加载课程…" />
    <ErrorState v-else-if="!course" :message="error" @retry="load" />

    <template v-else>
      <div v-if="error" class="alert alert--danger" style="margin-bottom: 16px">{{ error }}</div>

      <section class="card">
        <div class="card__head">
          <div>
            <div class="card__title">
              <AppIcon name="calendar" :size="18" />
              这门课的课表（{{ schedules.length }}）
            </div>
            <p class="card__hint">这些时间点以后会用来解析「下节课前交」</p>
          </div>
        </div>
        <ul v-if="schedules.length" class="task-list">
          <li v-for="schedule in schedules" :key="schedule.id" class="task-item">
            <div class="task-item__main">
              <div class="task-item__title">
                <span class="badge badge--primary">{{ schedule.weekdayLabel }}</span>
                {{ formatClock(schedule.startTime) }} – {{ formatClock(schedule.endTime) }}
              </div>
              <div class="task-item__meta">
                <span v-if="schedule.location">{{ schedule.location }}</span>
                <span v-if="schedule.periodStart">第 {{ schedule.periodStart }}–{{ schedule.periodEnd }} 节</span>
                <span>{{ schedule.weekSummary }}</span>
            <span v-if="!schedule.teachingWeeksConfigured" class="badge badge--warn">建议补学期起点</span>
              </div>
            </div>
            <div class="task-item__side">
              <div class="row">
                <button class="btn btn--sm" type="button" @click="startEdit(schedule)">编辑</button>
                <button class="btn btn--sm btn--danger" type="button" @click="remove(schedule)">删除</button>
              </div>
            </div>
          </li>
        </ul>
        <EmptyState v-else icon="calendar" title="这门课还没有课表" />

        <hr class="divider" />

        <h3 style="margin-bottom: 12px">{{ editingId ? '编辑课表' : '新增课表' }}</h3>
        <div class="form-grid">
          <label class="field">
            <span class="field__label">星期<span class="field__required">*</span></span>
            <select v-model="form.weekday">
              <option v-for="option in weekdayOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label class="field" :class="{ 'field--invalid': fieldErrors.startTime }">
            <span class="field__label">开始时间<span class="field__required">*</span></span>
            <input v-model="form.startTime" type="time" />
            <span v-if="fieldErrors.startTime" class="field__error">{{ fieldErrors.startTime }}</span>
          </label>
          <label class="field">
            <span class="field__label">结束时间<span class="field__required">*</span></span>
            <input v-model="form.endTime" type="time" />
          </label>
          <label class="field">
            <span class="field__label">地点</span>
            <input v-model="form.location" type="text" maxlength="128" />
          </label>
          <label class="field">
            <span class="field__label">起始节次</span>
            <input v-model="form.periodStart" type="number" min="1" max="12" />
          </label>
          <label class="field">
            <span class="field__label">结束节次</span>
            <input v-model="form.periodEnd" type="number" min="1" max="12" />
          </label>
          <label class="field">
            <span class="field__label">教学周范围</span>
            <input v-model="form.weekRange" type="text" maxlength="32" placeholder="1-16（文字说明）" />
          </label>
          <label class="field">
            <span class="field__label">学期第一周周一</span>
            <input v-model="form.semesterStartDate" type="date" />
            <span class="field__hint">填写后按起止周与单双周过滤；必须选周一</span>
          </label>
          <label class="field">
            <span class="field__label">起始 / 结束教学周</span>
            <div class="row" style="gap: 6px">
              <input v-model="form.startWeek" type="number" min="1" max="53" step="1" placeholder="1" />
              <input v-model="form.endWeek" type="number" min="1" max="53" step="1" placeholder="16" />
            </div>
          </label>
          <label class="field">
            <span class="field__label">上课周次</span>
            <select v-model="form.weekPattern">
              <option value="ALL">每周</option>
              <option value="ODD">单周</option>
              <option value="EVEN">双周</option>
            </select>
          </label>
        </div>
        <div class="row" style="margin-top: 12px">
          <button class="btn btn--primary" type="button" :disabled="busy" @click="save">
            {{ editingId ? '保存课表' : '新增课表' }}
          </button>
          <button v-if="editingId" class="btn btn--ghost" type="button" @click="resetForm">取消编辑</button>
        </div>
      </section>

      <div class="grid grid--2">
        <section class="card">
          <div class="card__head">
            <div class="card__title">
              <AppIcon name="list" :size="18" />
              未完成任务（{{ openTasks.length }}）
            </div>
            <RouterLink class="btn btn--sm" to="/tasks/new">新增任务</RouterLink>
          </div>
          <ul v-if="openTasks.length" class="task-list">
            <TaskItem v-for="task in openTasks" :key="task.id" :task="task" :show-course="false" @toggle-status="toggleStatus" />
          </ul>
          <EmptyState v-else icon="check" title="这门课没有未完成任务" />
        </section>

        <section class="card">
          <div class="card__head">
            <div class="card__title">
              <AppIcon name="check" :size="18" />
              已完成（{{ closedTasks.length }}）
            </div>
          </div>
          <ul v-if="closedTasks.length" class="task-list">
            <TaskItem v-for="task in closedTasks" :key="task.id" :task="task" :show-course="false" @toggle-status="toggleStatus" />
          </ul>
          <EmptyState v-else icon="inbox" title="还没有完成的任务" />
        </section>
      </div>
    </template>
  </div>
</template>
