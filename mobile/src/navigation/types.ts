/** 路由参数类型：全部显式声明，导航调用有类型检查，不会拼错参数名。 */

import type { NavigatorScreenParams } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'

export type TaskStackParamList = CourseStackParamList & {
  GlobalSearch: undefined
  FocusTime: undefined
  TaskList: undefined
  /** 不传 id 表示新建；传 id 表示编辑该任务；传 templateId 表示应用模板生成可编辑草稿。 */
  TaskForm: { id?: number; templateId?: number; defaultType?: 'EXAM' } | undefined
  TaskDetail: { id: number }
  /** 任务模板列表：从任务列表 / 今天 / 任务详情进入。 */
  TaskTemplateList: undefined
  /** 新建 / 编辑模板；`sourceTaskId` 表示“把这条任务存为模板”。 */
  TaskTemplateForm: { id?: number; sourceTaskId?: number } | undefined
  /** 重复任务规则列表 + 编辑器 + 实际日期预览（本版本只做显式批量创建）。 */
  Recurrence: undefined
  /** 通知原文转待办：粘贴原文 → 提取候选 → 逐条核对 → 明确勾选后保存。 */
  NoticeImport: { initialSourceText?: string } | undefined
  /** 截图转待办：一张通知截图 → 本机电脑 OCR → 可编辑文字 → 打开上面的 NoticeImport。 */
  NoticePhoto: undefined
  /** 批量识别通知截图：最多 8 张，顺序本机 OCR，每张单独进入 NoticeImport 核对保存。 */
  BatchNotice: undefined
  /** DDL 压力分析：未来 7 个上海自然日的到期集中度（纯统计，不是日程）。 */
  Pressure: undefined
  /** 今日学习计划：显式时段 + 选中任务 + 每任务计划分钟 → 只读预览 → 显式采用并保存。 */
  TodayPlan: undefined
  /** 任务步骤清单：把这条任务手动拆成几步（勾选只是清单，不会改动任务本身）。 */
  TaskSteps: { id: number }
  /** 任务原图：查看 / 显式添加 / 解除这条任务与截图库原图的关联。 */
  TaskPhotos: { id: number }
  /** 任务截止提醒：本机通知设置；默认关闭，只有用户显式开启才安排。 */
  TaskReminder: { id: number }
  /** 学习周报：按上海时间周一至周日统计完成 / 到期 / 逾期；只读当前快照。 */
  LearningReport: undefined
  ExamPhoto: undefined
  ExamPhotoReview: { sourceText: string; attemptId: number; generation: number }
  Exams: undefined
  ExamRevision: { id: number }
}

/**
 * 「今天」标签自己的原生栈。
 *
 * 背景（原有实现的真实缺陷）：今天页在**任务栈的上下文之外**调用
 * `navigation.navigate('TaskDetail')`。切到「今天」时任务栈并没有挂载，
 * 于是这个动作不会真正落到导航状态里（不报错，也不跳转）。
 * 给今天页一条自己的栈之后，「今天 → 任务详情 / 编辑 / 压力分析」都是本栈内真实可达的路由。
 */
export type TodayStackParamList = CourseStackParamList & {
  GlobalSearch: undefined
  FocusTime: undefined
  Today: undefined
  TaskForm: { id?: number; templateId?: number; defaultType?: 'EXAM' } | undefined
  TaskDetail: { id: number }
  /** 任务模板列表（与任务栈共用同一个原生界面组件）。 */
  TaskTemplateList: undefined
  /** 新建 / 编辑模板（与任务栈共用同一个原生界面组件）。 */
  TaskTemplateForm: { id?: number; sourceTaskId?: number } | undefined
  /** 重复任务规则 / 预览（与任务栈共用同一个原生界面组件）。 */
  Recurrence: undefined
  /** DDL 压力分析（与任务栈共用同一个原生界面组件）。 */
  Pressure: undefined
  /** 今日学习计划（与任务栈共用同一个原生界面组件）。 */
  TodayPlan: undefined
  /** 任务步骤清单（与任务栈共用同一个原生界面组件，路由参数同为 `{ id }`）。 */
  TaskSteps: { id: number }
  /** 任务原图（与任务栈共用同一个原生界面组件，路由参数同为 `{ id }`）。 */
  TaskPhotos: { id: number }
  /** 任务截止提醒（与任务栈共用同一个原生界面组件，路由参数同为 `{ id }`）。 */
  TaskReminder: { id: number }
  /** 学习周报（与任务栈共用同一个原生界面组件）。 */
  LearningReport: undefined
  ExamPhoto: undefined
  ExamPhotoReview: { sourceText: string; attemptId: number; generation: number }
  Exams: undefined
  ExamRevision: { id: number }
  /** 数据备份与恢复（与课程栈共用同一个原生界面组件）。 */
  Backup: undefined
  /** 备份文件的只读内容预览（与课程栈共用同一个原生界面组件）。 */
  BackupContent: { viewDir: string }
}

