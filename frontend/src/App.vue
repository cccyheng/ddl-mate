<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { profileApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import ReminderToasts from '@/components/ReminderToasts.vue'
import { startReminderScheduler } from '@/composables/reminderScheduler'
import { todayLabel } from '@/utils/datetime'
import { readPreference, writePreference } from '@/utils/preferences'
import { applyTheme, nextTheme, THEME_LABELS } from '@/utils/theme'

const route = useRoute()
const router = useRouter()
const profile = ref(null)
const profileError = ref('')

/**
 * 导航分组。条目只有在路由真实存在时才显示（`router.hasRoute`），
 * 因此不会出现点了没反应的入口。
 */
const NAV_GROUPS = [
  {
    label: '学习',
    items: [
      { name: 'home', to: '/', label: '首页', icon: 'home' },
      { name: 'tasks', to: '/tasks', label: 'DDL 列表', icon: 'list' },
      { name: 'calendar', to: '/calendar', label: '日历', icon: 'calendar' },
      { name: 'courses', to: '/courses', label: '课程与课表', icon: 'book' },
    ],
  },
  {
    label: '专注与规划',
    items: [
      { name: 'focus', to: '/focus', label: '专注', icon: 'timer' },
      { name: 'today-plan', to: '/plan/today', label: '今日计划', icon: 'target' },
      { name: 'pressure', to: '/plan/pressure', label: 'DDL 压力', icon: 'gauge' },
      { name: 'learning-report', to: '/plan/report', label: '学习周报', icon: 'chart' },
    ],
  },
  {
    label: '考试与课程',
    items: [
      { name: 'exams', to: '/exams', label: '考试与复习', icon: 'exam' },
      { name: 'course-conflicts', to: '/tools/conflicts', label: '课表冲突', icon: 'conflict' },
      { name: 'teaching-week', to: '/tools/teaching-week', label: '教学周', icon: 'week' },
    ],
  },
  {
    label: '工具',
    items: [
      { name: 'task-templates', to: '/tools/templates', label: '任务模板', icon: 'layers' },
      { name: 'recurrence', to: '/tools/recurrence', label: '重复任务', icon: 'repeat' },
      { name: 'reminders', to: '/tools/reminders', label: '提醒', icon: 'bell' },
      { name: 'backup', to: '/tools/backup', label: '备份与恢复', icon: 'archive' },
      { name: 'sources', to: '/sources', label: '原通知', icon: 'inbox' },
      { name: 'about', to: '/about', label: '路线图', icon: 'compass' },
    ],
  },
]

const navGroups = computed(() =>
  NAV_GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => router.hasRoute(item.name)) })).filter(
    (group) => group.items.length > 0,
  ),
)

const todayText = todayLabel()

/** 子路由归到所属一级导航（路由 meta.section），没有声明的用自己的名字。 */
const activeName = computed(() => route.meta.section || route.name)
const pageTitle = computed(() => route.meta.title || 'DDL Mate')

const profileLine = computed(() => {
  if (profile.value) return `${profile.value.displayName} · ${profile.value.timeZone}`
  if (profileError.value) return '本地资料暂不可用'
  return '本地资料读取中…'
})

/* ---------- 侧栏折叠（桌面）/ 抽屉（窄屏） ---------- */
const collapsed = ref(readPreference('sidebar.collapsed') === '1')
const drawerOpen = ref(false)

function toggleCollapsed() {
  collapsed.value = !collapsed.value
  writePreference('sidebar.collapsed', collapsed.value ? '1' : '0')
}

watch(
  () => route.fullPath,
  () => {
    drawerOpen.value = false
  },
)

/* ---------- 主题：跟随系统 → 浅色 → 深色 ---------- */
const theme = ref(readPreference('theme') || 'system')
applyTheme(theme.value)

function cycleTheme() {
  theme.value = nextTheme(theme.value)
  applyTheme(theme.value)
  writePreference('theme', theme.value)
}

const themeIcon = computed(() => (theme.value === 'dark' ? 'moon' : theme.value === 'light' ? 'sun' : 'spark'))

/* ---------- 全局搜索 ---------- */
const searchText = ref('')

function submitSearch() {
  const q = searchText.value.trim()
  if (!router.hasRoute('search')) return
  router.push({ name: 'search', query: q ? { q } : {} })
}

