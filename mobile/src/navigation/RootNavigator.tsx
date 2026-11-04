import { GlobalSearchScreen } from '../screens/GlobalSearchScreen'
/**
 * 根导航：底部标签（今天 / 任务 / 课程 / 日历），每个标签内部是原生栈。
 *
 * 用的是 React Navigation 的 `@react-navigation/bottom-tabs` +
 * `@react-navigation/native-stack`，底层是 `react-native-screens` 的**原生**
 * 导航容器（不是 Web 路由，不是 iframe）。
 */

import React, { useCallback, useRef, useState } from 'react'
import { StyleSheet } from 'react-native'
import { TabMark } from '../ui/TabMark'
import { useReducedMotion } from '../ui/motion'
import {
  NavigationContainer,
  useNavigationContainerRef,
  type Theme,
} from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'

import { CalendarDayScreen } from '../screens/CalendarDayScreen'
import { CalendarMonthScreen } from '../screens/CalendarMonthScreen'
import { BatchNoticeScreen } from '../screens/BatchNoticeScreen'
import { BackupContentScreen } from '../screens/BackupContentScreen'
import { BackupScreen } from '../screens/BackupScreen'
import { CourseConflictsScreen } from '../screens/CourseConflictsScreen'
import { CourseDetailScreen } from '../screens/CourseDetailScreen'
import { CourseFormScreen } from '../screens/CourseFormScreen'
import { CourseListScreen } from '../screens/CourseListScreen'
import { ExamsScreen, ExamRevisionScreen } from '../screens/ExamScreens'
import { LearningReportScreen } from '../screens/LearningReportScreen'
import { FocusTimeScreen } from '../screens/FocusTimeScreen'
import { NoticeImportScreen } from '../screens/NoticeImportScreen'
import { ExamPhotoReviewScreen } from '../screens/ExamPhotoReviewScreen'
import { NoticePhotoScreen, ExamPhotoScreen } from '../screens/NoticePhotoScreen'
import { PhotoCompanionSettingsScreen } from '../screens/PhotoCompanionSettingsScreen'
import { PhotoImportScreen } from '../screens/PhotoImportScreen'
import { PhotoLibraryScreen } from '../screens/PhotoLibraryScreen'
import { PhotoReviewScreen } from '../screens/PhotoReviewScreen'
import { PressureScreen } from '../screens/PressureScreen'
import { ScheduleFormScreen } from '../screens/ScheduleFormScreen'
import { SourceArchiveScreen } from '../screens/SourceArchiveScreen'
import { TaskDetailScreen } from '../screens/TaskDetailScreen'
import { TaskFormScreen } from '../screens/TaskFormScreen'
import { TaskListScreen } from '../screens/TaskListScreen'
import { TaskTemplateFormScreen } from '../screens/TaskTemplateFormScreen'
import { TaskTemplateListScreen } from '../screens/TaskTemplateListScreen'
import { RecurrenceScreen } from '../screens/RecurrenceScreen'
import { ClassReminderScreen } from '../screens/ClassReminderScreen'
import { ClassReminderNotificationBanner } from '../ui/ClassReminderNotificationBanner'
import { FocusReminderNotificationBanner } from '../ui/FocusReminderNotificationBanner'
import { TaskPhotosScreen } from '../screens/TaskPhotosScreen'
import { TaskReminderScreen } from '../screens/TaskReminderScreen'
import { TaskStepsScreen } from '../screens/TaskStepsScreen'
import { TeachingWeekScreen } from '../screens/TeachingWeekScreen'
import { TodayScreen } from '../screens/TodayScreen'
import { TodayPlanScreen } from '../screens/TodayPlanScreen'
import { TaskReminderNotificationBanner } from '../ui/TaskReminderNotificationBanner'
import { useAppStore } from '../store/AppStore'
import { colors, spacing, typography } from '../ui/theme'
import { navigationReadyForRemount, shouldAcceptRemountReady } from './navigationDraftGuard'
import { useTaskReminderNotificationNavigation } from './useTaskReminderNotificationNavigation'
import type {
  CalendarStackParamList,
  CourseStackParamList,
  RootTabParamList,
  TaskStackParamList,
  TodayStackParamList,
} from './types'

