<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { buildSearchIndex, searchCategoryLabels, searchLocal } from '@domain/globalSearch'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import LoadingState from '@/components/LoadingState.vue'
import { sourceApi } from '@/api'
import { loadAllCourses, loadAllTasks, toDomainCourse, toDomainTask } from '@/domain/adapters'

const route = useRoute()
const router = useRouter()

const index = ref(null)
const error = ref('')
const filter = ref('ALL')
const page = ref(0)
const query = computed(() => (typeof route.query.q === 'string' ? route.query.q : ''))
const draft = ref(query.value)

const result = computed(() => (index.value ? searchLocal(index.value, query.value, filter.value, page.value) : null))
const FILTERS = ['ALL', 'TASK', 'EXAM', 'COURSE', 'NOTE']
const ICONS = { TASK: 'list', EXAM: 'exam', COURSE: 'book', NOTE: 'inbox' }

const linkOf = (item) => (item.owner.kind === 'task' ? `/tasks/${item.owner.id}` : `/courses/${item.owner.id}`)

function submit() {
  router.replace({ name: 'search', query: draft.value.trim() ? { q: draft.value.trim() } : {} })
}

watch(query, (q) => {
  draft.value = q
  page.value = 0
})
watch(filter, () => {
  page.value = 0
})

async function load() {
  error.value = ''
  try {
    const [tasks, courses, sources] = await Promise.all([loadAllTasks(), loadAllCourses(), sourceApi.list()])
    const originalTexts = new Map()
    for (const source of sources) {
      if (!source.taskId || !source.rawText) continue
      const prev = originalTexts.get(source.taskId)
      originalTexts.set(source.taskId, prev ? `${prev}\n${source.rawText}` : source.rawText)
    }
    index.value = buildSearchIndex({
      tasks: tasks.map(toDomainTask),
      courses: courses.map(toDomainCourse),
      originalTexts,
    })
  } catch (err) {
    error.value = err.message
  }
}

onMounted(load)
</script>

<template>
  <div>
    <header class="page-head">
      <div>
        <span class="page-head__eyebrow"><AppIcon name="search" :size="15" />搜索</span>
        <h1>全局搜索</h1>
        <p class="page-head__sub">在任务、考试、课程、任务说明与通知原文里查找；多个关键词用空格分开，需全部命中。</p>
      </div>
    </header>

    <form class="search-hero" role="search" @submit.prevent="submit">
      <AppIcon name="search" :size="20" />
      <input v-model="draft" type="search" placeholder="例如：实验报告 学习通" aria-label="搜索关键词" maxlength="100" autofocus />
      <button type="submit" class="btn btn--primary">搜索</button>
    </form>

    <ErrorState v-if="error" :message="error" @retry="load" />
    <LoadingState v-else-if="!index" title="正在建立索引…" />
    <template v-else-if="result">
      <div v-if="result.hasQuery" class="row" style="margin: 4px 0 14px">
        <button
          v-for="key in FILTERS"
          :key="key"
          type="button"
          class="chip"
          :class="{ 'chip--active': filter === key }"
          @click="filter = key"
        >
          {{ searchCategoryLabels[key] }} {{ result.counts[key] }}
        </button>
      </div>

      <section v-if="!result.hasQuery" class="card card--soft">
        <p class="muted" style="margin: 0">输入关键词开始搜索。也可以直接用顶栏的搜索框。</p>
      </section>
      <section v-else-if="result.items.length === 0" class="card card--soft">
        <p class="muted" style="margin: 0">没有找到「{{ query }}」。试试更短的关键词。</p>
      </section>
      <div v-else class="list-rows">
        <RouterLink v-for="item in result.items" :key="item.key" class="list-row search-row" :to="linkOf(item)">
          <span class="search-row__icon"><AppIcon :name="ICONS[item.category]" :size="17" /></span>
          <span class="list-row__main">
            <span class="list-row__title">{{ item.title }}</span>
            <span class="list-row__meta">{{ searchCategoryLabels[item.category] }} · {{ item.subtitle }}</span>
            <span v-if="item.snippet" class="search-row__snippet">{{ item.snippet }}</span>
          </span>
          <AppIcon name="chevronRight" :size="16" />
        </RouterLink>
      </div>

      <div v-if="result.pages > 1" class="row" style="justify-content: center; margin-top: 14px">
        <button type="button" class="btn btn--sm" :disabled="result.page === 0" @click="page = result.page - 1">上一页</button>
        <span class="muted small">{{ result.page + 1 }} / {{ result.pages }}</span>
        <button type="button" class="btn btn--sm" :disabled="result.page >= result.pages - 1" @click="page = result.page + 1">
          下一页
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.search-hero {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px 8px 16px;
  margin-bottom: 14px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
  box-shadow: var(--shadow);
  color: var(--text-muted);
}

.search-hero:focus-within {
  border-color: var(--primary);
  box-shadow: var(--focus-ring);
}

.search-hero input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 1.02rem;
  padding: 8px 0;
}

.search-hero input:focus {
  outline: none;
  box-shadow: none;
}

.search-row {
  color: inherit;
  align-items: flex-start;
}

.search-row:hover {
  text-decoration: none;
  background: var(--surface-soft);
}

.search-row__icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--primary-soft);
  color: var(--primary);
  flex: none;
}

.search-row__snippet {
  display: block;
  margin-top: 4px;
  color: var(--text-soft);
  font-size: 0.84rem;
  overflow-wrap: anywhere;
}
</style>