watch(
  () => route.query.q,
  (q) => {
    if (route.name === 'search') searchText.value = typeof q === 'string' ? q : ''
  },
  { immediate: true },
)

onMounted(async () => {
  try {
    profile.value = await profileApi.get()
    startReminderScheduler()
  } catch (error) {
    profileError.value = error.message
  }
})
</script>

<template>
  <div
    class="app-shell"
    :class="{ 'app-shell--collapsed': collapsed, 'app-shell--drawer-open': drawerOpen }"
  >
    <a class="skip-link" href="#main">跳到主要内容</a>

    <div class="sidebar-backdrop" aria-hidden="true" @click="drawerOpen = false" />

    <aside id="app-sidebar" class="sidebar" aria-label="主导航">
      <RouterLink class="sidebar__brand" to="/" title="DDL Mate 首页">
        <span class="sidebar__mark" aria-hidden="true"><AppIcon name="check" :size="20" /></span>
        <span class="sidebar__wordmark">
          <span class="sidebar__name">DDL Mate</span>
          <span class="sidebar__tagline">学习工作台</span>
        </span>
      </RouterLink>

      <nav class="sidebar__nav">
        <template v-for="group in navGroups" :key="group.label">
          <span class="sidebar__group-label">{{ group.label }}</span>
          <RouterLink
            v-for="item in group.items"
            :key="item.name"
            class="nav__link"
            :class="{ 'nav__link--active': activeName === item.name }"
            :to="item.to"
            :title="collapsed ? item.label : undefined"
            :aria-current="activeName === item.name ? 'page' : undefined"
          >
            <AppIcon :name="item.icon" :size="18" />
            <span>{{ item.label }}</span>
          </RouterLink>
        </template>
      </nav>

      <div class="sidebar__foot">
        <RouterLink class="sidebar__foot-card" to="/about" :title="collapsed ? profileLine : undefined">
          <span class="sidebar__foot-title">
            <AppIcon name="user" :size="16" />
            <span>本地资料</span>
          </span>
          <span class="sidebar__foot-meta">{{ profileLine }}</span>
        </RouterLink>
      </div>
    </aside>

    <div class="app-body">
      <header class="topbar">
        <div class="topbar__inner">
          <button
            type="button"
            class="icon-btn topbar__menu"
            aria-controls="app-sidebar"
            :aria-expanded="drawerOpen ? 'true' : 'false'"
            aria-label="打开导航"
            @click="drawerOpen = true"
          >
            <AppIcon name="menu" :size="20" />
          </button>
          <button
            type="button"
            class="icon-btn topbar__collapse"
            :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
            :title="collapsed ? '展开侧栏' : '收起侧栏'"
            @click="toggleCollapsed"
          >
            <AppIcon name="sidebar" :size="19" />
          </button>
          <span class="topbar__title">{{ pageTitle }}</span>

          <form v-if="router.hasRoute('search')" class="topbar__search" role="search" @submit.prevent="submitSearch">
            <AppIcon name="search" :size="16" />
            <input
              v-model="searchText"
              type="search"
              placeholder="搜索任务、课程、考试、原通知"
              aria-label="全局搜索"
              maxlength="100"
            />
          </form>
          <span v-else class="topbar__search" aria-hidden="true" />

          <span class="topbar__date">{{ todayText }}</span>
          <button
            type="button"
            class="icon-btn"
            :aria-label="`切换主题（当前：${THEME_LABELS[theme]}）`"
            :title="`主题：${THEME_LABELS[theme]}`"
            @click="cycleTheme"
          >
            <AppIcon :name="themeIcon" :size="19" />
          </button>
        </div>
      </header>

      <main id="main" :key="route.path" class="app-main">
        <div v-if="profileError" class="alert alert--danger" style="margin-bottom: 16px">
          后端连接失败：{{ profileError }}
        </div>
        <RouterView />
      </main>

      <footer class="app-footer">
        <div class="app-footer__inner">
          <span>DDL Mate · 本地单人版，数据只保存在这台电脑</span>
          <span>{{ profileLine }}</span>
        </div>
      </footer>
    </div>

    <ReminderToasts />
  </div>
</template>

<style scoped>
@media (max-width: 959px) {
  .topbar__collapse {
    display: none;
  }
}
</style>
