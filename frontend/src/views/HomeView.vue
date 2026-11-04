<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { scheduleApi, taskApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import CountdownBadge from '@/components/CountdownBadge.vue'
import ErrorState from '@/components/ErrorState.vue'
import EmptyState from '@/components/EmptyState.vue'
import HomeStudyStrip from '@/components/HomeStudyStrip.vue'
import LoadingState from '@/components/LoadingState.vue'
import TaskItem from '@/components/TaskItem.vue'
import { formatClock, formatDateTime, greeting, todayLabel } from '@/utils/datetime'

const loading = ref(true)
const error = ref('')
const tasks = ref([])
const upcoming = ref([])
const todaySchedule = ref([])
const stats = ref(null)
// 全部"未完成且有 DDL"的任务（按 DDL 升序），用于"最近的一个 DDL"，
// 不限于今天/7 天内，避免有未来 DDL 却显示"没有 DDL"。
const openDeadlines = ref([])

const greetingText = greeting()
const dateText = todayLabel()

/**
 * 最近的一个 DDL：从完整的未完成 DDL 列表里取。
 * 优先取"还没到期"的最早一个（deadlineList 已按 DDL 升序）；
 * 如果全部都已逾期，则显示逾期最久的那个。
 */
const focusTask = computed(() => {
  const list = openDeadlines.value.filter((task) => task.deadline)
  if (!list.length) return null
  const now = Date.now()
  const upcomingTask = list.find((task) => new Date(task.deadline).getTime() >= now)
  return upcomingTask || list[0]
})

/**
 * 把"今天与逾期"列表拆成两个清晰区域（数据与排序都由后端给，前端不改顺序）：
 *   - 今天截止：今天到期、且还没完成的；
 *   - 已逾期：deadline 已经过了、还没完成的（按 DDL 升序，逾期最久的在最前）。
 */
const doneTask = (task) => task.status === 'DONE' || task.status === 'ARCHIVED'
const dueTodayTasks = computed(() =>
  tasks.value.filter((task) => !doneTask(task) && task.deadline && new Date(task.deadline).getTime() >= Date.now()),
)
const overdueTasks = computed(() =>
  tasks.value.filter((task) => !doneTask(task) && task.deadline && new Date(task.deadline).getTime() < Date.now()),
)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [todayTasks, deadlineList, todaySchedules, statistics] = await Promise.all([
      taskApi.today(),
      taskApi.deadlines({ sort: 'deadline' }),
      scheduleApi.today(),
      taskApi.stats(),
    ])
    tasks.value = todayTasks
    // 注意：这里必须写 ref.value，不能与解构出来的局部变量重名，
    // 否则会变成给普通数组加属性，页面永远显示空态。
    todaySchedule.value = todaySchedules
    stats.value = statistics
    openDeadlines.value = deadlineList

    const now = Date.now()
    // 「7 天内」按 7×24 小时算，保证今天稍晚截止的任务也算在内（统计口径不写入后端）。
    const sevenDays = now + 7 * 24 * 3600 * 1000
    upcoming.value = deadlineList
      .filter((task) => task.status !== 'DONE' && task.status !== 'ARCHIVED')
      .filter((task) => {
        const time = new Date(task.deadline).getTime()
        return time >= now && time <= sevenDays
      })
      .slice(0, 6)
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
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

onMounted(load)
</script>

<template>
  <div>
    <div class="home-hero">
      <div>
        <h1 class="home-hero__greeting">{{ greetingText }}</h1>
        <p class="home-hero__date">
          <AppIcon name="calendar" :size="16" />
          {{ dateText }} · 这里是今天的 DDL 与课程
        </p>
      </div>
      <div class="row">
        <RouterLink class="btn btn--primary" to="/tasks/new">
          <AppIcon name="plus" :size="17" />
          新建任务
        </RouterLink>
        <RouterLink class="btn" to="/calendar">看日历</RouterLink>
      </div>
    </div>

    <ErrorState v-if="error" :message="error" @retry="load" />
    <LoadingState v-else-if="loading" title="正在加载今日概览…" :rows="3" />

    <template v-else>
      <div class="stat-grid" style="margin-bottom: 20px">
        <div class="stat" :class="stats && stats.overdue ? 'stat--danger' : ''">
          <span class="stat__value">{{ stats ? stats.overdue : 0 }}</span>
          <span class="stat__label">已逾期未完成</span>
          <span class="stat__hint">需要尽快处理</span>
        </div>
        <div class="stat" :class="stats && stats.dueToday ? 'stat--warn' : ''">
          <span class="stat__value">{{ stats ? stats.dueToday : 0 }}</span>
          <span class="stat__label">今天截止</span>
          <span class="stat__hint">按 DDL 排序</span>
        </div>
        <div class="stat">
          <span class="stat__value">{{ stats ? stats.dueIn7Days : 0 }}</span>
          <span class="stat__label">7 天内截止</span>
          <span class="stat__hint">含今天</span>
        </div>
        <div class="stat stat--success">
          <span class="stat__value">{{ stats ? stats.completed : 0 }}</span>
          <span class="stat__label">已完成</span>
          <span class="stat__hint">全部历史</span>
        </div>
      </div>

      <HomeStudyStrip />

      <RouterLink class="notice-cta" to="/tasks/import-notices">
        <span class="notice-cta__icon" aria-hidden="true"><AppIcon name="spark" :size="20" /></span>
        <span class="notice-cta__text">
          <span class="notice-cta__title">整理群里的通知</span>
          <span class="notice-cta__hint">
            选择截图或粘贴文字，核对后保存为任务。识别在本机完成。
          </span>
        </span>
        <span class="notice-cta__action">
          从通知整理
          <AppIcon name="chevronRight" :size="16" />
        </span>
      </RouterLink>

      <div class="home-focus" style="margin-top: 20px">
        <div class="home-focus__main">
          <section class="card">
            <div class="card__head">
              <div>
                <div class="card__title">
                  <AppIcon name="alert" :size="18" />
                  今天与逾期
                </div>
                <p class="card__hint">
                  待处理 {{ tasks.length }} 个 · 其中已逾期 {{ overdueTasks.length }} 个
                </p>
              </div>
              <RouterLink class="btn btn--sm" to="/tasks">全部任务</RouterLink>
            </div>

            <template v-if="tasks.length">
              <div v-if="dueTodayTasks.length" class="task-group">
                <h2 class="task-group__title">
                  今天截止
                  <span class="task-group__count">{{ dueTodayTasks.length }}</span>
                </h2>
                <ul class="task-list">
                  <TaskItem v-for="task in dueTodayTasks" :key="task.id" :task="task" @toggle-status="toggleStatus" />
                </ul>
              </div>

              <div v-if="overdueTasks.length" class="task-group">
                <h2 class="task-group__title">
                  已逾期
                  <span class="task-group__count">{{ overdueTasks.length }}</span>
                </h2>
                <ul class="task-list">
                  <TaskItem v-for="task in overdueTasks" :key="task.id" :task="task" @toggle-status="toggleStatus" />
                </ul>
              </div>
            </template>

            <EmptyState
              v-else
              icon="check"
              title="今天没有到期的任务"
              description="可以去日历看看接下来几天，或者提前做一点后面的任务。"
            >
              <RouterLink class="btn btn--sm" to="/tasks/new">添加任务</RouterLink>
            </EmptyState>
          </section>

          <section class="card">
            <div class="card__head">
              <div>
                <div class="card__title">
                  <AppIcon name="clock" :size="18" />
                  即将截止（7 天内）
                </div>
                <p class="card__hint">按 DDL 从近到远排序，最多显示 6 条</p>
              </div>
            </div>
            <ul v-if="upcoming.length" class="task-list">
              <TaskItem v-for="task in upcoming" :key="task.id" :task="task" @toggle-status="toggleStatus" />
            </ul>
            <EmptyState
              v-else
              icon="calendar"
              title="7 天内没有新 DDL"
              description="目前比较轻松，可以安排复习。"
            />
          </section>
        </div>

        <div class="home-focus__side">
          <section class="card">
            <div class="card__head">
              <div>
                <div class="card__title">
                  <AppIcon name="clock" :size="18" />
                  今日课程
                </div>
                <p class="card__hint">今天的上课时间与地点</p>
              </div>
              <RouterLink class="btn btn--sm" to="/courses">管理课表</RouterLink>
            </div>
            <ul v-if="todaySchedule.length" class="task-list">
              <li v-for="item in todaySchedule" :key="item.id" class="task-item">
                <div class="task-item__main">
                  <div class="task-item__title">
                    <span class="dot" :style="{ background: item.courseColor || '#65746b' }" />
                    {{ item.courseName }}
                  </div>
                  <div class="task-item__meta">
                    <span class="task-item__due">
                      {{ formatClock(item.startTime) }} – {{ formatClock(item.endTime) }}
                    </span>
                    <span v-if="item.location">{{ item.location }}</span>
                  </div>
                </div>
              </li>
            </ul>
            <EmptyState v-else icon="calendar" title="今天没有课" description="课表里今天没有安排。" />
          </section>

          <section class="card">
            <div class="card__head">
              <div>
                <div class="card__title">
                  <AppIcon name="list" :size="18" />
                  最近的一个 DDL
                </div>
                <p class="card__hint">来自全部未完成 DDL，不限于今天</p>
              </div>
            </div>
            <div v-if="focusTask">
              <RouterLink class="focus-ddl__title" :to="`/tasks/${focusTask.id}`">{{ focusTask.title }}</RouterLink>
              <div class="task-item__meta" style="margin-top: 6px">
                <span v-if="focusTask.course" class="badge badge--muted">{{ focusTask.course.name }}</span>
                <span class="badge badge--muted">{{ focusTask.typeLabel }}</span>
                <span v-if="focusTask.estimatedMinutes" class="badge badge--muted">
                  预计 {{ focusTask.estimatedMinutes }} 分钟
                </span>
              </div>
              <p class="small" style="margin: 8px 0 0">
                <CountdownBadge :deadline="focusTask.deadline" :status="focusTask.status" />
                <span class="muted">截止 {{ formatDateTime(focusTask.deadline) }}</span>
              </p>
            </div>
            <p v-else class="muted small">还没有设置 DDL 的任务。</p>
          </section>

          <section class="card card--note">
            <div class="card__title" style="margin-bottom: 6px">
              <AppIcon name="compass" :size="17" />
              现在能做什么
            </div>
            <p class="small muted" style="margin: 0">
              任务与 DDL 排序、课程课表、日历、原通知留存都已可用；课表照片和通知截图都能在本机识别后导入。
              「下节课前」这类相对时间与更强的 AI 拆分仍在计划中，详见
              <RouterLink to="/about">路线图</RouterLink>。
            </p>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>
