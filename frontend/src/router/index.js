import { createRouter, createWebHistory } from 'vue-router'

const routes = [
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
    component: () => import('@/views/CourseListView.vue'),
    meta: { title: '课程与课表' },
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
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/views/NotFoundView.vue') },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.afterEach((to) => {
  const title = to.meta?.title
  document.title = title ? `${title} · DDL Mate` : 'DDL Mate'
})

export default router
