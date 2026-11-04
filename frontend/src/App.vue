<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { profileApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import { todayLabel } from '@/utils/datetime'

const route = useRoute()
const profile = ref(null)
const profileError = ref('')

/** 导航分组：桌面左边栏按组展示，移动端在紧凑顶栏里拉平成一行（可横向滚动）。 */
const navGroups = [
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
    label: '资料',
    items: [
      { name: 'sources', to: '/sources', label: '原通知', icon: 'inbox' },
      { name: 'about', to: '/about', label: '路线图', icon: 'compass' },
    ],
  },
]

const navItems = computed(() => navGroups.flatMap((group) => group.items))
const todayText = todayLabel()

/** 子路由统一归到所属一级导航，包含导入页与详情页。 */
const SECTION_BY_ROUTE = {
  home: 'home',
  tasks: 'tasks',
  'task-new': 'tasks',
  'task-edit': 'tasks',
  'task-detail': 'tasks',
  'task-import-notices': 'tasks',
  calendar: 'calendar',
  'calendar-day': 'calendar',
  courses: 'courses',
  'course-detail': 'courses',
  'schedule-import': 'courses',
  sources: 'sources',
  about: 'about',
}

const activeName = computed(() => SECTION_BY_ROUTE[route.name] || route.name)

const profileLine = computed(() => {
  if (profile.value) return `${profile.value.displayName} · ${profile.value.timeZone}`
  if (profileError.value) return '本地资料暂不可用'
  return '本地资料读取中…'
})

onMounted(async () => {
  try {
    profile.value = await profileApi.get()
  } catch (error) {
    profileError.value = error.message
  }
})
</script>

<template>
  <div class="app-shell">
    <a class="skip-link" href="#main">跳到主要内容</a>

    <!-- 桌面：左侧 232px 边栏 -->
    <aside class="sidebar" aria-label="主导航">
      <RouterLink class="sidebar__brand" to="/">
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
            :aria-current="activeName === item.name ? 'page' : undefined"
          >
            <AppIcon :name="item.icon" :size="18" />
            <span>{{ item.label }}</span>
          </RouterLink>
        </template>
      </nav>

      <div class="sidebar__foot">
        <RouterLink class="sidebar__foot-card" to="/about">
          <span class="sidebar__foot-title">
            <AppIcon name="user" :size="16" />
            本地资料
          </span>
          <span class="sidebar__foot-meta">{{ profileLine }}</span>
        </RouterLink>
      </div>
    </aside>

    <div class="app-body">
      <!-- 移动端紧凑顶栏；桌面只保留日期上下文 -->
      <header class="topbar">
        <div class="topbar__inner">
          <RouterLink class="topbar__brand" to="/">
            <span class="topbar__mark" aria-hidden="true"><AppIcon name="check" :size="17" /></span>
            <span>DDL Mate</span>
          </RouterLink>
          <span class="topbar__date">{{ todayText }}</span>
        </div>
        <nav class="topbar__nav" aria-label="主导航">
          <RouterLink
            v-for="item in navItems"
            :key="item.name"
            class="nav__link"
            :class="{ 'nav__link--active': activeName === item.name }"
            :to="item.to"
            :aria-current="activeName === item.name ? 'page' : undefined"
          >
            <AppIcon :name="item.icon" :size="17" />
            <span>{{ item.label }}</span>
          </RouterLink>
        </nav>
      </header>

      <main id="main" class="app-main">
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
  </div>
</template>

<style scoped>
.app-body {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  min-width: 0;
}
</style>
