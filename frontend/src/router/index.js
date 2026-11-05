import { createRouter, createWebHistory } from 'vue-router'
import { authApi } from '@/api'
import { authState } from '@/utils/authState'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { title: '登录', public: true, bare: true },
  },
  {
    path: '/setup',
    name: 'setup',
    component: () => import('@/views/SetupView.vue'),
    meta: { title: '设置登录密码', public: true, bare: true },
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('@/views/RegisterView.vue'),
    meta: { title: '注册', public: true, bare: true },
  },
  { path: '/', name: 'home', component: () => import('@/views/HomeView.vue'), meta: { title: '首页' } },
  {
    path: '/tasks',
    name: 'tasks',
    component: () => import('@/views/TaskListView.vue'),
    meta: { title: 'DDL 列表' },
  },
  {
    path: '/tasks/new',
    name: 'task-new',
    component: () => import('@/views/TaskFormView.vue'),
    meta: { title: '新建任务', section: 'tasks' },
  },
  {
    // 必须放在 /tasks/:id 之前，否则会被当成 id=import-notices 的任务详情
    path: '/tasks/import-notices',
    name: 'task-import-notices',
    component: () => import('@/views/ImportNoticesView.vue'),
    meta: { title: '从通知创建任务', section: 'tasks' },
  },
  {
    path: '/tasks/:id',
    name: 'task-detail',
    component: () => import('@/views/TaskDetailView.vue'),
    meta: { title: '任务详情', section: 'tasks' },
  },
  {
    path: '/tasks/:id/edit',
    name: 'task-edit',
    component: () => import('@/views/TaskFormView.vue'),
    meta: { title: '编辑任务', section: 'tasks' },
  },
  {
    path: '/courses',
    name: 'courses',
    component: () => import('@/views/CourseHomeView.vue'),
    meta: { title: '课程与课表' },
  },
  {
    path: '/courses/manage',
    name: 'course-manage',
    component: () => import('@/views/CourseListView.vue'),
    meta: { title: '编辑课程', section: 'courses' },
  },
  {
    path: '/courses/import-schedule',
    name: 'schedule-import',
    component: () => import('@/views/ScheduleImportView.vue'),
    meta: { title: '照片导入课表', section: 'courses' },
  },
  {
    path: '/courses/:id',
    name: 'course-detail',
    component: () => import('@/views/CourseDetailView.vue'),
    meta: { title: '课程详情', section: 'courses' },
  },
  {
    path: '/calendar',
    name: 'calendar',
    component: () => import('@/views/CalendarView.vue'),
    meta: { title: '日历' },
  },
  {
    path: '/calendar/day/:date',
    name: 'calendar-day',
    component: () => import('@/views/CalendarDayView.vue'),
    meta: { title: '日期详情', section: 'calendar' },
  },
  {
    path: '/sources',
    name: 'sources',
    component: () => import('@/views/SourceListView.vue'),
    meta: { title: '原通知' },
  },
  {
    path: '/about',
    name: 'about',
    component: () => import('@/views/AboutView.vue'),
    meta: { title: '路线图与说明' },
  },
  { path: '/focus', name: 'focus', component: () => import('@/views/FocusView.vue'), meta: { title: '专注' } },
  {
    path: '/plan/today',
    name: 'today-plan',
    component: () => import('@/views/TodayPlanView.vue'),
    meta: { title: '今日学习计划' },
  },
  {
    path: '/plan/pressure',
    name: 'pressure',
    component: () => import('@/views/PressureView.vue'),
    meta: { title: 'DDL 压力分析' },
  },
  {
    path: '/plan/report',
    name: 'learning-report',
    component: () => import('@/views/LearningReportView.vue'),
    meta: { title: '学习周报' },
  },
  {
    path: '/tools/templates',
    name: 'task-templates',
    component: () => import('@/views/TaskTemplatesView.vue'),
    meta: { title: '任务模板' },
  },
  {
    path: '/tools/recurrence',
    name: 'recurrence',
    component: () => import('@/views/RecurrenceView.vue'),
    meta: { title: '重复任务' },
  },
  { path: '/exams', name: 'exams', component: () => import('@/views/ExamsView.vue'), meta: { title: '考试与复习' } },
  {
    path: '/tools/conflicts',
    name: 'course-conflicts',
    component: () => import('@/views/CourseConflictsView.vue'),
    meta: { title: '课表冲突检查' },
  },
  {
    path: '/tools/school-import',
    name: 'school-import',
    component: () => import('@/views/SchoolImportView.vue'),
    meta: { title: '学校一键导入' },
  },
  {
    path: '/tools/teaching-week',
    name: 'teaching-week',
    component: () => import('@/views/TeachingWeekView.vue'),
    meta: { title: '教学周' },
  },
  {
    path: '/tools/reminders',
    name: 'reminders',
    component: () => import('@/views/RemindersView.vue'),
    meta: { title: '提醒' },
  },
  { path: '/tools/backup', name: 'backup', component: () => import('@/views/BackupView.vue'), meta: { title: '备份与恢复' } },
  { path: '/search', name: 'search', component: () => import('@/views/SearchView.vue'), meta: { title: '全局搜索' } },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/views/NotFoundView.vue') },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

/**
 * 服务器版启用了登录时，未登录先去登录页。本机版（未启用登录）me() 恒为已登录，不受影响。
 * 只在第一次导航时问一次后端；之后靠接口返回 401 的事件把状态改回未登录。
 */
router.beforeEach(async (to) => {
  if (authState.checked === false) {
    try {
      const me = await authApi.me()
      authState.enabled = me.authEnabled
      authState.authenticated = me.authenticated
      authState.username = me.username ?? ''
      authState.setupAvailable = me.setupAvailable === true
      authState.registrationEnabled = me.registrationEnabled === true
    } catch {
      // 后端连不上时不拦截，由页面自己显示连接错误
      authState.authenticated = true
    }
    authState.checked = true
  }
  if (!to.meta.public && authState.enabled && !authState.authenticated) {
    return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } }
  }
  if ((to.name === 'login' || to.name === 'register') && authState.enabled && authState.authenticated) return { path: '/' }
  return true
})

router.afterEach((to) => {
  const title = to.meta?.title
  document.title = title ? `${title} · DDL Mate` : 'DDL Mate'
})

export default router