export type CourseStackParamList = {
  ClassReminder: undefined
  CourseList: undefined
  CourseForm: { id?: number } | undefined
  CourseDetail: { id: number }
  ScheduleForm: { courseId: number; scheduleId?: number }
  /** 课表冲突检查：只读，固定从今天起 14 天。 */
  CourseConflicts: undefined
  /** 全局教学周校准（每个学期设置一次）。 */
  TeachingWeek: undefined
  /** 拍照导入课表：第一步（拍照/选图 + 本机电脑识别）。 */
  PhotoImport: undefined
  /** 拍照导入课表：第二步（逐行核对 + 一键导入）。参数是 JSON 字符串，保证可序列化。 */
  PhotoReview: { payload: string }
  /** 本机识别（OCR）伴侣服务地址设置。 */
  CompanionSettings: undefined
  /** 截图库：用户提交过的每一张图（可全屏缩放查看、可重新识别）。 */
  PhotoLibrary: { focusAttemptId?: number } | undefined
  /** 历史截图来源：从电脑把已知的那几张图取回本机截图库。 */
  SourceArchive: undefined
  /** 数据备份与恢复（与今天栈共用同一个原生界面组件）。 */
  Backup: undefined
  /** 备份文件的只读内容预览（与今天栈共用同一个原生界面组件）。 */
  BackupContent: { viewDir: string }
}

export type CalendarStackParamList = {
  CalendarMonth: undefined
  CalendarDay: { dateKey: string }
}

/**
 * 根标签参数。
 *
 * 每个标签内部都是原生栈，因此这里用 `NavigatorScreenParams` 明确声明嵌套路由：
 * 外部（通知点击、跨标签跳转）可以类型安全地写
 * `navigate('Tasks', { screen: 'TaskDetail', params: { id } })`，
 * 而不是把标签参数退化成 `any` 或手写一个容易漂移的局部类型。
 */
export type RootTabParamList = {
  Today: NavigatorScreenParams<TodayStackParamList> | undefined
  Tasks: NavigatorScreenParams<TaskStackParamList> | undefined
  Courses: NavigatorScreenParams<CourseStackParamList> | undefined
  Calendar: NavigatorScreenParams<CalendarStackParamList> | undefined
}

/** 备份页与只读内容页在 Today / Course 两条栈里同名同参数。 */
export type SharedBackupRoutes = Pick<TodayStackParamList, 'Backup' | 'BackupContent'>

/**
 * 「今天」栈与「任务」栈**共有**的路由参数。
 *
 * 两页都会推同一个压力分析屏（`Pressure`），也都会推任务详情 / 表单。
 * 组件只通过 `useNavigation()` 拿导航对象，无法静态知道自己在哪条栈里，
 * 因此它的类型用这个公共子集：任何一条栈里都成立，又不会退化成 `any`。
 */
export type SharedTaskRoutes = Pick<TodayStackParamList, 'TaskForm' | 'TaskDetail' | 'Pressure' | 'TodayPlan'>

/**
 * 在 {@link SharedTaskRoutes} 之上再加「任务步骤清单」。
 *
 * 为什么不直接改上面那一行的字面量：既有的接线测试锁定了它本来的形状，
 * 而授权书要求「保留既有测试、不去绕开它们」。步骤屏用它自己的窄类型即可。
 */
export type SharedTaskRoutesWithSteps = SharedTaskRoutes & Pick<TodayStackParamList, 'TaskSteps'>

/**
 * 任务详情页还要推「任务原图」。
 *
 * 与步骤清单同一个考虑：不改动既有 {@link SharedTaskRoutesWithSteps} 的形状，
 * 只在这里加一个窄类型，避免让只关心步骤的既有页面 / 测试跟着漂移。
 */
export type SharedTaskRoutesWithPhotos = SharedTaskRoutesWithSteps & Pick<TodayStackParamList, 'TaskPhotos'>

/**
 * 任务详情页还要推「提醒设置」。
 *
 * 与上面的窄类型同一个考虑：不改既有公共子集的形状，避免只关心步骤 / 原图
 * 的页面和测试跟着漂移。
 */
export type SharedTaskRoutesWithReminders = SharedTaskRoutesWithPhotos & Pick<TodayStackParamList, 'TaskReminder'>

/**
 * 任务详情页还要推模板 / 重复任务入口。
 *
 * 仍然用窄类型扩展，不改动上面已存在的公共子集形状。
 */
export type SharedTaskRoutesWithTemplates = SharedTaskRoutesWithReminders &
  Pick<TodayStackParamList, 'TaskReminder' | 'TaskTemplateList' | 'TaskTemplateForm' | 'Recurrence'>

/**
 * 学习周报页只从两条栈共有的任务详情入口继续往下走；
 * 单独用窄类型，避免改动既有 `SharedTaskRoutes` 的形状。
 */
export type SharedLearningReportRoutes = Pick<TodayStackParamList, 'LearningReport' | 'TaskDetail'>

export type TaskStackScreenProps<T extends keyof TaskStackParamList> = NativeStackScreenProps<
  TaskStackParamList,
  T
>
export type TodayStackScreenProps<T extends keyof TodayStackParamList> = NativeStackScreenProps<
  TodayStackParamList,
  T
>
export type CourseStackScreenProps<T extends keyof CourseStackParamList> = NativeStackScreenProps<
  CourseStackParamList,
  T
>
export type CalendarStackScreenProps<T extends keyof CalendarStackParamList> = NativeStackScreenProps<
  CalendarStackParamList,
  T
>

export type SharedExamRoutes = Pick<TodayStackParamList, 'Exams' | 'ExamRevision' | 'ExamPhoto' | 'ExamPhotoReview' | 'TaskDetail' | 'TaskForm'>