const Tab = createBottomTabNavigator<RootTabParamList>()
const TodayStack = createNativeStackNavigator<TodayStackParamList>()
const TaskStack = createNativeStackNavigator<TaskStackParamList>()
const CourseStack = createNativeStackNavigator<CourseStackParamList>()
const CalendarStack = createNativeStackNavigator<CalendarStackParamList>()

const navigationTheme: Theme = {
  dark: false,
  colors: {
    primary: colors.primary,
    background: colors.bg,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    notification: colors.clay,
  },
  fonts: {
    regular: { fontFamily: 'System', fontWeight: '400' },
    medium: { fontFamily: 'System', fontWeight: '500' },
    bold: { fontFamily: 'System', fontWeight: '700' },
    heavy: { fontFamily: 'System', fontWeight: '800' },
  },
}

function TaskStackNavigator() {
  const reducedMotion = useReducedMotion()
  return (
    <TaskStack.Navigator screenOptions={{ ...stackScreenOptions, animation: reducedMotion ? 'none' : 'slide_from_right' }}>
      <TaskStack.Screen name="TaskList" component={TaskListScreen} options={{ title: '任务' }} />
      <TaskStack.Screen name="TaskTemplateList" component={TaskTemplateListScreen} options={{ title: '任务模板' }} />
      <TaskStack.Screen name="TaskTemplateForm" component={TaskTemplateFormScreen} options={{ title: '任务模板' }} />
      <TaskStack.Screen name="Recurrence" component={RecurrenceScreen} options={{ title: '重复任务' }} />
      <TaskStack.Screen name="TaskForm" component={TaskFormScreen} options={{ title: '任务表单' }} />
      <TaskStack.Screen
        name="TaskDetail"
        component={TaskDetailScreen}
        getId={({ params }) => String(params.id)}
        options={{ title: '任务详情' }}
      />
      <TaskStack.Screen name="NoticeImport" component={NoticeImportScreen} options={{ title: '通知转待办' }} />
      <TaskStack.Screen name="NoticePhoto" component={NoticePhotoScreen} options={{ title: '截图转待办' }} />
      <TaskStack.Screen name="BatchNotice" component={BatchNoticeScreen} options={{ title: '批量识别通知' }} />
      <TaskStack.Screen name="Pressure" component={PressureScreen} options={{ title: 'DDL 压力分析' }} />
      <TaskStack.Screen name="TodayPlan" component={TodayPlanScreen} options={{ title: '今日学习计划' }} />
      <TaskStack.Screen name="TaskSteps" component={TaskStepsScreen} options={{ title: '任务步骤' }} />
      <TaskStack.Screen name="TaskPhotos" component={TaskPhotosScreen} options={{ title: '任务原图' }} />
      <TaskStack.Screen name="TaskReminder" component={TaskReminderScreen} options={{ title: '提醒设置' }} />
      <TaskStack.Screen name="ExamPhoto" component={ExamPhotoScreen} options={{ title: '照片识别考试' }} />
      <TaskStack.Screen name="ExamPhotoReview" component={ExamPhotoReviewScreen} options={{ title: '核对考试' }} />
      <TaskStack.Screen name="Exams" component={ExamsScreen} options={{ title: '考试与复习' }} />
      <TaskStack.Screen name="ExamRevision" component={ExamRevisionScreen} getId={({ params }) => String(params.id)} options={{ title: '复习安排' }} />
      <TaskStack.Screen name="LearningReport" component={LearningReportScreen} options={{ title: '学习周报' }} />
      <TaskStack.Screen name="FocusTime" component={FocusTimeScreen} options={{ title: '专注计时' }} />
      <TaskStack.Screen name="CourseList" component={CourseListScreen} options={{ title: '课程与课表' }} />
      <TaskStack.Screen name="ClassReminder" component={ClassReminderScreen} options={{ title: '上课前提醒' }} />
      <TaskStack.Screen name="CourseForm" component={CourseFormScreen} options={{ title: '课程表单' }} />
      <TaskStack.Screen name="CourseDetail" component={CourseDetailScreen} options={{ title: '课程详情' }} />
      <TaskStack.Screen name="ScheduleForm" component={ScheduleFormScreen} options={{ title: '课表表单' }} />
      <TaskStack.Screen
        name="CourseConflicts"
        component={CourseConflictsScreen}
        options={{ title: '课表冲突检查' }}
      />
      <TaskStack.Screen name="TeachingWeek" component={TeachingWeekScreen} options={{ title: '教学周设置' }} />
      <TaskStack.Screen name="PhotoImport" component={PhotoImportScreen} options={{ title: '拍照导入课表' }} />
      <TaskStack.Screen name="PhotoReview" component={PhotoReviewScreen} options={{ title: '核对并导入' }} />
      <TaskStack.Screen name="PhotoLibrary" component={PhotoLibraryScreen} options={{ title: '截图库' }} />
      <TaskStack.Screen name="SourceArchive" component={SourceArchiveScreen} options={{ title: '历史截图来源' }} />
      <TaskStack.Screen
        name="CompanionSettings"
        component={PhotoCompanionSettingsScreen}
        options={{ title: '识别服务设置' }}
      />
      <TaskStack.Screen name="Backup" component={BackupScreen} options={{ title: '备份与恢复' }} />
      <TaskStack.Screen name="BackupContent" component={BackupContentScreen} options={{ title: '备份内容预览' }} />
      <TaskStack.Screen name="GlobalSearch" component={GlobalSearchScreen} options={{ title: '全局搜索' }} />
    </TaskStack.Navigator>
  )
}

