<script setup>
/* global __BUILD_STAMP__ */
function reloadPage() {
  window.location.reload()
}
const buildStamp = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'dev'
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { authApi, profileApi } from '@/api'
import { authState } from '@/utils/authState'
import AppIcon from '@/components/AppIcon.vue'
import ReminderToasts from '@/components/ReminderToasts.vue'
import { startReminderScheduler } from '@/composables/reminderScheduler'
import { startUpdateCheck, updateAvailable } from '@/composables/updateCheck'
import { feedbackState, refreshFeedbackRole } from '@/composables/feedbackState'
import { currentTeachingWeek } from '@/domain/teachingWeekStore'
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
      { name: 'school-import', to: '/tools/school-import', label: '课程抓取', icon: 'download' },
      { name: 'exam-import', to: '/exams/import', label: '考试抓取', icon: 'download' },
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
      { name: 'about', to: '/about', label: '关于与路线图', icon: 'compass' },
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
  if (profileError.value) return '个人资料暂不可用'
  return '个人资料读取中…'
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

/* ---------- 顶栏教学周 ---------- */
const teachingWeek = ref(null)
async function refreshTeachingWeek() {
  teachingWeek.value = await currentTeachingWeek().catch(() => null)
}

/* ---------- 登录（服务器版） ---------- */
const bare = computed(() => route.meta.bare === true)

function onUnauthenticated() {
  authState.authenticated = false
  if (route.name !== 'login') router.push({ name: 'login', query: { redirect: route.fullPath } })
}

// 登录后（从登录页跳回来时 App 不会重新挂载）也刷新一次站长身份和未读反馈数
watch(
  () => authState.authenticated,
  (ok) => {
    if (ok) refreshFeedbackRole()
  },
)

async function logout() {
  await authApi.logout().catch(() => {})
  window.location.assign('/login')
}

onMounted(async () => {
  startUpdateCheck()
  window.addEventListener('ddlmate:teaching-week-changed', refreshTeachingWeek)
  window.addEventListener('ddlmate:unauthenticated', onUnauthenticated)
  await router.isReady()
  if (authState.enabled && !authState.authenticated) return
  // 用临时密码登录、还没改密码：别的接口都会被拒绝，先不加载
  if (authState.mustChangePassword) return
  try {
    profile.value = await profileApi.get()
    startReminderScheduler()
    refreshTeachingWeek()
    refreshFeedbackRole()
  } catch (error) {
    profileError.value = error.message
  }
})
</script>

<template>
  <RouterView v-if="bare" />
  <div
    v-else
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
        <RouterLink
          class="nav__link sidebar__feedback"
          :class="{ 'nav__link--active': activeName === 'feedback' }"
          :to="{ path: '/feedback', query: route.name === 'feedback' ? route.query : { from: route.fullPath } }"
          :title="collapsed ? '问题反馈' : undefined"
        >
          <AppIcon name="inbox" :size="17" />
          <span>问题反馈</span>
          <span v-if="feedbackState.admin && feedbackState.unread + feedbackState.resetPending" class="sidebar__badge">
            {{ feedbackState.unread + feedbackState.resetPending }}
          </span>
        </RouterLink>
        <RouterLink
          v-if="authState.enabled && feedbackState.admin"
          class="nav__link sidebar__feedback"
          :class="{ 'nav__link--active': activeName === 'admin-users' }"
          to="/admin/users"
          :title="collapsed ? '用户管理' : undefined"
        >
          <AppIcon name="layers" :size="17" />
          <span>用户管理</span>
        </RouterLink>
        <RouterLink
          v-if="authState.enabled"
          class="nav__link sidebar__feedback"
          :class="{ 'nav__link--active': activeName === 'account' }"
          to="/account"
          :title="collapsed ? '账号与安全' : undefined"
        >
          <AppIcon name="user" :size="17" />
          <span>账号与安全</span>
        </RouterLink>
        <RouterLink class="sidebar__foot-card" to="/about" :title="collapsed ? profileLine : undefined">
          <span class="sidebar__foot-title">
            <AppIcon name="user" :size="16" />
            <span>个人资料</span>
          </span>
          <span class="sidebar__foot-meta">{{ profileLine }}</span>
        </RouterLink>
        <button
          v-if="authState.enabled"
          type="button"
          class="nav__link sidebar__logout"
          :title="collapsed ? '退出登录' : undefined"
          @click="logout"
        >
          <AppIcon name="close" :size="17" />
          <span>退出登录</span>
        </button>
        <span v-if="!collapsed" class="sidebar__version" :title="`网页版本：${buildStamp} 构建`">版本 {{ buildStamp }}</span>
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

          <span class="topbar__date">
            {{ todayText }}
            <RouterLink v-if="teachingWeek" class="topbar__week" to="/tools/teaching-week" title="教学周">
              第 {{ teachingWeek }} 周
            </RouterLink>
          </span>
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

      <div v-if="updateAvailable" class="update-bar" role="status">
        <span>网页有新版本了。</span>
        <button type="button" class="btn btn--sm btn--primary" @click="reloadPage">点此刷新</button>
      </div>
      <main id="main" :key="route.path" class="app-main">
        <div v-if="profileError" class="alert alert--danger" style="margin-bottom: 16px">
          后端连接失败：{{ profileError }}
        </div>
        <RouterView />
      </main>

      <footer class="app-footer">
        <div class="app-footer__inner">
          <span>{{ authState.enabled ? 'DDL Mate · 数据保存在本站服务器，每个账号相互隔离' : 'DDL Mate · 本地单人版，数据只保存在这台电脑' }}</span>
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

.update-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 8px 16px;
  font-size: 14px;
  background: var(--warn-soft);
  color: var(--warn);
  border-bottom: 1px solid var(--warn-line);
}

.sidebar__feedback {
  margin-bottom: 8px;
}

.sidebar__badge {
  margin-left: auto;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--clay);
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}

.sidebar__version {
  display: block;
  margin-top: 6px;
  padding: 0 12px;
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.8;
}

.sidebar__logout {
  width: 100%;
  margin-top: 8px;
  border: none;
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.topbar__week {
  margin-left: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary-dark);
  font-weight: 600;
}

.topbar__week:hover {
  text-decoration: none;
}
</style>
