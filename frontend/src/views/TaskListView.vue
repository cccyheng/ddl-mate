<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { courseApi, taskApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import EmptyState from '@/components/EmptyState.vue'
import LoadingState from '@/components/LoadingState.vue'
import TaskBatchPanel from '@/components/TaskBatchPanel.vue'
import TaskItem from '@/components/TaskItem.vue'
import { fromDatetimeLocal } from '@/utils/datetime'

const batchMode = ref(false)
const loading = ref(true)
const error = ref('')
const tasks = ref([])
const courses = ref([])
const pageInfo = reactive({ page: 0, size: 20, totalElements: 0, totalPages: 0 })
/** 「更多筛选」默认收起，但打开状态不保存到 URL，刷新即回到简洁视图。 */
const advancedOpen = ref(false)

const filters = reactive({
  courseId: '',
  status: '',
  type: '',
  priority: '',
  keyword: '',
  dueFrom: '',
  dueTo: '',
  includeDone: false,
  sort: 'deadline',
  direction: 'asc',
})

const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'TODO', label: '未开始' },
  { value: 'DOING', label: '进行中' },
  { value: 'DONE', label: '已完成' },
  { value: 'ARCHIVED', label: '已归档' },
]

const typeOptions = [
  { value: '', label: '全部类型' },
  { value: 'HOMEWORK', label: '作业' },
  { value: 'LAB', label: '实验' },
  { value: 'REPORT', label: '报告' },
  { value: 'PROJECT', label: '课程设计' },
  { value: 'EXAM', label: '考试' },
  { value: 'PRESENTATION', label: '展示/答辩' },
  { value: 'READING', label: '阅读' },
  { value: 'OTHER', label: '其他' },
]

const sortOptions = [
  { value: 'deadline', label: '按 DDL' },
  { value: 'priority', label: '按优先级' },
  { value: 'createdAt', label: '按创建时间' },
  { value: 'title', label: '按标题' },
]

const hasFilter = computed(() =>
  Boolean(
    filters.courseId ||
      filters.status ||
      filters.type ||
      filters.priority ||
      filters.keyword ||
      filters.dueFrom ||
      filters.dueTo ||
      filters.includeDone,
  ),
)

/** 已启用的筛选条数：用于给「更多筛选」加角标提示，不隐藏任何筛选项。 */
const advancedCount = computed(
  () =>
    [filters.type, filters.priority, filters.dueFrom, filters.dueTo, filters.includeDone ? '1' : ''].filter(
      Boolean,
    ).length,
)

function queryParams(page = 0) {
  return {
    courseId: filters.courseId || undefined,
    status: filters.status || undefined,
    type: filters.type || undefined,
    priority: filters.priority || undefined,
    keyword: filters.keyword || undefined,
    dueFrom: fromDatetimeLocal(filters.dueFrom) || undefined,
    dueTo: fromDatetimeLocal(filters.dueTo) || undefined,
    includeDone: filters.includeDone ? true : undefined,
    sort: filters.sort,
    direction: filters.direction,
    page,
    size: pageInfo.size,
  }
}

async function load(page = 0) {
  loading.value = true
  error.value = ''
  try {
    const result = await taskApi.list(queryParams(page))
    tasks.value = result.content
    pageInfo.page = result.page
    pageInfo.size = result.size
    pageInfo.totalElements = result.totalElements
    pageInfo.totalPages = result.totalPages
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

function resetFilters() {
  filters.courseId = ''
  filters.status = ''
  filters.type = ''
  filters.priority = ''
  filters.keyword = ''
  filters.dueFrom = ''
  filters.dueTo = ''
  filters.includeDone = false
  filters.sort = 'deadline'
  filters.direction = 'asc'
  load(0)
}

async function toggleStatus(task) {
  const closed = task.status === 'DONE' || task.status === 'ARCHIVED'
  try {
    await taskApi.changeStatus(task.id, closed ? 'TODO' : 'DONE')
    await load(pageInfo.page)
  } catch (err) {
    error.value = err.message
  }
}

let searchTimer = null
watch(
  () => filters.keyword,
  () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => load(0), 350)
  },
)