/**
 * 「今天」标签自己的原生栈。
 *
 * `Today` 这一屏**隐藏原生标题栏**：今天页自己已经有标题区（问候语 + 日期），
 * 两套标题会重复；而它推出去的任务详情 / 表单 / 压力分析都用原生标题栏，
 * 因此返回按钮与原生返回手势全部可用。
 */
function TodayStackNavigator() {
  const reducedMotion = useReducedMotion()
  return (
    <TodayStack.Navigator screenOptions={{ ...stackScreenOptions, animation: reducedMotion ? 'none' : 'slide_from_right' }}>
      <TodayStack.Screen name="Today" component={TodayScreen} options={{ headerShown: false }} />
      <TodayStack.Screen name="TaskTemplateList" component={TaskTemplateListScreen} options={{ title: '任务模板' }} />
      <TodayStack.Screen name="TaskTemplateForm" component={TaskTemplateFormScreen} options={{ title: '任务模板' }} />
      <TodayStack.Screen name="Recurrence" component={RecurrenceScreen} options={{ title: '重复任务' }} />
      <TodayStack.Screen name="TaskForm" component={TaskFormScreen} options={{ title: '任务表单' }} />
      <TodayStack.Screen
        name="TaskDetail"
        component={TaskDetailScreen}
        getId={({ params }) => String(params.id)}
        options={{ title: '任务详情' }}
      />
      <TodayStack.Screen name="Pressure" component={PressureScreen} options={{ title: 'DDL 压力分析' }} />
      <TodayStack.Screen name="TodayPlan" component={TodayPlanScreen} options={{ title: '今日学习计划' }} />
      <TodayStack.Screen name="TaskSteps" component={TaskStepsScreen} options={{ title: '任务步骤' }} />
      <TodayStack.Screen name="TaskPhotos" component={TaskPhotosScreen} options={{ title: '任务原图' }} />
      <TodayStack.Screen name="TaskReminder" component={TaskReminderScreen} options={{ title: '提醒设置' }} />
      <TodayStack.Screen name="ExamPhoto" component={ExamPhotoScreen} options={{ title: '照片识别考试' }} />
      <TodayStack.Screen name="ExamPhotoReview" component={ExamPhotoReviewScreen} options={{ title: '核对考试' }} />
      <TodayStack.Screen name="Exams" component={ExamsScreen} options={{ title: '考试与复习' }} />
      <TodayStack.Screen name="ExamRevision" component={ExamRevisionScreen} getId={({ params }) => String(params.id)} options={{ title: '复习安排' }} />
      <TodayStack.Screen name="LearningReport" component={LearningReportScreen} options={{ title: '学习周报' }} />
      <TodayStack.Screen name="FocusTime" component={FocusTimeScreen} options={{ title: '专注计时' }} />
      <TodayStack.Screen name="Backup" component={BackupScreen} options={{ title: '备份与恢复' }} />
      <TodayStack.Screen name="BackupContent" component={BackupContentScreen} options={{ title: '备份内容预览' }} />
      <TodayStack.Screen name="CourseList" component={CourseListScreen} options={{ title: '课程与课表' }} />
      <TodayStack.Screen name="ClassReminder" component={ClassReminderScreen} options={{ title: '上课前提醒' }} />
      <TodayStack.Screen name="CourseForm" component={CourseFormScreen} options={{ title: '课程表单' }} />
      <TodayStack.Screen name="CourseDetail" component={CourseDetailScreen} options={{ title: '课程详情' }} />
      <TodayStack.Screen name="ScheduleForm" component={ScheduleFormScreen} options={{ title: '课表表单' }} />
      <TodayStack.Screen
        name="CourseConflicts"
        component={CourseConflictsScreen}
        options={{ title: '课表冲突检查' }}
      />
      <TodayStack.Screen name="TeachingWeek" component={TeachingWeekScreen} options={{ title: '教学周设置' }} />
      <TodayStack.Screen name="PhotoImport" component={PhotoImportScreen} options={{ title: '拍照导入课表' }} />
      <TodayStack.Screen name="PhotoReview" component={PhotoReviewScreen} options={{ title: '核对并导入' }} />
      <TodayStack.Screen name="PhotoLibrary" component={PhotoLibraryScreen} options={{ title: '截图库' }} />
      <TodayStack.Screen name="SourceArchive" component={SourceArchiveScreen} options={{ title: '历史截图来源' }} />
      <TodayStack.Screen
        name="CompanionSettings"
        component={PhotoCompanionSettingsScreen}
        options={{ title: '识别服务设置' }}
      />
      <TodayStack.Screen name="GlobalSearch" component={GlobalSearchScreen} options={{ title: '全局搜索' }} />
    </TodayStack.Navigator>
  )
}

