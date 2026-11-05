<script setup>
/**
 * 「课程与课表」首页：默认周视图（像手机课表一样按时间排开），可切换月视图；
 * 课程资料的增删改放在「编辑课程」里（/courses/manage）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { calendarApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import LoadingState from '@/components/LoadingState.vue'
import CalendarView from '@/views/CalendarView.vue'
import { calibrationFromRows, loadCalibrationRows } from '@/domain/teachingWeekStore'
import { currentTeachingWeekOn } from '@domain/teachingWeek'
import { formatClock, toDateKey } from '@/utils/datetime'
import { addDays, layoutDay, mondayOf, monthsOfWeek, parseDateKey, timeAxis, weekDays } from '@/utils/weekTimetable'

const route = useRoute()
const router = useRouter()

const view = computed(() => (route.query.view === 'month' ? 'month' : 'week'))
const todayKey = toDateKey(new Date())

const monday = computed(() => {
  const picked = parseDateKey(route.query.week)
  return mondayOf(picked || new Date())
})
const days = computed(() => weekDays(monday.value))
const isThisWeek = computed(() => toDateKey(mondayOf(new Date())) === toDateKey(monday.value))

const loading = ref(true)
const error = ref('')
const byDate = ref(new Map()) // key -> { schedules, tasks }
const calibration = ref(null)
let requestId = 0

const teachingWeek = computed(() => {
  const week = currentTeachingWeekOn(calibration.value, days.value[0].key)
  return week !== null && week >= 1 && week <= 53 ? week : null
})

const rangeTitle = computed(() => {
  const first = days.value[0]
  const last = days.value[6]
  const head = `${first.date.getFullYear()} 年 ${first.month} 月 ${first.dayOfMonth} 日`
  const tail = first.month === last.month ? `${last.dayOfMonth} 日` : `${last.month} 月 ${last.dayOfMonth} 日`
  return `${head} – ${tail}`
})

const allSchedules = computed(() => days.value.flatMap((day) => byDate.value.get(day.key)?.schedules || []))
const axis = computed(() => timeAxis(allSchedules.value))
const weekStats = computed(() => ({
  classes: allSchedules.value.length,
  tasks: days.value.reduce((sum, day) => sum + (byDate.value.get(day.key)?.tasks.length || 0), 0),
}))

const columns = computed(() =>
  days.value.map((day) => {
    const entry = byDate.value.get(day.key) || { schedules: [], tasks: [] }
    return { ...day, isToday: day.key === todayKey, tasks: entry.tasks, blocks: layoutDay(entry.schedules, axis.value) }
  }),
)

/** 每小时的高度（px）；整个时间轴高度随之确定。 */
const HOUR_PX = 64
const gridHeight = computed(() => ((axis.value.end - axis.value.start) / 60) * HOUR_PX)

async function load() {
  if (view.value !== 'week') return
  const current = ++requestId
  loading.value = true
  error.value = ''
  try {
    const months = await Promise.all(monthsOfWeek(monday.value).map((m) => calendarApi.month(m.year, m.month)))
    if (current !== requestId) return
    const map = new Map()
    for (const response of months) {
      for (const day of response.days) map.set(day.date, { schedules: day.schedules || [], tasks: day.tasks || [] })
    }
    byDate.value = map
  } catch (err) {
    if (current === requestId) error.value = err.message
  } finally {
    if (current === requestId) loading.value = false
  }
}

async function loadCalibration() {
  try {
    calibration.value = calibrationFromRows(await loadCalibrationRows())
  } catch {
    calibration.value = null
  }
}

function setView(next) {
  const query = { ...route.query }
  if (next === 'month') query.view = 'month'
  else delete query.view
  router.replace({ name: 'courses', query })
}

function shiftWeek(delta) {
  const target = addDays(monday.value, delta * 7)
  const query = { ...route.query }
  if (toDateKey(mondayOf(new Date())) === toDateKey(target)) delete query.week
  else query.week = toDateKey(target)
  router.replace({ name: 'courses', query })
}

function thisWeek() {
  const query = { ...route.query }
  delete query.week
  router.replace({ name: 'courses', query })
}