onMounted(async () => {
  try {
    courses.value = await courseApi.list()
  } catch (err) {
    error.value = err.message
  }
  await load(0)
})
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>DDL 列表</h1>
        <p class="page-head__sub">
          共 {{ pageInfo.totalElements }} 个任务 · 默认按 DDL 升序，逾期的排在最前面
        </p>
      </div>
      <div class="row">
        <RouterLink class="btn" to="/tasks/import-notices">
          <AppIcon name="spark" :size="17" />
          从通知导入
        </RouterLink>
        <RouterLink class="btn btn--primary" to="/tasks/new">
          <AppIcon name="plus" :size="17" />
          新建任务
        </RouterLink>
      </div>
    </div>

    <div class="alert" style="margin-bottom: 16px">
      有群通知截图或老师原话？走
      <RouterLink to="/tasks/import-notices">从通知创建任务</RouterLink>：
      文字和截图都在这台电脑上本地识别成可编辑候选，勾选确认后才写库（图片不上传外网，也不会自动创建任务）。
    </div>

    <section class="card card--flat" style="margin-bottom: 16px">
      <div class="filter-bar">
        <label class="field filter-bar__keyword">
          <span class="field__label">关键词</span>
          <input v-model="filters.keyword" type="search" placeholder="标题 / 说明 / 提交要求" />
        </label>
        <label class="field">
          <span class="field__label">课程</span>
          <select v-model="filters.courseId" @change="load(0)">
            <option value="">全部课程</option>
            <option v-for="course in courses" :key="course.id" :value="course.id">
              {{ course.code }} {{ course.name }}
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">状态</span>
          <select v-model="filters.status" @change="load(0)">
            <option v-for="option in statusOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">排序</span>
          <select v-model="filters.sort" @change="load(0)">
            <option v-for="option in sortOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <div class="filter-bar__actions">
          <button class="btn" type="button" :disabled="!hasFilter" @click="resetFilters">清空筛选</button>
        </div>
      </div>

      <details class="filters-more" @toggle="advancedOpen = $event.target.open">
        <summary>
          更多筛选
          <span v-if="advancedCount" class="badge badge--primary" style="margin-left: 6px">
            已启用 {{ advancedCount }} 项
          </span>
        </summary>
        <div class="filters">
          <label class="field">
            <span class="field__label">类型</span>
            <select v-model="filters.type" @change="load(0)">
              <option v-for="option in typeOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">优先级</span>
            <select v-model="filters.priority" @change="load(0)">
              <option value="">全部优先级</option>
              <option v-for="value in [1, 2, 3, 4, 5]" :key="value" :value="value">
                {{ value }} · {{ ['最低', '较低', '普通', '较高', '紧急'][value - 1] }}
              </option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">截止范围（起）</span>
            <input v-model="filters.dueFrom" type="datetime-local" @change="load(0)" />
          </label>
          <label class="field">
            <span class="field__label">截止范围（止）</span>
            <input v-model="filters.dueTo" type="datetime-local" @change="load(0)" />
          </label>
          <label class="field">
            <span class="field__label">方向</span>
            <select v-model="filters.direction" @change="load(0)">
              <option value="asc">升序</option>
              <option value="desc">降序</option>
            </select>
          </label>
          <div class="field">
            <span class="field__label">显示</span>
            <label class="checkbox-row">
              <input v-model="filters.includeDone" type="checkbox" @change="load(0)" />
              包含已完成/归档
            </label>
          </div>
        </div>
      </details>
    </section>

    <TaskBatchPanel
      v-if="batchMode && !error"
      :tasks="tasks"
      @close="batchMode = false"
      @changed="load(pageInfo.page)"
    />

    <ErrorState v-if="error" :message="error" @retry="load(pageInfo.page)" />
    <LoadingState v-else-if="loading" title="正在加载任务…" />
    <section v-else class="card">
      <div class="card__head">
        <div>
          <div class="card__title">
            <AppIcon name="list" :size="18" />
            任务
            <button v-if="!batchMode" type="button" class="btn btn--sm btn--ghost" @click="batchMode = true">批量操作</button>
          </div>
          <p class="card__hint">
            <template v-if="pageInfo.totalElements">
              第 {{ pageInfo.page + 1 }} / {{ Math.max(1, pageInfo.totalPages) }} 页，共
              {{ pageInfo.totalElements }} 条
            </template>
            <template v-else>没有符合当前筛选的任务</template>
          </p>
        </div>
        <span v-if="hasFilter" class="filter-summary">筛选已生效</span>
      </div>

      <ul v-if="tasks.length" class="task-list">
        <TaskItem v-for="task in tasks" :key="task.id" :task="task" @toggle-status="toggleStatus" />
      </ul>
      <EmptyState
        v-else
        icon="search"
        title="没有符合条件的任务"
        description="试着放宽筛选条件，或者新建一个任务。"
      >
        <RouterLink class="btn btn--sm" to="/tasks/new">新建任务</RouterLink>
      </EmptyState>

      <div v-if="pageInfo.totalPages > 1" class="pagination">
        <span>第 {{ pageInfo.page + 1 }} / {{ pageInfo.totalPages }} 页 · 共 {{ pageInfo.totalElements }} 条</span>
        <div class="row">
          <button
            class="btn btn--sm"
            type="button"
            :disabled="pageInfo.page <= 0"
            @click="load(pageInfo.page - 1)"
          >
            上一页
          </button>
          <button
            class="btn btn--sm"
            type="button"
            :disabled="pageInfo.page >= pageInfo.totalPages - 1"
            @click="load(pageInfo.page + 1)"
          >
            下一页
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