function CourseStackNavigator() {
  const reducedMotion = useReducedMotion()
  return (
    <CourseStack.Navigator screenOptions={{ ...stackScreenOptions, animation: reducedMotion ? 'none' : 'slide_from_right' }}>
      <CourseStack.Screen name="CourseList" component={CourseListScreen} options={{ title: '课程与课表' }} />
      <CourseStack.Screen name="ClassReminder" component={ClassReminderScreen} options={{ title: '上课前提醒' }} />
      <CourseStack.Screen name="CourseForm" component={CourseFormScreen} options={{ title: '课程表单' }} />
      <CourseStack.Screen name="CourseDetail" component={CourseDetailScreen} options={{ title: '课程详情' }} />
      <CourseStack.Screen name="ScheduleForm" component={ScheduleFormScreen} options={{ title: '课表表单' }} />
      <CourseStack.Screen
        name="CourseConflicts"
        component={CourseConflictsScreen}
        options={{ title: '课表冲突检查' }}
      />
      <CourseStack.Screen name="TeachingWeek" component={TeachingWeekScreen} options={{ title: '教学周设置' }} />
      <CourseStack.Screen name="PhotoImport" component={PhotoImportScreen} options={{ title: '拍照导入课表' }} />
      <CourseStack.Screen name="PhotoReview" component={PhotoReviewScreen} options={{ title: '核对并导入' }} />
      <CourseStack.Screen name="PhotoLibrary" component={PhotoLibraryScreen} options={{ title: '截图库' }} />
      <CourseStack.Screen name="SourceArchive" component={SourceArchiveScreen} options={{ title: '历史截图来源' }} />
      <CourseStack.Screen
        name="CompanionSettings"
        component={PhotoCompanionSettingsScreen}
        options={{ title: '识别服务设置' }}
      />
      <CourseStack.Screen name="Backup" component={BackupScreen} options={{ title: '备份与恢复' }} />
      <CourseStack.Screen name="BackupContent" component={BackupContentScreen} options={{ title: '备份内容预览' }} />
    </CourseStack.Navigator>
  )
}

function CalendarStackNavigator() {
  const reducedMotion = useReducedMotion()
  return (
    <CalendarStack.Navigator screenOptions={{ ...stackScreenOptions, animation: reducedMotion ? 'none' : 'slide_from_right' }}>
      <CalendarStack.Screen name="CalendarMonth" component={CalendarMonthScreen} options={{ title: '日历' }} />
      <CalendarStack.Screen name="CalendarDay" component={CalendarDayScreen} options={{ title: '某一天' }} />
    </CalendarStack.Navigator>
  )
}