function blockStyle(block) {
  const width = 100 / block.lanes
  const color = /^#[0-9a-f]{6}$/i.test(block.courseColor || '') ? block.courseColor : null
  return {
    top: `${block.top * 100}%`,
    height: `${block.height * 100}%`,
    left: `calc(${block.lane * width}% + 2px)`,
    width: `calc(${width}% - 4px)`,
    ...(color ? { '--block-color': color } : {}),
  }
}

function hourLabel(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:00`
}

watch(() => [view.value, toDateKey(monday.value)], load)
onMounted(() => {
  load()
  loadCalibration()
})
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>课程与课表</h1>
        <p class="page-head__sub">按周看每天上什么课，也可以切到月视图；课程资料在「编辑课程」里修改。</p>
      </div>
      <div class="row">
        <div class="segmented" role="tablist" aria-label="视图">
          <button
            type="button"
            role="tab"
            class="segmented__item"
            :class="{ 'segmented__item--active': view === 'week' }"
            :aria-selected="view === 'week'"
            @click="setView('week')"
          >
            周视图
          </button>
          <button
            type="button"
            role="tab"
            class="segmented__item"
            :class="{ 'segmented__item--active': view === 'month' }"
            :aria-selected="view === 'month'"
            @click="setView('month')"
          >
            月视图
          </button>
        </div>
        <RouterLink class="btn" to="/courses/import-schedule">
          <AppIcon name="camera" :size="17" />
          照片导入
        </RouterLink>
        <RouterLink class="btn btn--primary" to="/courses/manage">
          <AppIcon name="edit" :size="17" />
          编辑课程
        </RouterLink>
      </div>
    </div>

    <CalendarView v-if="view === 'month'" embedded />

    <section v-else class="card week-card">
      <div class="calendar-head">
        <div class="row">
          <button class="btn btn--sm" type="button" aria-label="上一周" title="上一周" @click="shiftWeek(-1)">
            <AppIcon name="chevronRight" :size="16" style="transform: rotate(180deg)" />
          </button>
          <span class="calendar-title">{{ rangeTitle }}</span>
          <button class="btn btn--sm" type="button" aria-label="下一周" title="下一周" @click="shiftWeek(1)">
            <AppIcon name="chevronRight" :size="16" />
          </button>
          <button v-if="!isThisWeek" class="btn btn--sm" type="button" @click="thisWeek">回到本周</button>
        </div>
        <span class="small muted">
          <template v-if="teachingWeek">第 {{ teachingWeek }} 周 · </template>
          <RouterLink v-else to="/tools/teaching-week">设置教学周</RouterLink>
          <template v-if="!teachingWeek"> · </template>
          课程 {{ weekStats.classes }} 节 · DDL {{ weekStats.tasks }} 个
        </span>
      </div>

      <ErrorState v-if="error" :message="error" @retry="load" />
      <LoadingState v-else-if="loading" title="正在加载本周课表…" :rows="4" />
      <template v-else>
        <div class="week-scroll">
          <div class="week-grid">
            <div class="week-corner" />
            <RouterLink
              v-for="col in columns"
              :key="'h' + col.key"
              class="week-dayhead"
              :class="{ 'week-dayhead--today': col.isToday }"
              :to="{ name: 'calendar-day', params: { date: col.key } }"
              :title="`${col.key} 查看当天详情`"
            >
              <span class="week-dayhead__label">{{ col.label }}</span>
              <span class="week-dayhead__date">{{ col.month }}/{{ col.dayOfMonth }}</span>
              <span v-if="col.tasks.length" class="week-dayhead__ddl">DDL {{ col.tasks.length }}</span>
            </RouterLink>

            <div class="week-axis" :style="{ height: `${gridHeight}px` }">
              <span
                v-for="(minute, index) in axis.hours"
                :key="minute"
                class="week-axis__hour"
                :style="{ top: `${index * HOUR_PX}px` }"
              >
                {{ hourLabel(minute) }}
              </span>
            </div>
            <div
              v-for="col in columns"
              :key="'c' + col.key"
              class="week-col"
              :class="{ 'week-col--today': col.isToday }"
              :style="{ height: `${gridHeight}px`, '--hour': `${HOUR_PX}px` }"
            >
              <RouterLink
                v-for="block in col.blocks"
                :key="block.id"
                class="week-block"
                :style="blockStyle(block)"
                :to="`/courses/${block.courseId}`"
                :title="`${block.courseName} ${formatClock(block.startTime)}-${formatClock(block.endTime)} ${block.location || ''} ${block.teacher || ''}`"
              >
                <strong class="week-block__name">{{ block.courseName }}</strong>
                <span class="week-block__meta week-block__time">{{ formatClock(block.startTime) }}–{{ formatClock(block.endTime) }}</span>
                <span v-if="block.location" class="week-block__meta">@{{ block.location }}</span>
                <span v-if="block.teacher" class="week-block__meta week-block__time">{{ block.teacher }}</span>
              </RouterLink>
            </div>
          </div>
        </div>
        <p v-if="!weekStats.classes" class="small muted" style="margin: 12px 0 0">
          这一周没有课。可以
          <RouterLink to="/courses/import-schedule">照片导入课表</RouterLink>，或在
          <RouterLink to="/courses/manage">编辑课程</RouterLink> 里手动添加。
        </p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.segmented {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-2, var(--surface));
}
.segmented__item {
  border: 0;
  background: transparent;
  color: var(--text-muted, inherit);
  padding: 6px 14px;
  border-radius: 999px;
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
.segmented__item--active {
  background: var(--primary);
  color: var(--on-primary);
  font-weight: 600;
}

.week-scroll {
  overflow-x: auto;
  margin-top: 12px;
}
.week-grid {
  display: grid;
  grid-template-columns: 46px repeat(7, minmax(84px, 1fr));
  min-width: 640px;
}
.week-corner {
  border-bottom: 1px solid var(--border);
}
.week-dayhead {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 6px 2px 8px;
  border-bottom: 1px solid var(--border);
  color: inherit;
  text-decoration: none;
  border-radius: 10px 10px 0 0;
}
.week-dayhead:hover {
  background: var(--surface-2, rgba(127, 127, 127, 0.08));
}
.week-dayhead__label {
  font-weight: 600;
  font-size: 14px;
}
.week-dayhead__date {
  font-size: 12px;
  color: var(--text-muted, inherit);
}
.week-dayhead__ddl {
  margin-top: 2px;
  white-space: nowrap;
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
}
.week-dayhead--today .week-dayhead__label,
.week-dayhead--today .week-dayhead__date {
  color: var(--primary);
}

.week-axis {
  position: relative;
}
.week-axis__hour {
  position: absolute;
  right: 6px;
  transform: translateY(-50%);
  font-size: 11px;
  color: var(--text-muted, inherit);
}
.week-axis__hour:first-child {
  transform: none;
}
.week-col {
  position: relative;
  border-left: 1px solid var(--border);
  background-image: repeating-linear-gradient(
    to bottom,
    var(--border) 0,
    var(--border) 1px,
    transparent 1px,
    transparent var(--hour)
  );
}
.week-col--today {
  background-color: color-mix(in srgb, var(--primary) 6%, transparent);
}
.week-block {
  --block-color: var(--primary);
  position: absolute;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 6px;
  border-radius: 8px;
  border-left: 3px solid var(--block-color);
  background: color-mix(in srgb, var(--block-color) 18%, var(--surface));
  color: inherit;
  text-decoration: none;
  font-size: 12px;
  line-height: 1.3;
}
.week-block:hover {
  background: color-mix(in srgb, var(--block-color) 28%, var(--surface));
}
.week-block__name {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.week-block__meta {
  color: var(--text-muted, inherit);
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .week-grid {
    grid-template-columns: 34px repeat(7, minmax(0, 1fr));
    min-width: 0;
  }
  .week-block {
    padding: 3px 3px;
    font-size: 10px;
  }
  .week-block__name {
    font-size: 11px;
  }
  .week-dayhead__label {
    font-size: 12px;
  }
  .week-block__time {
    display: none;
  }
  .week-dayhead__ddl {
    font-size: 10px;
    padding: 0 3px;
  }
}
</style>
