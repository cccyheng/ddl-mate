<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { calendarApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import LoadingState from '@/components/LoadingState.vue'
import { summarizeMonth } from '@/utils/calendarStats'
import { formatTimeOfDay, toDateKey } from '@/utils/datetime'

/** embedded：嵌在「课程与课表」里作为月视图，不显示自己的页头。 */
const props = defineProps({ embedded: { type: Boolean, default: false } })

const route = useRoute()
const router = useRouter()

const todayKey = toDateKey(new Date())
const initial = parseMonthQuery(route.query.month)
const year = ref(initial.year)
const month = ref(initial.month)

const loading = ref(true)
const error = ref('')
const days = ref(new Map()) // 'YYYY-MM-DD' -> { tasks, schedules }
/** 请求序号：快速切月时防止旧响应覆盖新月份的数据。 */
let requestId = 0

const weekdayHeaders = ['一', '二', '三', '四', '五', '六', '日']
const monthTitle = computed(() => `${year.value} 年 ${month.value} 月`)

function parseMonthQuery(value) {
  const now = new Date()
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4})-(\d{1,2})$/)
    if (match) {
      const parsedMonth = Number(match[2])
      if (parsedMonth >= 1 && parsedMonth <= 12) {
        return { year: Number(match[1]), month: parsedMonth }
      }
    }
  }
  return { year: now.getFullYear(), month: now.getMonth() + 1 }
}

const monthStats = computed(() => summarizeMonth(days.value))

/** 6 行 × 7 列日期网格，周一是第一列。 */
const cells = computed(() => {
  const first = new Date(year.value, month.value - 1, 1)
  const offset = (first.getDay() + 6) % 7
  const start = new Date(year.value, month.value - 1, 1 - offset)
  const result = []
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    const key = toDateKey(date)
    const entry = days.value.get(key) || { tasks: [], schedules: [] }
    result.push({
      key,
      day: date.getDate(),
      inMonth: date.getMonth() === month.value - 1,
      isToday: key === todayKey,
      tasks: entry.tasks,
      schedules: entry.schedules,
    })
  }
  return result
})

async function load() {
  const current = ++requestId
  loading.value = true
  error.value = ''
  try {
    const response = await calendarApi.month(year.value, month.value)
    if (current !== requestId) return // 已经切到别的月份，丢弃这次响应
    const map = new Map()
    for (const day of response.days) {
      map.set(day.date, { tasks: day.tasks || [], schedules: day.schedules || [] })
    }
    days.value = map
    // 让"回月历""分享链接"能保留当前月份；只在仍停留在月历页时同步 URL
    const monthKey = `${year.value}-${String(month.value).padStart(2, '0')}`
    if (route.name === 'calendar' && route.query.month !== monthKey) {
      router.replace({ name: 'calendar', query: { ...route.query, month: monthKey } })
    }
  } catch (err) {
    if (current !== requestId) return
    error.value = err.message
  } finally {
    if (current === requestId) loading.value = false
  }
}

function prevMonth() {
  if (month.value === 1) {
    year.value -= 1
    month.value = 12
  } else {
    month.value -= 1
  }
}

function nextMonth() {
  if (month.value === 12) {
    year.value += 1
    month.value = 1
  } else {
    month.value += 1
  }
}

function goToday() {
  const now = new Date()
  year.value = now.getFullYear()
  month.value = now.getMonth() + 1
}

/**
 * 打开某一天的详情页。
 * 跨月格子直接按"那一格所属月份"生成链接，不在这里改本地年月
 * （否则会先触发一次无用的月数据加载，再跳走）。
 */
function openDay(cell) {
  const [cellYear, cellMonth] = cell.key.split('-').map(Number)
  router.push({
    name: 'calendar-day',
    params: { date: cell.key },
    query: { month: `${cellYear}-${String(cellMonth).padStart(2, '0')}` },
  })
}

function taskTone(task) {
  if (task.status === 'DONE' || task.status === 'ARCHIVED') return 'calendar-chip--success'
  if (task.deadline && new Date(task.deadline).getTime() < Date.now()) return 'calendar-chip--danger'
  return 'calendar-chip--open'
}

watch([year, month], load)
onMounted(load)
</script>

<template>
  <div>
    <div v-if="!props.embedded" class="page-head">
      <div>
        <h1>日历</h1>
        <p class="page-head__sub">课程与 DDL 一起看；点任意一天进入当天详情</p>
      </div>
      <div class="row">
        <button class="btn" type="button" @click="goToday">回到今天</button>
        <RouterLink class="btn" to="/courses/import-schedule">
          <AppIcon name="camera" :size="17" />
          照片导入课表
        </RouterLink>
        <RouterLink class="btn btn--primary" to="/tasks/new">
          <AppIcon name="plus" :size="17" />
          新建任务
        </RouterLink>
      </div>
    </div>

    <section class="card">
      <div class="calendar-head">
        <div class="row">
          <button class="btn btn--sm" type="button" aria-label="上一月" title="上一月" @click="prevMonth">
            <AppIcon name="chevronRight" :size="16" style="transform: rotate(180deg)" />
          </button>
          <span class="calendar-title">{{ monthTitle }}</span>
          <button class="btn btn--sm" type="button" aria-label="下一月" title="下一月" @click="nextMonth">
            <AppIcon name="chevronRight" :size="16" />
          </button>
        </div>
        <span class="small muted">
          有安排的 {{ monthStats.activeDays }} 天 · 课程 {{ monthStats.courseCount }} 节 · DDL
          {{ monthStats.taskCount }} 个
        </span>
      </div>

      <ErrorState v-if="error" :message="error" @retry="load" />
      <LoadingState v-else-if="loading" title="正在加载月历…" :rows="4" />
      <template v-else>
        <div class="calendar-grid">
          <div v-for="label in weekdayHeaders" :key="label" class="calendar-weekday">{{ label }}</div>
          <button
            v-for="cell in cells"
            :key="cell.key"
            class="calendar-cell"
            :class="{
              'calendar-cell--muted': !cell.inMonth,
              'calendar-cell--today': cell.isToday,
            }"
            type="button"
            :aria-label="`${cell.key} 查看当天详情`"
            @click="openDay(cell)"
          >
            <span class="calendar-cell__day">{{ cell.day }}</span>
            <span v-if="cell.schedules.length" class="calendar-count">课 {{ cell.schedules.length }}</span>
            <span
              v-for="schedule in cell.schedules.slice(0, 2)"
              :key="'s' + schedule.id"
              class="calendar-chip calendar-chip--course"
            >
              {{ schedule.courseName }}
            </span>
            <span v-if="cell.tasks.length" class="calendar-count">DDL {{ cell.tasks.length }}</span>
            <span
              v-for="task in cell.tasks.slice(0, 2)"
              :key="'t' + task.id"
              class="calendar-chip"
              :class="taskTone(task)"
            >
              {{ formatTimeOfDay(task.deadline) }} {{ task.title }}
            </span>
            <span v-if="cell.tasks.length + cell.schedules.length > 4" class="calendar-chip">查看全部…</span>
          </button>
        </div>
      </template>
    </section>
  </div>
</template>