const stackScreenOptions = {
  headerStyle: { backgroundColor: colors.bg },
  headerShadowVisible: false,
  headerBackButtonDisplayMode: 'minimal',
  headerTintColor: colors.primaryDark,
  headerTitleStyle: { color: colors.text },
  contentStyle: { backgroundColor: colors.bg },
} as const

export function RootNavigator(): React.ReactElement {
  const navigationRef = useNavigationContainerRef<RootTabParamList>()
  const [readyRemountKey, setReadyRemountKey] = useState<number | null>(null)
  const { navigationRemountKey, acknowledgeRestoreNavigationReset } = useAppStore()

  /**
   * 通知点击的路由只在**导航容器就绪之后**执行；冷启动的 last response
   * 会在模块加载完成后排队，等 onReady 再跳（不会丢，也不会抢在挂载前导航）。
   *
   * 就绪状态由「已就绪 key === 当前 key」推导，而不是父 effect 事后置 false：
   * 新容器可能先触发 onReady，父子被动 effect 的顺序不能用来保证正确性。
   */
  const navigationReady = navigationReadyForRemount(readyRemountKey, navigationRemountKey)
  const notificationNavigation = useTaskReminderNotificationNavigation(navigationRef, navigationReady)

  const latestKeyRef = useRef(navigationRemountKey)
  latestKeyRef.current = navigationRemountKey

  /**
   * 恢复提交后用一个**新的 NavigationContainer key** 真正重建整棵导航树。
   * onReady 回调绑定调用时的 key；旧容器迟到的 onReady 会被拒绝，也不能 ack
   * 当前恢复。store 收到带 key 的确认后才释放写入闸门。
   */
  const handleNavigationReady = useCallback(() => {
    const callbackKey = navigationRemountKey
    if (!shouldAcceptRemountReady(callbackKey, latestKeyRef.current)) return
    setReadyRemountKey(callbackKey)
    acknowledgeRestoreNavigationReset(callbackKey)
  }, [acknowledgeRestoreNavigationReset, navigationRemountKey])

  return (
    <>
      <NavigationContainer ref={navigationRef} key={navigationRemountKey} theme={navigationTheme} onReady={handleNavigationReady}>
        <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.primaryDark,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarStyle: styles.tabBar,
          tabBarLabelStyle: styles.tabLabel,
          // 触控目标 ≥ 44pt
          tabBarItemStyle: styles.tabItem,
        }}
      >
        <Tab.Screen
          name="Today"
          component={TodayStackNavigator}
          options={{
            title: '今天',
            tabBarAccessibilityLabel: '今天',
            tabBarIcon: ({ focused }) => <TabMark name="today" focused={focused} />,
          }}
        />
        <Tab.Screen
          name="Tasks"
          component={TaskStackNavigator}
          options={{
            title: '任务',
            tabBarAccessibilityLabel: '任务',
            tabBarIcon: ({ focused }) => <TabMark name="tasks" focused={focused} />,
          }}
        />
        <Tab.Screen
          name="Courses"
          component={CourseStackNavigator}
          options={{
            title: '课程',
            tabBarAccessibilityLabel: '课程与课表',
            tabBarIcon: ({ focused }) => <TabMark name="courses" focused={focused} />,
          }}
        />
        <Tab.Screen
          name="Calendar"
          component={CalendarStackNavigator}
          options={{
            title: '日历',
            tabBarAccessibilityLabel: '日历',
            tabBarIcon: ({ focused }) => <TabMark name="calendar" focused={focused} />,
          }}
        />
      </Tab.Navigator>
      </NavigationContainer>
      <TaskReminderNotificationBanner
        state={notificationNavigation.state}
        onRetry={notificationNavigation.retry}
        onDismiss={notificationNavigation.dismiss}
        onOpenTaskList={notificationNavigation.openTaskList}
      />
      <ClassReminderNotificationBanner navigationRef={navigationRef} ready={navigationReady} />
      <FocusReminderNotificationBanner navigationRef={navigationRef} ready={navigationReady} />
    </>
  )
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  tabItem: { minHeight: 48, paddingVertical: spacing.xs },
  tabLabel: { fontSize: 12, fontWeight: '600' },
  tabIcon: { height: 22, justifyContent: 'center' },
  tabGlyph: { fontSize: 18, color: colors.textMuted },
  tabGlyphFocused: { color: colors.primaryDark },
})
