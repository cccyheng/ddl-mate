<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { scheduleApi, taskApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import EmptyState from '@/components/EmptyState.vue'
import LoadingState from '@/components/LoadingState.vue'
import { formatClock, formatDateTime, weekdayName } from '@/utils/datetime'

const route = useRoute()
const router = useRouter()

const loading = ref(true)
const error = ref('')
const schedules = ref([])
const tasks = ref([])

const dateKey = computed(() => String(route.params.date || ''))

/**
 * 严格校验日期：正则 + 真实日期回环（2026-02-31 这类不存在的日期必须拒绝），
 * 并限制合理年份范围。
 */
function parseStrictDate(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1970 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return { year, month, day, date }
}

const parsedDate = computed(() => parseStrictDate(dateKey.value))
const isValidDate = computed(() => Boolean(parsedDate.value))

const dateLabel = computed(() => {
  if (!parsedDate.value) return '日期无效'
  const { year, month, day } = parsedDate.value
  return `${year} 年 ${month} 月 ${day} 日`
})

const weekdayLabel = computed(() => {
  if (!parsedDate.value) return ''
  const value = parsedDate.value.date.getDay()
  return weekdayName(value === 0 ? 7 : value)
})

/** 返回月历时保留原来的月份。 */
const monthQuery = computed(() => {
  if (typeof route.query.month === 'string' && /^\d{4}-\d{2}$/.test(route.query.month)) {
    return route.query.month
  }
  return dateKey.value.slice(0, 7)
})

function shiftDate(days) {
  if (!parsedDate.value) return
  const { year, month, day } = parsedDate.value
  const next = new Date(year, month - 1, day + days)
  const pad = (value) => String(value).padStart(2, '0')
  const key = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`
  router.push({
    name: 'calendar-day',
    params: { date: key },
    query: { month: `${next.getFullYear()}-${pad(next.getMonth() + 1)}` },
  })
}

/** 快速切日时用请求序号防止旧响应覆盖新日期。 */
let requestId = 0

async function load() {
  // 先作废进行中的请求：这样"有效日期请求还没回来就切到非法日期"时，旧响应不会写回
  const current = ++requestId
  if (!isValidDate.value) {
    loading.value = false
    error.value = '这个日期不存在或格式不正确（例如 2026-02-31），请从月历选择日期'
    schedules.value = []
    tasks.value = []
    return
  }
  loading.value = true
  error.value = ''
  try {
    const [scheduleList, taskList] = await Promise.all([
      scheduleApi.byDate(dateKey.value),
      taskApi.byDate(dateKey.value),
    ])
    if (current !== requestId) return
    schedules.value = [...scheduleList].sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)))
    tasks.value = [...taskList].sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)))
  } catch (err) {
    if (current !== requestId) return
    error.value = err.message
  } finally {
    if (current === requestId) loading.value = false
  }
}

function openTask(task) {
  router.push(`/tasks/${task.id}`)
}

watch(dateKey, load)
onMounted(load)
// 离开页面后作废进行中的请求，避免已卸载组件的迟到响应写状态
onBeforeUnmount(() => {
  requestId += 1
})
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>{{ dateLabel }}</h1>
        <p class="page-head__sub">
          {{ weekdayLabel }} · 当天课程 {{ schedules.length }} 节 · DDL {{ tasks.length }} 个
        </p>
      </div>
      <div class="row">
        <button class="btn" type="button" :disabled="!isValidDate" @click="shiftDate(-1)">← 前一天</button>
        <button class="btn" type="button" :disabled="!isValidDate" @click="shiftDate(1)">后一天 →</button>
        <RouterLink class="btn" :to="{ name: 'calendar', query: { month: monthQuery } }">回月历</RouterLink>
      </div>
    </div>

    <ErrorState v-if="error" :message="error" @retry="load" />
    <LoadingState v-else-if="loading" title="正在加载当天安排…" />

    <template v-else>
      <section class="card">
        <div class="card__head">
          <div>
            <div class="card__title">
              <AppIcon name="clock" :size="18" />
              当天课程（{{ schedules.length }}）
            </div>
            <p class="card__hint">已按教学周与单双周规则过滤；点课程名进入课程详情</p>
          </div>
        </div>
        <ul v-if="schedules.length" class="task-list">
          <li v-for="schedule in schedules" :key="schedule.id" class="task-item">
            <div class="task-item__main">
              <div class="task-item__title">
                <span class="dot" :style="{ background: schedule.courseColor || '#65746b' }" />
                <RouterLink :to="`/courses/${schedule.courseId}`">{{ schedule.courseName }}</RouterLink>
                <span class="badge badge--primary">{{ schedule.weekPatternLabel }}</span>
              </div>
              <div class="task-item__meta">
                <span>{{ formatClock(schedule.startTime) }} – {{ formatClock(schedule.endTime) }}</span>
                <span v-if="schedule.location">{{ schedule.location }}</span>
                <span v-if="schedule.periodStart">第 {{ schedule.periodStart }}–{{ schedule.periodEnd }} 节</span>
                <span>{{ schedule.weekSummary }}</span>
              </div>
            </div>
          </li>
        </ul>
        <EmptyState v-else icon="calendar" title="这一天没有课" description="当天没有需要上的课程。" />
      </section>

      <section class="card">
        <div class="card__head">
          <div>
            <div class="card__title">
              <AppIcon name="alert" :size="18" />
              当天 DDL（{{ tasks.length }}）
            </div>
            <p class="card__hint">在当天截止的任务，点标题查看任务详情</p>
          </div>
          <RouterLink class="btn btn--sm" to="/tasks/new">+ 新建任务</RouterLink>
        </div>
        <ul v-if="tasks.length" class="task-list">
          <li v-for="task in tasks" :key="task.id" class="task-item">
            <div class="task-item__main">
              <div class="task-item__title">
                <span v-if="task.course" class="dot" :style="{ background: task.course.color || '#65746b' }" />
                <a href="#" @click.prevent="openTask(task)">{{ task.title }}</a>
                <span class="badge" :class="task.status === 'DONE' ? 'badge--success' : 'badge--muted'">
                  {{ task.statusLabel }}
                </span>
              </div>
              <div class="task-item__meta">
                <span>截止 {{ formatDateTime(task.deadline) }}</span>
                <span v-if="task.course">{{ task.course.name }}</span>
                <span>{{ task.typeLabel }}</span>
                <span v-if="task.estimatedMinutes">预计 {{ task.estimatedMinutes }} 分钟</span>
              </div>
              <p v-if="task.submitRequirement || task.submitMethod" class="small muted" style="margin: 4px 0 0">
                <template v-if="task.submitMethod">提交方式：{{ task.submitMethod }}</template>
                <template v-if="task.submitRequirement">
                  {{ task.submitMethod ? ' · ' : '' }}提交要求：{{ task.submitRequirement }}
                </template>
              </p>
            </div>
            <div class="task-item__side">
              <span class="badge" :class="task.priority >= 4 ? 'badge--warn' : 'badge--muted'">
                {{ task.priorityLabel }}
              </span>
              <RouterLink class="btn btn--sm btn--ghost" :to="`/tasks/${task.id}`">查看任务</RouterLink>
            </div>
          </li>
        </ul>
        <EmptyState v-else icon="check" title="这一天没有 DDL" description="当天没有截止的任务。" />
      </section>
    </template>
  </div>
</template>
