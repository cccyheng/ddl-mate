import { applyTaskBatch } from '../domain/taskBatchRepository'
/**
 * 应用状态：数据库引导 + 内存中的课程/课表/任务快照 + 全局教学周校准。
 *
 * 设计取舍：本应用是**单机个人工具**，数据量在几十到几百条，
 * 因此每次写入后做一次全量重读（3 条简单 SELECT），
 * 换来「界面永远等于数据库真实内容」的强一致，比手工维护增量状态更难出错。
 * 所有写入都通过仓库层，界面不做任何 SQL。
 *
 * 三类状态被**刻意分开**，避免互相误导（这是复核提出的重点）：
 * - `status` / `error`：只描述**数据库引导**（打开 + 迁移）的结果；
 * - `refreshError`：只描述**读取快照**失败，与「保存」无关；
 * - 保存结果由调用方从仓库拿到的 `SaveOutcome` / `ScheduleBatchOutcome` /
 *   `ScheduleImportOutcome` 判断（`committed` 才是唯一事实）。
 *
 * 所有写入 + 随后的刷新都在一条**串行队列**里执行，
 * 这样就不会出现「上一次刷新的快照把刚写入的数据盖回去」的竞态。
 *
 * 唯一的例外是**照片批量导入**：它必须自己开一条 `BEGIN IMMEDIATE` 把
 * 多个课程与多条课表一次性写完，因此不能放进 `enqueue` 的「写 + 刷新」模式里
 * （那会在一个覆盖全库的事务里再开一个事务）。导入**单独串行化**，
 * 完成后再调用 `refresh()`；界面仍然拿 `committed` 判断真实结果。
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { CLASS_REMINDER_KEY, decodeClassReminderSettings } from '../domain/classReminder'
import { createClassReminderService, withClassReminderLifecycle, type ClassReminderService } from '../domain/classReminderService'
import { AppState } from 'react-native'
import Constants from 'expo-constants'

import { bootstrapDatabase, type AppDatabase } from '../db'
import { loadFocus, saveFocusAction } from '../domain/focusTimeRepository'
import { loadWeeklyGoals, saveWeeklyGoal } from '../domain/weeklyGoalRepository'
import { createFocusReminderService, withFocusReminderLifecycle, type FocusReminderService, type FocusReminderSnapshot } from '../domain/focusReminderService'
import {
  closeBackupContentView,
  createLocalBackup,
  discardBackupStaging,
  exportBackupToDirectory,
  listBackupLibrary,
  listRecoveryBackups,
  openBackupContentView,
  preflightRestore,
  resolveBackupLibraryFile,
  retainBackupInLibrary,
  restoreStagedBackup,
  saveBackupLibraryEntryToDirectory,
  saveRecoveryBackupToDirectory,
  stageBackupForPreview,
  type BackupContentView,
  type BackupExportResult,
  type BackupFileSystem,
  type BackupLibraryEntry,
  type BackupPreviewSummary,
  type BackupRestoreSuccess,
  type RecoveryBackupFile,
  type RecoveryBackupInfo,
} from '../domain/backupService'
import { createExpoBackupFileSystem } from '../domain/backupFileSystem'
import {
  BackupContentViewLeases,
  BackupOperationGate,
  retainLastSuccessfulExport,
  shouldCloseContentView,
  type BackupGateState,
} from '../domain/backupOperationGate'
import { CourseRepository, type ScheduleBatchChange, type ScheduleBatchOutcome } from '../domain/courseRepository'
import {
  checkCompanionHealth,
  endpointFromHostUri,
  normalizeEndpoint,
  resolveOcrEndpoint,
  type OcrResponse,
} from '../domain/photoOcrClient'
import { fetchCompanionArchiveSources, type CompanionArchiveFetchResult } from '../domain/companionArchiveClient'
import { archivePickedPhoto, type ScreenshotArchiveOutcome } from '../domain/screenshotArchive'
import {
  archivedFileExists,
  downloadArchivedSource,
  readArchivedBase64,
  type ScreenshotFileSystem,
} from '../domain/screenshotFiles'
import {
  importScreenshotImagesFromBackup,
  imagesFromBackupContentView,
  readImagesFromStagedBackup,
  type ScreenshotImageImportOutcome,
} from '../domain/screenshotBackupImport'
import {
  repairScreenshotPaths as repairScreenshotPathsDomain,
  type ScreenshotPathRepairReport,
} from '../domain/screenshotPathRecovery'
import {
  ScreenshotLibraryRepository,
  type OcrResult,
  type ScreenshotAttempt,
  type ScreenshotAttemptSource,
  type ScreenshotRefTargetKind,
  type SourceScreenshot,
} from '../domain/screenshotLibraryRepository'
import { KNOWN_SOURCE_CATALOG, knownSourceByKey, knownSourceToCatalogEntry, verifyDownloadedSource, type KnownSourceEntry } from '../domain/screenshotSources'
import { ScheduleImportRepository, type ScheduleImportOutcome, type ScheduleImportRequest } from '../domain/scheduleImportRepository'
import {
  TaskPhotoRepository,
  type AttachTaskPhotoOutcome,
  type DetachTaskPhotoOutcome,
  type TaskPhotoCandidatesSnapshot,
  type TaskPhotosSnapshot,
} from '../domain/taskPhotoRepository'
import {
  NoticeImportRepository,
  type NoticeImportOutcome,
  type NoticeImportRequest,
} from '../domain/noticeImportRepository'
import { AppSettingsRepository } from '../domain/settingsRepository'
import {
  TodayPlanRepository,
  type SaveTodayPlanInput,
  type SaveTodayPlanResult,
  type TodayPlanLoadResult,
} from '../domain/todayPlanRepository'
import type { TodayPlanContext } from '../domain/todayPlan'
import {
  TaskStepsRepository,
  type SaveTaskStepsInput,
  type SaveTaskStepsResult,
  type TaskStepsLoadResult,
} from '../domain/taskStepsRepository'
import { TaskReminderRepository, type SaveTaskReminderInput } from '../domain/taskReminderRepository'
import {
  TaskReminderNotificationReceiptsRepository,
  type NotificationReceiptConsumption,
  type NotificationReceiptRecordResult,
} from '../domain/taskReminderNotificationReceiptsRepository'
import type { TaskReminderNotificationReceipt } from '../domain/taskReminderNotificationReceipts'
import {
  createTaskReminderService,
  type SaveTaskReminderServiceOutcome,
  type TaskReminderInspection,
  type TaskReminderReconcileReport,
  type TaskReminderService,
  type TaskReminderServiceSnapshot,
  type TestReminderOutcome,
} from '../domain/taskReminderService'
import { createExpoTaskReminderPort } from '../domain/expoTaskReminderPort'
import type { ReminderTaskLike } from '../domain/taskReminder'
import { todayInBeijing, type TeachingWeekCalibration } from '../domain/teachingWeek'
import { TaskRepository, type SaveOutcome } from '../domain/taskRepository'
import { ExamRevisionRepository, type ExamRevisionStore } from '../domain/examRevisionRepository'
import { importExamPhoto, type ExamPhotoImportRequest, type ExamPhotoImportResult } from '../domain/examPhotoRepository'
import type { RevisionInput } from '../domain/examRevision'
import {
  TaskTemplateRepository,
  type GenerateRecurrenceOutcome,
} from '../domain/taskTemplateRepository'
import type {
  RecurrenceLedgerEntry,
  RecurrencePreviewResult,
  RecurrenceRule,
  RecurrenceRuleInput,
} from '../domain/recurrence'
import type { TaskTemplate, TaskTemplateInput } from '../domain/taskTemplate'
import type { Course, CourseDraft, Schedule, ScheduleDraft, Task, TaskDraft, TaskStatus } from '../domain/types'

export interface AppData {
  tasks: Task[]
  courses: Course[]
  schedules: Schedule[]
  /** taskId → 原始通知/原始文本。 */
  originalTexts: Map<number, string>
  /** 模板库快照（来自版本化设置键；损坏时为空并带 `templateStoreError`）。 */
  templates: TaskTemplate[]
  /** 重复任务规则快照。 */
  recurrenceRules: RecurrenceRule[]
  /** 重复任务生成账本快照（用于预览“已创建 / 已删除 / 可创建”）。 */
  recurrenceLedger: RecurrenceLedgerEntry[]
  /** 持久化的下一规则 ID；新规则预览把它纳入一次性确认令牌。 */
  recurrenceNextRuleId: number
  /** 模板 / 规则键损坏时的可读原因；界面显示它，而不是假装“没有模板”。 */
  templateStoreError: string | null
}

const EMPTY_DATA: AppData = {
  tasks: [],
  courses: [],
  schedules: [],
  originalTexts: new Map(),
  templates: [],
  recurrenceRules: [],
  recurrenceLedger: [],
  recurrenceNextRuleId: 1,
  templateStoreError: null,
}

/** 提醒服务只需要任务的只读快照；不把整个 Task 类型带进领域服务。 */
function toReminderTask(task: Task): ReminderTaskLike {
  return { id: task.id, title: task.title, deadline: task.deadline, status: task.status }
}

export type StoreStatus = 'loading' | 'ready' | 'error'

export interface CourseReferenceCounts {
  taskCount: number
  scheduleCount: number
}

export interface CalibrationSaveResult {
  ok: boolean
  reason?: string
  calibration: TeachingWeekCalibration | null
}

/** OCR 伴侣服务地址的探测结果（设置页 / 一拍即配共用）。 */
export interface OcrProbeResult {
  ok: boolean
  endpoint: string | null
  message: string
  service?: string
  version?: string
}

/** 默认伴侣端口：与 `companion/src/server.mjs` 的 DEFAULT_PORT 一致（后端 8080 / Metro 8081 都错开）。 */
export const DEFAULT_COMPANION_PORT = 8082

/**
 * 「每日学习参考用时」的保存结果。
 *
 * 与任务保存一样，**必须把「写进去了」和「写完之后快照没刷新出来」分开**：
 * 设置项的写入本身就是它自己的提交证据，因此写成功即 `committed: true`；
 * 随后的快照刷新失败只体现为 `refreshError`，界面据此提示「已保存，列表刷新失败」，
 * 而**不是**「保存失败」——后者会让用户再点一次保存。
 */
export interface StudyReferenceSaveResult {
  ok: boolean
  /** 写入是否已经提交（`false` 表示输入不合法 / 没有改动 / 队列不可用，一个字节都没写）。 */
  committed: boolean
  /** 提交后的生效值（分钟）；`null` = 未设置。 */
  minutes: number | null
  /** 输入被拒绝时的原因（中文，可直接展示）。 */
  reason: string | null
  /** 写入已提交但随后的读快照失败时，这里带真实错误信息。 */
  refreshError: string | null
}

/** 今日学习计划的读写接口（界面只通过这里碰计划数据）。 */
export interface TodayPlanStoreValue {
  /**
   * 读今天的计划（`date` 用上海自然日）。**只读，不进写队列**。
   *
   * `ok: false` 表示库里那条 JSON 读不出来（格式 / 版本不认识）；
   * 界面要如实展示这个原因，而不是假装「今天还没有计划」。
   */
  loadTodayPlan: (date: string) => Promise<TodayPlanLoadResult>
  /**
   * 采用并保存今天的计划。
   *
   * **复用 store 的公共串行写队列**（与任务 / 课程 / 设置同一条），而不是另开一条：
   * 同一条队列才能保证「重算 → 写 → 刷新」不会与别的写入交错。
   * 计划块由仓库在事务里用**刚读到的**任务 / 课表 / 课程重新算，
   * 调用方给不了、也不该给块。
   */
  saveTodayPlan: (input: SaveTodayPlanInput) => Promise<SaveTodayPlanResult>
}

/**
 * 任务步骤清单的读写接口（界面只通过这里碰步骤数据）。
 *
 * 与今日计划同一套写法：**只有用户显式点「保存步骤」才会写库**，
 * 添加 / 编辑 / 勾选 / 删除步骤全程零写入。
 */
export interface TaskStepsStoreValue {
  /**
   * 读某条任务的步骤清单。**只读，不进写队列**，也不建表、不写任何东西。
   *
   * `ok: false` 表示库里那条 JSON 读不出来（格式 / 版本不认识）——
   * 界面要如实展示这个原因，而不是假装「还没有添加步骤」。
   */
  loadSteps: (taskId: number) => Promise<TaskStepsLoadResult>
  /**
   * 保存整份步骤清单（**唯一会写库的入口**）。
   *
   * 走 store 的**公共串行写队列**（与任务 / 课程 / 设置 / 今日计划同一条），
   * 仓库内部自己开一个事务：写之前会在同一个事务里重读版本、确认父任务还在，
   * 因此「打开页面之后任务被删掉」不会写出一条孤儿清单。
   *
   * 提交结论由 `committed` 决定：随后的刷新失败不改写它。
   */
  saveSteps: (input: SaveTaskStepsInput) => Promise<SaveTaskStepsResult>
}

/**
 * 任务原图的读写接口。
 *
 * 读取只走 SELECT（不进写队列）；**只有用户明确点「添加 / 解除关联」**才会写库，
 * 写入复用 store 已有的公共串行写队列，不另开队列。
 */
export interface TaskPhotosStoreValue {
  /** 读这条任务当前关联的原图（只读）。 */
  listPhotos: (taskId: number) => Promise<TaskPhotosSnapshot>
  /** 读最近保存、还没有手动关联到这条任务的原图（只读，最多 300 张）。 */
  listAddable: (taskId: number, limit?: number) => Promise<TaskPhotoCandidatesSnapshot>
  /**
   * 显式添加一条任务原图关联。
   *
   * 仓库在事务里重新确认任务 / 原图 / 归档文件都还在；重复添加是幂等的。
   * `refreshError` 只描述提交之后的全量快照刷新是否失败，**不改写 `committed`**。
   */
  attachPhoto: (taskId: number, attemptId: number) => Promise<AttachTaskPhotoStoreOutcome>
  /**
   * 显式解除这条任务与本张原图的手动关联。
   *
   * 只删除本模块的 `MANUAL_TASK_PHOTO` 引用；原图、OCR 结果和其它关联全部保留。
   */
  detachPhoto: (taskId: number, attemptId: number) => Promise<DetachTaskPhotoStoreOutcome>
}

export type AttachTaskPhotoStoreOutcome = AttachTaskPhotoOutcome & { refreshError: string | null }
export type DetachTaskPhotoStoreOutcome = DetachTaskPhotoOutcome & { refreshError: string | null }

/**
 * 任务截止提醒（本机通知）。
 *
 * 界面只通过这里读写：读取只走 SELECT；保存 / 测试 / 重试都交给中央串行服务，
 * 由它按**最新 DB 状态**对账，并把「规则已保存」与「系统真的排好」分开返回。
 */
export interface TaskReminderStoreValue {
  inspect: (taskId: number) => Promise<TaskReminderInspection>
  save: (input: SaveTaskReminderInput) => Promise<SaveTaskReminderServiceOutcome>
  test: (taskId: number) => Promise<TestReminderOutcome>
  retry: (taskId: number) => Promise<{ inspection: TaskReminderInspection; reason: string | null }>
  /** 启动 / 回到前台 / 手动检查时对账一次；不会弹权限。 */
  reconcile: (reason: string) => Promise<TaskReminderReconcileReport>
  getSnapshot: () => TaskReminderServiceSnapshot
  subscribe: (listener: () => void) => () => void
}

/**
 * 从 Expo/Metro 的 manifest 里取「这台电脑在局域网里的地址」。
 *
 * 不同 SDK 的字段名不一样，所以三个都兜一下；拿不到就返回 `null`，
 * 由界面提示用户手填 —— 代码里**不写死任何 IP**。
 */
export function readMetroHostUri(): string | null {
  try {
    const manifest = Constants.expoConfig as unknown as { hostUri?: string; debuggerHost?: string } | null
    const legacy = Constants.manifest2 as unknown as {
      extra?: { expoGo?: { debuggerHost?: string } }
    } | null
    return manifest?.hostUri ?? manifest?.debuggerHost ?? legacy?.extra?.expoGo?.debuggerHost ?? null
  } catch {
    return null
  }
}

/** 由 Metro 主机名推断伴侣服务地址；推断不出来返回 `null`。 */
export function inferCompanionEndpoint(hostUri: string | null = readMetroHostUri()): string | null {
  return endpointFromHostUri(hostUri, DEFAULT_COMPANION_PORT)
}

/**
 * 读一张本机图片的**原始字节**（base64）。
 *
 * 走 `expo-file-system/legacy`（Expo Go 自带模块），动态 import：
 * node 测试里不会碰到原生模块，真机上直接可用。
 *
 * 为什么是「原始字节」：归档必须是**用户提交的那张图本身**，
 * 不是压缩 / 缩放之后的副本（那正是授权范围里点名要避免的）。
 */
async function readSourceBase64(uri: string): Promise<string> {
  const FileSystem = (await import('expo-file-system/legacy')) as unknown as {
    readAsStringAsync: (uri: string, options?: { encoding?: string }) => Promise<string>
  }
  return FileSystem.readAsStringAsync(uri, { encoding: 'base64' })
}

/** 真机上可用的文件系统实现（同样只在原生运行时动态 import）。 */
async function loadNativeFileSystem(): Promise<ScreenshotFileSystem> {
  return (await import('expo-file-system/legacy')) as unknown as ScreenshotFileSystem
}

/** 从数据库**只读**重查一条任务；失败时绝不把「读不到」说成「已删除」。 */
export type TaskFreshLookup =
  | { ok: true; task: Task | null; reason: null }
  | { ok: false; task: null; reason: string }

/** 通知点击回执的窄接口：界面 / 路由只能读已消费状态、写一条消费回执。 */
export interface NotificationReceiptsStore {
  hasConsumed: (token: string) => Promise<NotificationReceiptConsumption>
  recordConsumption: (receipt: TaskReminderNotificationReceipt) => Promise<NotificationReceiptRecordResult>
}

/** 备份 / 恢复期间的全局闸门：任何写入 / 导入 / 恢复都不能与另一个备份动作重叠。 */
export type BackupGate = BackupGateState

export interface BackupExportOutcome {
  kind: 'ok' | 'canceled' | 'busy' | 'error'
  result: BackupExportResult | null
  reason: string | null
}

export interface BackupPreviewOutcome {
  kind: 'ok' | 'canceled' | 'busy' | 'error'
  preview: BackupPreviewSummary | null
  reason: string | null
}

export interface BackupLibraryListOutcome {
  entries: BackupLibraryEntry[]
  reason: string | null
}

export interface BackupContentViewOutcome {
  kind: 'ok' | 'busy' | 'error'
  view: BackupContentView | null
  reason: string | null
}

export interface BackupRestoreOutcome {
  kind: 'committed' | 'failed' | 'busy'
  result: BackupRestoreSuccess | null
  code: string | null
  reason: string | null
  recoveryBackup: RecoveryBackupInfo | null
  refreshError: string | null
  notificationWarning: string | null
  cleanupWarning: string | null
  navigationResetFailed: boolean
}

export interface BackupFileSaveOutcome {
  kind: 'ok' | 'canceled' | 'busy' | 'error'
  fileName: string | null
  byteLength: number | null
  reason: string | null
}

/**
 * 「只导入截图」的结果：**不是**恢复。
 *
 * `committed` 只表示截图库写入事务已经提交；随后的全量快照刷新失败只放进
 * `refreshError`，绝不改写成「导入失败」，也绝不引导用户重复点（重复导入按字节幂等）。
 */
export interface BackupImageImportOutcome {
  kind: 'committed' | 'busy' | 'error'
  result: ScreenshotImageImportOutcome | null
  reason: string | null
  refreshError: string | null
}

/** 旧截图绝对路径的检查 / 修复结果（只改路径，不删记录、不改字节）。 */
export interface ScreenshotPathRepairOutcome {
  ok: boolean
  report: ScreenshotPathRepairReport | null
  reason: string | null
}

/** 最近一次**已提交**的恢复结果；恢复失败只留在恢复页，不会生成这个横幅。 */
export interface BackupLastRestore {
  at: string
  result: BackupRestoreSuccess
  refreshError: string | null
  notificationWarning: string | null
  /** 根导航没有确认重建；闸门保持关闭，提供「重试界面重置」。 */
  navigationResetFailed: boolean
}

/**
 * 备份 / 恢复入口。
 *
 * 所有方法都在同一个 AppStore 串行队列 + 全局闸门下执行；界面只拿这几个
 * 「有明确 kind」的结果，不直接碰文件系统或 SQLite。
 */
export interface BackupStoreValue {
  gate: BackupGate
  exportToFiles: () => Promise<BackupExportOutcome>
  /** 创建一份本机快照；不打开系统目录选择器。 */
  createLocalBackup: () => Promise<BackupExportOutcome>
  /** 直接预览本会话最近一次**成功写出**的备份；不打开文件选择器。 */
  previewLatestExport: () => Promise<BackupPreviewOutcome>
  pickPreview: () => Promise<BackupPreviewOutcome>
  /** 把已校验的预览暂存文件原子地保留进本机备份库。 */
  retainPreviewInLibrary: (preview: BackupPreviewSummary) => Promise<BackupExportOutcome>
  listLibrary: () => Promise<BackupLibraryListOutcome>
  /** 通过严格 stage/fingerprint 管线预览本机权威文件（恢复入口，不经过选择器）。 */
  previewLibraryEntry: (entry: BackupLibraryEntry) => Promise<BackupPreviewOutcome>
  openContentView: (entry: BackupLibraryEntry) => Promise<BackupContentViewOutcome>
  closeContentView: (expectedViewDir?: string) => Promise<void>
  retainContentView: (viewDir: string) => void
  releaseContentView: (viewDir: string) => void
  saveLibraryEntryToFiles: (entry: BackupLibraryEntry) => Promise<BackupFileSaveOutcome>
  restore: (preview: BackupPreviewSummary) => Promise<BackupRestoreOutcome>
  discardPreview: (preview: BackupPreviewSummary) => Promise<void>
  /**
   * 从**已校验的备份预览**只导入图片字节与截图库记录。
   *
   * 不会恢复 / 替换任务、课程、课表、设置或旧关联；重复导入按校验过的字节幂等。
   */
  importImagesFromPreview: (preview: BackupPreviewSummary) => Promise<BackupImageImportOutcome>
  /** 从**只读内容视图**只导入截图（同样不碰任务 / 课程）。 */
  importImagesFromContentView: (view: BackupContentView) => Promise<BackupImageImportOutcome>
  listRecovery: () => Promise<RecoveryBackupFile[]>
  saveRecoveryToFiles: (fileName: string) => Promise<BackupFileSaveOutcome>
  /** 恢复后若旧通知没能完全取消：保持暂停并允许用户重试。 */
  retryNotificationCleanup: () => Promise<{ ok: boolean; reason: string | null }>
  /** 根导航重建没有确认时重试；成功后刷新并释放写入闸门。 */
  retryNavigationReset: () => Promise<{ ok: boolean; reason: string | null }>
}

export interface TemplateSaveOutcome {
  committed: true
  template: TaskTemplate
  /** 已提交但随后列表刷新失败时的真实原因；界面应提示“已保存，只需刷新”。 */
  refreshError: string | null
}

export interface TemplateApplyOutcome {
  ok: boolean
  draft: TaskDraft | null
  warnings: string[]
  reason: string | null
}

export interface RecurrenceGenerateStoreOutcome extends GenerateRecurrenceOutcome {
  refreshError: string | null
}

/**
 * 模板与重复任务入口。
 *
 * 写入全部复用 store 的公共串行队列与备份闸门；预览是**只读**的，
 * 真正的权威校验在生成事务内部完成（旧预览会被明确拒绝）。
 */
export interface TaskTemplateStoreValue {
  /** 把仍然存在的任务保存为模板（任务已被删除时拒绝）。 */
  saveFromTask: (taskId: number, input: TaskTemplateInput) => Promise<TemplateSaveOutcome>
  create: (input: TaskTemplateInput) => Promise<TemplateSaveOutcome>
  update: (id: number, input: TaskTemplateInput) => Promise<TemplateSaveOutcome>
  remove: (id: number) => Promise<void>
  /** 应用模板 → 可编辑草稿（不写任务表）。 */
  apply: (templateId: number) => Promise<TemplateApplyOutcome>
  /** 用当前内存快照计算预览；生成时仓库会在事务内重新校验指纹。 */
  preview: (input: RecurrenceRuleInput, ruleId?: number | null) => RecurrencePreviewResult
  /** 按用户已确认的预览批量创建；规则 / 任务 / 账本单事务。 */
  generate: (
    input: RecurrenceRuleInput,
    options: { ruleId: number | null; expectedFingerprint: string },
  ) => Promise<RecurrenceGenerateStoreOutcome>
  /** 删除规则与它的账本；已创建任务全部保留。 */
  removeRule: (id: number) => Promise<void>
}

export interface AppStoreValue {
  readSearchTarget: (input: { owner: import('../domain/globalSearch').SearchOwner; generation: number }) => Promise<boolean>
  applyTaskBatch: (input: import('../domain/taskBatch').TaskBatchRequest) => Promise<import('../domain/taskBatch').TaskBatchResult & { warning: string | null }>
  weeklyGoal: {
    load: () => Promise<{ goals: import('../domain/weeklyGoal').WeeklyGoals; focus: import('../domain/focusTime').FocusStore; generation: number }>
    save: (revision: number, generation: number, week: string, minutes: number | null) => Promise<import('../domain/weeklyGoal').WeeklyGoals>
  }
  focusTime: {
    getReminder: () => FocusReminderService | null
    load: () => Promise<import('../domain/focusTime').FocusStore & { generation: number }>
    act: (revision: number, generation: number, action: import('../domain/focusTime').FocusAction) => Promise<import('../domain/focusTime').FocusStore & { generation: number; reminder?: FocusReminderSnapshot }>
  }
  importExamPhoto: (input: ExamPhotoImportRequest) => Promise<ExamPhotoImportResult & { refreshError: string | null }>
  examRevision: {
    load: () => Promise<ExamRevisionStore & { generation: number }>
    create: (input: { examId: number; planId: number; draft: RevisionInput; fingerprint: string; generation: number }) => Promise<Awaited<ReturnType<ExamRevisionRepository['create']>> & { refreshError: string | null }>
  }
  status: StoreStatus
  /** 数据库引导失败的原因（与读取刷新无关）。 */
  error: string | null
  /** 读取快照失败的原因；保存成功后刷新失败会落在这里，而不是 `error`。 */
  refreshError: string | null
  /** 迁移后的 schema 版本。 */
  schemaVersion: number | null
  data: AppData
  /** 全局教学周校准；`null` 表示还没有设置过。 */
  calibration: TeachingWeekCalibration | null
  /** 今天的北京时间自然日（每次刷新时更新）。 */
  today: string
  /**
   * 每日学习参考用时（分钟）；`null` = 用户还没有设置。
   *
   * **默认就是未设置**：应用不会替用户编一个参考值，也绝不会因为「打开压力分析页」
   * 而自动写库（只有用户在设置区明确点保存才会写）。
   */
  studyReferenceMinutes: number | null
  /** 保存每日学习参考用时（空串 / `null` = 清除）。写入走公共串行队列。 */
  saveStudyReferenceMinutes: (raw: string | number | null) => Promise<StudyReferenceSaveResult>
  /**
   * 今日学习计划（原生「今天学什么」）。
   *
   * 与参考用时同一套写法：**只有用户显式点「采用并保存」才会写库**，
   * 生成预览、改时段、勾任务全程零写入。
   */
  todayPlan: TodayPlanStoreValue
  /**
   * 任务步骤清单（原生「把这条任务拆成几步」）。
   *
   * 与今日计划同一套写法：**只有用户显式点「保存步骤」才会写库**，
   * 添加 / 编辑 / 勾选 / 删除步骤全程零写入；全部步骤做完也不会改父任务的状态。
   */
  taskSteps: TaskStepsStoreValue
  /**
   * 任务原图：把截图库里已经归档的原图显式关联到任务。
   *
   * 读取只走 SELECT；添加 / 解除关联都走公共串行写队列，仓库内部自己开事务。
   */
  taskPhotos: TaskPhotosStoreValue
  /** 任务截止提醒：本机通知设置 + 系统实际排队状态。 */
  taskReminder: TaskReminderStoreValue
  getClassReminder: () => ClassReminderService | null
  /** 任务模板与重复任务（模板库 / 规则 / 生成账本都在版本化设置键里）。 */
  taskTemplates: TaskTemplateStoreValue
  /** 模板 / 规则存储键损坏时的可读原因（正常为 `null`）。 */
  templateStoreError: string | null
  /** 数据备份与恢复（导出 / 预览 / 替换式恢复）。 */
  backup: BackupStoreValue
  /** 本会话最近一次成功导出的文件元数据；不持久化，强制关闭后不保留。 */
  latestBackupExport: BackupExportResult | null
  /** 当前打开的只读备份内容视图；内容来自文件，不是 Live DB。 */
  backupContentView: BackupContentView | null
  /** 当前本机通知路由代次；通知点击在导航前用它拒绝恢复前的旧载荷。 */
  notificationRouteGeneration: number
  /** 同步读取最新代次（供通知 router 在 await 之后复查）。 */
  getNotificationRouteGeneration: () => number
  /** 最近一次已提交的恢复结果（用于恢复后首页横幅）。 */
  backupLastRestore: BackupLastRestore | null
  dismissBackupLastRestore: () => void
  /** 已提交恢复后递增；用于通知 controller 清 pending。 */
  restoreEpoch: number
  /** 根 NavigationContainer 的 remount key；变化会真正卸载旧页面。 */
  navigationRemountKey: number
  /** 根导航完成重建后调用，必须带上实际就绪的 remount key。 */
  acknowledgeRestoreNavigationReset: (appliedKey: number) => void
  refresh: () => Promise<void>
  /**
   * 只读、串行化地重查一条任务（通知点击用）。
   *
   * 与内存快照分开：快照里没有**不能证明**任务已删除；只有这里明确返回 `task: null`
   * 才是「真的不在了」。读失败返回 `ok:false`，界面必须显示可重试，不得当删除。
   * 查到后把最新全量快照放进内存，保证随后打开的详情页不是旧数据。
   */
  getTaskFresh: (taskId: number) => Promise<TaskFreshLookup>
  /** 通知点击回执：不新增表，复用 `app_settings`；有界、可跨重启。 */
  notificationReceipts: NotificationReceiptsStore
  retryBootstrap: () => Promise<void>
  createTask: (draft: TaskDraft) => Promise<SaveOutcome>
  updateTask: (id: number, draft: TaskDraft) => Promise<SaveOutcome>
  /** 在已有原文之后追加一段新文本（不覆盖旧原文）。 */
  appendTaskOriginalText: (id: number, text: string) => Promise<void>
  changeTaskStatus: (id: number, status: TaskStatus) => Promise<Task>
  toggleTaskComplete: (id: number) => Promise<Task>
  deleteTask: (id: number) => Promise<void>
  createCourse: (draft: CourseDraft) => Promise<Course>
  updateCourse: (id: number, draft: CourseDraft) => Promise<Course>
  deleteCourse: (
    id: number,
    options?: { confirmed?: boolean },
  ) => Promise<{ detachedTasks: number; removedSchedules: number }>
  countCourseReferences: (id: number) => Promise<CourseReferenceCounts>
  createSchedule: (courseId: number, draft: ScheduleDraft) => Promise<Schedule>
  updateSchedule: (scheduleId: number, draft: ScheduleDraft) => Promise<Schedule>
  /** 多天课表一次性保存（单事务；精确更新既有行 + 新增其它天/其它时段）。 */
  applyScheduleBatch: (courseId: number, change: ScheduleBatchChange) => Promise<ScheduleBatchOutcome>
  deleteSchedule: (scheduleId: number) => Promise<void>
  /** 保存教学周校准（只影响之后的表单，不动既有课表）。 */
  saveCalibration: (currentWeek: number | string) => Promise<CalibrationSaveResult>
  clearCalibration: () => Promise<void>
  /** 照片导入：整批课程 + 课表一次性写入本机 SQLite。 */
  importSchedules: (request: ScheduleImportRequest) => Promise<ScheduleImportOutcome>
  /**
   * 通知原文转待办：整批任务 + 它们的原文一次性写入本机 SQLite。
   *
   * 只在用户点「保存」时调用；解析与勾选全程零写入。
   */
  importNoticeCandidates: (request: NoticeImportRequest) => Promise<NoticeImportOutcome>
  /** 照片识别服务地址（本机设置；没设置时为 `null`）。 */
  ocrEndpoint: string | null
  /** 由 Expo/Metro 主机名**推断**出来的地址（没设置时可以直接用；不写死 IP）。 */
  inferredOcrEndpoint: string | null
  /** 保存识别服务地址；传 `null` / 空串表示清除。 */
  saveOcrEndpoint: (endpoint: string | null) => Promise<void>
  /** 真的发一次 `GET /v1/health`，用于「测试连接」与「检测并保存推断地址」。 */
  checkOcrEndpoint: (endpoint: string) => Promise<OcrProbeResult>
  /** 用推断出来的地址做健康检查，能连上就顺手保存（不能连上绝不写脏地址）。 */
  autoConfigureOcrEndpoint: () => Promise<OcrProbeResult>
  courseById: (id: number | null | undefined) => Course | null
  /* ------------------------------ 截图库（v3） ------------------------------ */
  /** 只读视图：列表 / 关联 / 识别结果。所有写入都走下面的显式动作。 */
  screenshotLibrary: ScreenshotLibraryReader
  /**
   * 检查旧截图绝对路径，并把**校验通过**的记录安全地指到当前应用目录。
   *
   * 只更新 `archived_path`；缺失 / 不匹配的记录原样保留，返回报告供界面说明。
   * 启动时会自动跑一次，也可以由用户手动重试。
   */
  repairScreenshotPaths: () => Promise<ScreenshotPathRepairOutcome>
  /** 最近一次路径检查 / 修复结果（启动自动跑或手动触发）。 */
  screenshotPathRepair: ScreenshotPathRepairOutcome | null
  /**
   * **识别之前**把原图归档进软件并登记一次尝试。
   *
   * 这是「所有截图都要留在软件里」这条要求的落点：失败也不阻断识别，
   * 只把原因交给界面如实说明。
   */
  archiveOriginal: (
    uri: string,
    source: { width?: number | null; height?: number | null; mimeType?: string | null } | undefined,
    attemptSource: ScreenshotAttemptSource,
  ) => Promise<{
    ok: boolean
    attemptId: number | null
    message: string | null
    /** 归档成功后的本机 URI（供批量页的查看器直接显示这一份字节）。 */
    archivedUri?: string | null
  }>
  /** 把一次识别结果（成功 / 失败 / 取消）登记进截图库。 */
  recordScreenshotResult: (input: {
    attemptId: number | null
    status: 'SUCCESS' | 'FAILED' | 'CANCELLED'
    response?: OcrResponse
    rawText?: string
    /**
     * 非课表路由（截图转待办的通知 OCR）用的真实元数据。
     *
     * 这些字段**不会**被塞进 `layout / week / candidates / payload`：通知文字不是课表候选，
     * 不能让截图库看起来像做过一次课表解析。
     */
    requestId?: string | null
    warnings?: readonly string[] | null
    durationMs?: number | null
    image?: { width?: number | null; height?: number | null; format?: string | null; bytes?: number | null } | null
    errorCode?: string | null
    errorMessage?: string | null
    candidates?: readonly {
      name?: string | null
      weekday?: number | null
      startTime?: string | null
      endTime?: string | null
      startWeek?: number | null
      endWeek?: number | null
      weekPattern?: string | null
      location?: string | null
      courseCode?: string | null
      rawText?: string | null
      warnings?: string[]
    }[]
  }) => Promise<void>
  /** 读回一张已归档截图的 base64（重新识别用）。 */
  readArchivedPhoto: (uri: string) => Promise<string>
  /**
   * 截图库的「重新识别」在**归档那一步**要登记的新尝试。
   *
   * 同一份字节再登记一次（新 id + 去重关联），因此：
   * - 历史是「多了一次识别尝试」，不是「改写了原来那条结果」；
   * - 字节仍然只存一份（内容寻址）。
   */
  rerunArchiveOriginal: (
    target: { archivedPath: string | null; sha256: string | null; byteLength: number | null; width: number | null; height: number | null; format: string | null; mimeType: string | null } | null,
  ) => Promise<{ ok: boolean; attemptId: number | null; message: string | null }>
  /** 历史已知来源（电脑上保留下来的那几张），供同 Wi-Fi 显式恢复。 */
  knownSources: readonly KnownSourceEntry[]
  /**
   * 从电脑上的归档目录读取**元数据**（不含图片字节）。
   *
   * 界面优先用这份数据展示标题 / 说明，而不是把「哪张图上有体育」这类事实
   * 永久固化在 App 常量里；拿不到时退回本机目录，界面照旧可用。
   */
  fetchArchiveMetadata: () => Promise<CompanionArchiveFetchResult>
  /**
   * 把一个历史来源取回本机截图库：下载 → 校验 SHA256 → 落盘 → 登记 → 建立来源关联。
   *
   * 只有用户点「恢复这一张」时才调用；任何一步失败都不写半条记录。
   */
  restoreKnownSource: (catalogKey: string) => Promise<{ ok: boolean; attemptId: number | null; message: string }>
  /** 把目录里的历史来源登记进本机（幂等；App 启动后自动跑一次）。 */
  syncKnownSources: () => Promise<void>
}

const StoreContext = createContext<AppStoreValue | null>(null)

interface Repositories {
  db: AppDatabase['db']
  tasks: TaskRepository
  courses: CourseRepository
  settings: AppSettingsRepository
  imports: ScheduleImportRepository
  /** 通知原文 → 待办：自带事务的批量仓库（与照片导入同一种写法）。 */
  noticeImports: NoticeImportRepository
  screenshots: ScreenshotLibraryRepository
  taskPhotos: TaskPhotoRepository
  /** 模板 + 重复任务规则 / 账本（复用 app_settings 的版本化 JSON 键）。 */
  taskTemplates: TaskTemplateRepository
}
/**
 * 截图库的**只读**视图接口。
 *
 * 故意不把整个仓库交给界面：界面只能查，所有写入都必须经过 store 的串行队列
 * （或者归档那一条独立队列），这样就不会出现「界面直接写库、队列外并发」的竞态。
 */
export interface ScreenshotLibraryReader {
  listAttempts: (limit?: number) => Promise<ScreenshotAttempt[]>
  /** 只读按 id 取一条尝试：批量页用它解析归档后真正落盘的 `archivedPath`。 */
  getAttempt: (attemptId: number) => Promise<ScreenshotAttempt | null>
  listViewableAttempts: (limit?: number) => Promise<ScreenshotAttempt[]>
  listSources: () => Promise<SourceScreenshot[]>
  listAttemptsLinkedTo: (targetKind: ScreenshotRefTargetKind, targetId: number) => Promise<ScreenshotAttempt[]>
  getOcrResultByAttempt: (attemptId: number) => Promise<OcrResult | null>
  countAttemptsWithFile: () => Promise<number>
  getSourceByKey: (catalogKey: string) => Promise<SourceScreenshot | null>
  countRefsTo: (targetKind: ScreenshotRefTargetKind, targetId: number) => Promise<number>
}

export function AppStoreProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [status, setStatus] = useState<StoreStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [schemaVersion, setSchemaVersion] = useState<number | null>(null)
  const [backupGate, setBackupGate] = useState<BackupGate>('idle')
  const backupGateRef = useRef(new BackupOperationGate())
  const [backupLastRestore, setBackupLastRestore] = useState<BackupLastRestore | null>(null)
  const [latestBackupExport, setLatestBackupExport] = useState<BackupExportResult | null>(null)
  const latestBackupExportRef = useRef<BackupExportResult | null>(null)
  const [backupContentView, setBackupContentView] = useState<BackupContentView | null>(null)
  const backupContentViewRef = useRef<BackupContentView | null>(null)
  const contentViewLeasesRef = useRef(new BackupContentViewLeases())
  const [screenshotPathRepair, setScreenshotPathRepair] = useState<ScreenshotPathRepairOutcome | null>(null)
  const [restoreEpoch, setRestoreEpoch] = useState(0)
  const [navigationRemountKey, setNavigationRemountKey] = useState(0)
  const navigationRemountKeyRef = useRef(0)
  const restoreAckRef = useRef<{
    expectedKey: number
    resolve: () => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  /** 每次刷新 / 恢复递增；旧刷新回来时不能把新数据盖回去。 */
  const snapshotTokenRef = useRef(0)
  const [data, setData] = useState<AppData>(EMPTY_DATA)
  const [calibration, setCalibration] = useState<TeachingWeekCalibration | null>(null)
  const [ocrEndpoint, setOcrEndpoint] = useState<string | null>(null)
  /** 每日学习参考用时（分钟）；`null` = 未设置。只在引导与刷新时读，不由界面隐式写入。 */
  const [studyReferenceMinutes, setStudyReferenceMinutes] = useState<number | null>(null)
  /** 本机通知路由代次（只在本机递增；恢复后 +1，旧通知点击失效）。 */
  const [notificationRouteGeneration, setNotificationRouteGeneration] = useState(0)
  const notificationRouteGenerationRef = useRef(0)
  /**
   * 最近一次读取快照失败的信息。
   *
   * 为什么要一个 ref：`refresh()` 只把错误的**异步 setState 排进队列**，
   * 保存动作紧接着读 `refreshError` 拿到的是**上一次渲染的旧值**。
   * 这里把同一份信息同步到 ref，保存结果才能如实报告「写进去了，但列表没刷新出来」。
   */
  const refreshErrorRef = useRef<string | null>(null)
  refreshErrorRef.current = refreshError
  /**
   * 最新地址的 ref：`restoreKnownSource` 等回调要用它，但**不能**把它放进依赖，
   * 否则每次保存地址都会重建整个 store value（历史上正是这类依赖导致界面抖动）。
   */
  const ocrEndpointRef = useRef<string | null>(null)
  ocrEndpointRef.current = ocrEndpoint
  const [today, setToday] = useState<string>(() => todayInBeijing())
  const repositories = useRef<Repositories | null>(null)
  /**
   * 今日计划仓库。
   *
   * 与其它仓库不同，它需要「新鲜的任务 / 课表 / 课程」来在**提交事务里**重算计划，
   * 所以这里注入一个只读闭包（`contextSourceRef`），而不是把三个仓库都塞给它。
   * 闭包放在 ref 里，`todayPlan` 这个对象因此可以保持稳定（不会每次渲染都换新引用）。
   */
  const contextSourceRef = useRef<(() => Promise<TodayPlanContext>) | null>(null)
  if (!contextSourceRef.current) {
    contextSourceRef.current = async () => {
      const repos = repositories.current
      if (!repos) {
        throw new Error('本机数据库还没有准备好，请稍后再试。')
      }
      const [tasks, schedules, courses] = await Promise.all([
        repos.tasks.listAll(),
        repos.courses.listSchedules(),
        repos.courses.listAll(),
      ])
      return { tasks, schedules, courses }
    }
  }
  const [todayPlanRepository, setTodayPlanRepository] = useState<TodayPlanRepository | null>(null)
  /**
   * 任务步骤清单仓库。
   *
   * 保存时要在**同一个事务**里确认父任务还在、删除任务时要精确清掉它那一个键，
   * 所以它拿的是与任务仓库**同一个连接 + 同一个仓库实例**。
   * 注入到 `TaskRepository` 的清理闭包也只做一件事：删 `task_steps.<id>` 这一个键。
   */
  const [taskStepsRepository, setTaskStepsRepository] = useState<TaskStepsRepository | null>(null)
  /**
   * 任务提醒的中央串行服务。
   *
   * 用 ref 而不是 state：服务本身是稳定的，界面的读写方法在 value 里通过 ref 取它，
   * 因此引导完成后不需要重建整个 store value（避免界面抖动 / 依赖漂移）。
   */
  const taskReminderServiceRef = useRef<TaskReminderService | null>(null)
  const classReminderServiceRef = useRef<ClassReminderService | null>(null)
  const focusReminderServiceRef = useRef<FocusReminderService | null>(null)
  /** 引导时创建的提醒仓库；服务在 `enqueue` 定义之后用同一个实例创建。 */
  const taskReminderRepositoryRef = useRef<TaskReminderRepository | null>(null)
  /** 通知点击回执仓库（与任务写库同一个 SQLite 连接，但写入独立串行）。 */
  const notificationReceiptsRepositoryRef = useRef<TaskReminderNotificationReceiptsRepository | null>(null)
  const mounted = useRef(true)
  /** 串行队列：保证「写入 → 刷新」不会互相穿插（任务 / 课程 / 通知导入都走这条）。 */
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  /**
   * 照片导入单独串行化：它自带事务，不能套在 `enqueue` 的「写 + 刷新」模式里。
   *
   * **通知原文转待办不另开队列**：它只有一个 `INSERT` 批次 + 刷新，正是 `enqueue` 的形态，
   * 共用公共队列才能与任务 / 课程的写入严格串行（同一个 SQLite 连接不允许重叠事务）。
   */
  const importQueue = useRef<Promise<unknown>>(Promise.resolve())

  const getNotificationRouteGeneration = useCallback((): number => notificationRouteGenerationRef.current, [])

  const rememberLatestExport = useCallback((result: BackupExportResult): void => {
    latestBackupExportRef.current = retainLastSuccessfulExport(latestBackupExportRef.current, result)
    setLatestBackupExport((previous) => retainLastSuccessfulExport(previous, result))
  }, [])

  /** 进入一个备份动作；已有动作在跑时立刻返回 false（双触 / 并发操作的第一道闸）。 */
  const beginBackup = useCallback((gate: Exclude<BackupGate, 'idle'>): boolean => {
    if (!backupGateRef.current.begin(gate)) return false
    setBackupGate(backupGateRef.current.state)
    return true
  }, [])

  const endBackup = useCallback((): void => {
    backupGateRef.current.end()
    setBackupGate(backupGateRef.current.state)
  }, [])

  /** 写入入口的守卫：备份 / 恢复 / 只导入截图 / 路径修复期间一律拒绝新的写库 / 导入动作。 */
  const assertBackupWritable = useCallback((): void => {
    if (backupGateRef.current.state !== 'idle') {
      throw new Error('正在导出、预览、恢复备份、只导入截图或修复旧图片路径，请等这一步结束再改动数据。')
    }
  }, [])

  /** 等照片导入队列 + 公共写队列都排空（调用前闸门已挡住新动作）。 */
  const waitForWriteQueues = useCallback(async (): Promise<void> => {
    await queue.current
    await importQueue.current
  }, [])

  /** 请求根 NavigationContainer 用新 key 重建，返回这次期望的 key。 */
  const requestNavigationRemount = useCallback((): number => {
    const next = navigationRemountKeyRef.current + 1
    navigationRemountKeyRef.current = next
    setNavigationRemountKey(next)
    return next
  }, [])

  /**
   * 已提交恢复后，等根导航**真的重建并 onReady** 再释放写入闸门。
   *
   * 只接受 `expectedKey` 对应的 onReady；旧容器迟到的回调不能解锁当前恢复。
   * 超时不是成功：抛错后调用方会保持闸门关闭，旧表单仍写不进来；用户可以点
   * 「重试界面重置」，或重启应用。绝不靠 2 秒后自动放行。
   */
  const waitForNavigationReset = useCallback((expectedKey: number): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      const pending = {
        expectedKey,
        resolve: (): void => resolve(),
        reject: (error: Error): void => reject(error),
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      }
      pending.timer = setTimeout(() => {
        if (restoreAckRef.current !== pending) return
        restoreAckRef.current = null
        reject(new Error('界面没有在 2 秒内完成重建；为避免旧表单写回，已保持恢复闸门关闭。'))
      }, 2000)
      const originalResolve = pending.resolve
      const originalReject = pending.reject
      pending.resolve = () => {
        clearTimeout(pending.timer)
        if (restoreAckRef.current === pending) restoreAckRef.current = null
        originalResolve()
      }
      pending.reject = (error: Error) => {
        clearTimeout(pending.timer)
        if (restoreAckRef.current === pending) restoreAckRef.current = null
        originalReject(error)
      }
      restoreAckRef.current = pending
    })
  }, [])

  const acknowledgeRestoreNavigationReset = useCallback((appliedKey: number): void => {
    const pending = restoreAckRef.current
    if (!pending || pending.expectedKey !== appliedKey) return
    pending.resolve()
  }, [])

  /**
   * 恢复被拒绝 / 失败后，从**未改变的数据库**重新安排原提醒。
   *
   * 恢复前会先取消旧 OS 通知；如果恢复没有提交，服务必须恢复并重新对账，
   * 否则用户会静默失去原本开启的提醒。对账失败要如实回传。
   */
  const recoverReminderScheduling = useCallback(async (reason: string): Promise<string | null> => {
    const service = taskReminderServiceRef.current
    if (!service) return null
    service.resumeAfterBackup()
    try {
      const report = await service.reconcile(reason)
      return report.ok ? null : (report.reason ?? '原来的提醒没有重新安排成功。')
    } catch (cause) {
      return `原来的提醒没有重新安排成功：${cause instanceof Error ? cause.message : String(cause)}`
    }
  }, [])

  const suspendReminderService = useCallback(async (reason: string): Promise<{ ok: boolean; reason: string | null }> => {
    const service = taskReminderServiceRef.current
    if (!service) return { ok: true, reason: null }
    try {
      await service.suspendForBackup(reason)
      return { ok: true, reason: null }
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [])

  /**
   * 只读 / 精确清理也排进同一条 DB 队列，但**不触发全量刷新**。
   *
   * 提醒服务对账时必须读到「轮到它执行时」的最新任务与规则；如果直接读库，
   * 可能和队列里正在提交的任务写入交错。这里只做串行化，不开事务。
   */
  const runSerializedRead = useCallback(<T,>(action: () => Promise<T>): Promise<T> => {
    const chained = queue.current.then(action, action)
    queue.current = chained.then(
      () => undefined,
      () => undefined,
    )
    return chained
  }, [])

  /**
   * 任务写库成功之后的提醒对账。
   *
   * 刻意 **不等待、不抛出**：通知 / 系统调用的失败绝不能把已经提交的任务保存
   * 说成失败。服务内部会记录可见错误，界面下次进入提醒页 / 回到前台可重试。
   */
  const afterTaskMutation = useCallback((reason: string): void => {
    const service = taskReminderServiceRef.current
    if (!service) return
    void service.notifyTaskChange(reason)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /**
   * 地址推断只自动跑一次的标记。
   *
   * 用 ref 而不是 state：它**不能**参与渲染，否则会重新触发依赖它的 effect。
   */
  const autoConfigureAttempted = useRef(false)

  const readAll = useCallback(async (repos: Repositories): Promise<AppData> => {
    const [tasks, courses, schedules, originalTexts, templateSnapshot] = await Promise.all([
      repos.tasks.listAll(),
      repos.courses.listAll(),
      repos.courses.listSchedules(),
      repos.tasks.listAllOriginalSources(),
      repos.taskTemplates.loadSnapshot(),
    ])
    return {
      tasks,
      courses,
      schedules,
      originalTexts,
      templates: templateSnapshot.templates,
      recurrenceRules: templateSnapshot.rules,
      recurrenceLedger: templateSnapshot.ledger,
      recurrenceNextRuleId: templateSnapshot.nextRuleId,
      templateStoreError: templateSnapshot.error,
    }
  }, [])

  /**
   * 只读扫描 + 单列路径更新。
   *
   * 原生文件系统只在运行时动态 import；调用方负责把它排进串行队列（手动触发时），
   * 启动时的自动检查在 `bootstrap` 里、还没有界面写入之前执行。
   */
  const repairScreenshotPathsFor = useCallback(
    async (repos: Repositories): Promise<ScreenshotPathRepairReport> => {
      const fs = await loadNativeFileSystem()
      const attempts = await repos.screenshots.listAttempts(1000)
      return repairScreenshotPathsDomain(attempts, fs, (update) =>
        repos.screenshots.rebaseArchivedPath({
          attemptId: update.attemptId,
          expectedArchivedPath: update.oldPath,
          nextArchivedPath: update.newPath,
        }),
      )
    },
    [],
  )

  const bootstrap = useCallback(async () => {
    setStatus('loading')
    setError(null)
    setRefreshError(null)
    try {
      const app: AppDatabase = await bootstrapDatabase()
      const repos: Repositories = {
        db: app.db,
        tasks: app.tasks,
        courses: app.courses,
        settings: new AppSettingsRepository(app.db),
        imports: new ScheduleImportRepository(app.db),
        noticeImports: new NoticeImportRepository(app.db),
        screenshots: app.screenshots,
        taskPhotos: app.taskPhotos,
        taskTemplates: new TaskTemplateRepository(app.db, app.tasks),
      }
      repositories.current = repos
      /**
       * 今日计划复用 `app_settings` 键值表；旧库 / 测试内存库里这张表可能还没建。
       * 这里只做一次 `CREATE TABLE IF NOT EXISTS`，不删列不改列、不动任何数据。
       */
      await repos.settings.ensureDailyPlanStorage()
      setTodayPlanRepository(new TodayPlanRepository(app.db, () => contextSourceRef.current!()))
      /**
       * 任务步骤清单复用同一张 `app_settings` 键值表（上面那次 `IF NOT EXISTS` 已经保证它存在）。
       * 先把仓库建出来，再把它「精确删一个键」的方法注入给任务仓库：
       * 删任务时步骤键会与任务行在**同一个事务**里消失。
       */
      const stepsRepository = new TaskStepsRepository(app.db, repos.tasks)
      /**
       * 任务提醒规则也存在 `app_settings` 里（键 `task_reminder.<id>`）。
       * 删除任务时必须在**同一个事务**里精确清掉步骤键和提醒键：
       * 任意一步失败都整体回滚，不会留下「任务没了、提醒规则还在」的孤儿。
       */
      const reminderRepository = new TaskReminderRepository(app.db, repos.tasks)
      app.tasks.setRemoveCleanup(async (taskId) => {
        await stepsRepository.removeStepsForTask(taskId)
        await reminderRepository.removeReminderForTask(taskId)
      })
      notificationReceiptsRepositoryRef.current = new TaskReminderNotificationReceiptsRepository(app.db)
      setTaskStepsRepository(stepsRepository)
      /**
       * 提醒仓库在这里创建并保留给 `enqueue` 定义之后的服务创建 effect：
       * 服务保存规则要走 store 的公共写队列，不能在建 `enqueue` 之前引用它。
       */
      taskReminderRepositoryRef.current = reminderRepository
      const snapshot = await readAll(repos)
      const [stored, endpoint, reference, notificationGeneration] = await Promise.all([
        repos.settings.loadTeachingWeekCalibration(),
        repos.settings.loadOcrEndpoint(),
        repos.settings.loadDailyStudyReferenceMinutes(),
        repos.settings.loadNotificationRouteGeneration(),
      ])
      notificationRouteGenerationRef.current = notificationGeneration
      // 历史已知来源只在**本机登记**（路径 + 哈希 + 说明），不下载任何字节。
      // 登记失败不影响启动：截图库还能用，只是恢复入口少几条目录。
      try {
        for (const entry of KNOWN_SOURCE_CATALOG) {
          await repos.screenshots.upsertSourceEntry(knownSourceToCatalogEntry(entry))
        }
      } catch {
        // 忽略：来源目录是可选增强，坏了不该拦住 App 启动。
      }
      /**
       * 启动时安全修复旧容器绝对路径。
       *
       * 只读取候选文件、逐条校验哈希后再改一列路径；文件不在 / 对不上就原样保留，
       * 界面会把这些记录标成「找不到原图」并给出显式恢复入口。任何失败都不影响启动。
       */
      try {
        const report = await repairScreenshotPathsFor(repos)
        if (mounted.current) setScreenshotPathRepair({ ok: true, report, reason: null })
      } catch (cause) {
        if (mounted.current) {
          setScreenshotPathRepair({
            ok: false,
            report: null,
            reason: cause instanceof Error ? cause.message : String(cause),
          })
        }
      }
      if (!mounted.current) return
      setData(snapshot)
      setCalibration(stored)
      setOcrEndpoint(endpoint)
      setStudyReferenceMinutes(reference)
      setNotificationRouteGeneration(notificationGeneration)
      setToday(todayInBeijing())
      setSchemaVersion(app.init.toVersion)
      setStatus('ready')
    } catch (cause) {
      if (!mounted.current) return
      setStatus('error')
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [readAll, repairScreenshotPathsFor])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  /**
   * 回到前台时刷新权限 + 对账（从系统设置返回也走这里）。
   * 只读权限，绝不在这里弹系统提示；脏草稿由提醒页自己保护。
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return
      const service = taskReminderServiceRef.current
      if (!service) return
      void service.reconcile('foreground').catch(() => undefined)
    })
    return () => {
      subscription.remove()
    }
  }, [])

  /**
   * 读取快照。失败时**只**设置 `refreshError`，不动 `status`/`error`：
   * 之前读写共用同一个 error 字段，一次刷新失败会被界面说成「保存失败」，
   * 用户据此重复保存就会产生重复任务。
   */
  const refresh = useCallback(async () => {
    const repos = repositories.current
    if (!repos) return
    // 只让「最后发起」的刷新写回内存：恢复提交后旧刷新晚到，绝不能把新数据盖回旧快照。
    const token = snapshotTokenRef.current + 1
    snapshotTokenRef.current = token
    try {
      const snapshot = await readAll(repos)
      const [stored, endpoint, reference, notificationGeneration] = await Promise.all([
        repos.settings.loadTeachingWeekCalibration(),
        repos.settings.loadOcrEndpoint(),
        repos.settings.loadDailyStudyReferenceMinutes(),
        repos.settings.loadNotificationRouteGeneration(),
      ])
      if (!mounted.current || token !== snapshotTokenRef.current) return
      notificationRouteGenerationRef.current = notificationGeneration
      setData(snapshot)
      setCalibration(stored)
      setOcrEndpoint(endpoint)
      setStudyReferenceMinutes(reference)
      setNotificationRouteGeneration(notificationGeneration)
      setToday(todayInBeijing())
      refreshErrorRef.current = null
      setRefreshError(null)
    } catch (cause) {
      if (!mounted.current || token !== snapshotTokenRef.current) return
      const message = cause instanceof Error ? cause.message : String(cause)
      refreshErrorRef.current = message
      setRefreshError(message)
    }
  }, [readAll])

  /**
   * 通知点击专用：**只读**地从数据库重查一条任务。
   *
   * 必须与其它写 / 读共用 `runSerializedRead`，避免读到写事务中间态；
   * 不写任务、不改任务状态。读失败返回 `ok:false`（调用方显示重试），
   * 只有明确查到 `null` 才是「任务已删除」。
   * 查到后在同一条串行槽里重读全量快照，详情页拿到的是最新任务 / 原文 / 课程。
   */
  const getTaskFresh = useCallback(
    async (taskId: number): Promise<TaskFreshLookup> => {
      const repos = repositories.current
      if (!repos) return { ok: false, task: null, reason: '本机数据库还没有准备好，请稍后重试。' }
      return runSerializedRead(async () => {
        try {
          const task = await repos.tasks.getById(taskId)
          if (!task) return { ok: true, task: null, reason: null }
          const snapshot = await readAll(repos)
          if (mounted.current) setData(snapshot)
          return { ok: true, task, reason: null }
        } catch (cause) {
          return {
            ok: false,
            task: null,
            reason: `读取任务失败：${cause instanceof Error ? cause.message : String(cause)}`,
          }
        }
      })
    },
    [readAll, runSerializedRead],
  )

  /**
   * 把任意操作排进串行队列，操作完成后统一刷新一次。
   *
   * 备份 / 恢复自己也要复用这条队列，因此只有内部动作传
   * `allowBackupGate: true`；任何界面写入 / 导入 / 提醒保存都会被闸门拒绝。
   */
  const enqueue = useCallback(
    <T,>(
      action: (repos: Repositories) => Promise<T>,
      options: { allowBackupGate?: boolean; refreshAfter?: boolean } = {},
    ): Promise<T> => {
      if (!options.allowBackupGate) assertBackupWritable()
      const run = async (): Promise<T> => {
        const repos = repositories.current
        if (!repos) throw new Error('本机数据库还没有准备好，请稍后再试。')
        const result = await action(repos)
        if (options.refreshAfter !== false) await refresh()
        return result
      }
      const chained = queue.current.then(run, run)
      // 队列自身吞掉错误，避免一次失败让后续操作全部被拒绝。
      queue.current = chained.then(
        () => undefined,
        () => undefined,
      )
      return chained
    },
    [assertBackupWritable, refresh],
  )

  /**
   * 数据库就绪后创建中央串行提醒服务。
   *
   * 放在 `enqueue` 之后：服务保存规则必须复用 store 的公共写队列；对账读取也复用
   * `runSerializedRead`，因此服务拿到的永远是「轮到它时」的最新 DB 状态。
   * 创建后立即对账一次：只读权限 / 系统排队，**不申请权限**。
   */
  useEffect(() => {
    if (status !== 'ready') return
    const repository = taskReminderRepositoryRef.current
    if (!repository) return
    const classes = createClassReminderService({
      port: createExpoTaskReminderPort(),
      read: () => runSerializedRead(async () => {
        const repos = repositories.current
        if (!repos) throw new Error('本机数据库还没有准备好。')
        return {
          settings: decodeClassReminderSettings(await repos.settings.get(CLASS_REMINDER_KEY)),
          courses: await repos.courses.listAll(), schedules: await repos.courses.listSchedules(),
          generation: await repos.settings.loadNotificationRouteGeneration(),
        }
      }),
      write: settings => enqueue(async repos => { await repos.settings.set(CLASS_REMINDER_KEY, JSON.stringify(settings)) }),
    })
    classReminderServiceRef.current = classes
    const service = createTaskReminderService({
      port: createExpoTaskReminderPort(),
      readTasks: () =>
        runSerializedRead(async () => {
          const repos = repositories.current
          if (!repos) throw new Error('本机数据库还没有准备好。')
          return (await repos.tasks.listAll()).map(toReminderTask)
        }),
      readEntries: () => runSerializedRead(() => repository.listReminders()),
      loadReminder: (taskId) => runSerializedRead(() => repository.loadReminder(taskId)),
      getTask: (taskId) =>
        runSerializedRead(async () => {
          const repos = repositories.current
          if (!repos) return null
          const task = await repos.tasks.getById(taskId)
          return task ? toReminderTask(task) : null
        }),
      saveReminder: (input) => enqueue(() => repository.saveReminder(input)),
      removeReminder: (taskId) => runSerializedRead(() => repository.removeReminderForTask(taskId)),
      getNotificationGeneration: () => notificationRouteGenerationRef.current,
    })
    const focus = createFocusReminderService({
      port: createExpoTaskReminderPort(),
      read: () => runSerializedRead(async () => {
        assertBackupWritable()
        const repos = repositories.current
        if (!repos) throw new Error('本机数据还没有准备好。')
        return { ...await loadFocus(repos.settings), generation: notificationRouteGenerationRef.current }
      }),
    })
    focusReminderServiceRef.current = focus
    taskReminderServiceRef.current = withFocusReminderLifecycle(withClassReminderLifecycle(service, classes), focus)
    void taskReminderServiceRef.current.reconcile('bootstrap').catch(() => undefined)
    return () => { void classes.suspend(); void focus.suspend() }
  }, [assertBackupWritable, enqueue, runSerializedRead, status])

  // A successful course edit/import/calibration/restore refresh re-reads authoritative DB rows.
  useEffect(() => {
    if (status === 'ready' && backupGate === 'idle') {
      void classReminderServiceRef.current?.reconcile().catch(() => undefined)
    }
  }, [data.courses, data.schedules, calibration, status, backupGate])

  /** 保存识别服务地址（空 / `null` = 清除）。 */
  const saveOcrEndpoint = useCallback(
    async (endpoint: string | null): Promise<void> => {
      assertBackupWritable()
      const run = async (): Promise<void> => {
        const repos = repositories.current
        if (!repos) throw new Error('本机数据库还没有准备好，请稍后再试。')
        await repos.settings.saveOcrEndpoint(endpoint ?? '')
        await refresh()
      }
      const chained = queue.current.then(run, run)
      queue.current = chained.then(
        () => undefined,
        () => undefined,
      )
      await chained
    },
    [assertBackupWritable, refresh],
  )

  /**
   * 真的发一次健康检查。
   *
   * 这一步是「用户选完照片却什么都没有」的另一半解药：地址没设置/设置错了，
   * 界面必须**当场**说清楚，而不是等一个两分钟的识别超时。
   */
  const checkOcrEndpoint = useCallback(async (rawEndpoint: string): Promise<OcrProbeResult> => {
    const normalized = normalizeEndpoint(rawEndpoint)
    if (!normalized) {
      return { ok: false, endpoint: null, message: '地址要写成 http://电脑IP:8082，例如 http://192.168.1.5:8082。' }
    }
    const result = await checkCompanionHealth(normalized, { timeoutMs: 6_000 })
    if (result.ok) {
      return {
        ok: true,
        endpoint: normalized,
        service: result.service,
        version: result.version,
        message: `连接成功：${normalized} 上是 ${result.service} v${result.version}。`,
      }
    }
    return { ok: false, endpoint: normalized, message: `连接失败：${result.error.message}` }
  }, [])

  /**
   * 用 Metro 主机名推断出来的地址尝试一次；**只有真的连上才保存**。
   *
   * 这样用户不需要手抄 IP，也不会因为「猜了个地址」而把错地址写进设置。
   */
  const autoConfigureOcrEndpoint = useCallback(async (): Promise<OcrProbeResult> => {
    const inferred = inferCompanionEndpoint()
    if (!inferred) {
      return {
        ok: false,
        endpoint: null,
        message: '没能在本机推断出电脑地址（可能是模拟器或 localhost）。请到「识别服务设置」手动填写。',
      }
    }
    const probe = await checkOcrEndpoint(inferred)
    if (probe.ok && probe.endpoint) {
      await saveOcrEndpoint(probe.endpoint)
    }
    return probe
  }, [checkOcrEndpoint, saveOcrEndpoint])

  /**
   * 启动后如果**没存过**识别服务地址，就用本机推断的地址试一次。
   *
   * 动机：用户实际的抱怨是「选完照片什么都没有」。其中一个原因是地址压根没设置，
   * 而识别调用要等到第一次请求才报错。这里在启动时静默补齐：
   * 只有健康检查真的通过才写入设置，失败不写、也不弹任何东西（不打扰用户）。
   */
  useEffect(() => {
    if (status !== 'ready') return
    if (ocrEndpoint) return
    if (autoConfigureAttempted.current) return
    autoConfigureAttempted.current = true
    void autoConfigureOcrEndpoint()
  }, [autoConfigureOcrEndpoint, ocrEndpoint, status])

  /* ------------------------------ 备份 / 恢复 ------------------------------ */

  const backupExportToFiles = useCallback(async (): Promise<BackupExportOutcome> => {
    if (!beginBackup('exporting')) {
      return { kind: 'busy', result: null, reason: '已有导出或恢复正在进行，请等它结束。' }
    }
    let fs: BackupFileSystem | null = null
    let suspended = false
    try {
      const repos = repositories.current
      if (!repos) return { kind: 'error', result: null, reason: '本机数据库还没有准备好，请稍后再试。' }
      fs = await createExpoBackupFileSystem()
      // 先让用户选目录；取消时完全没有暂停通知 / 写库动作。
      const picked = await fs.pickDirectory()
      if (picked.canceled) return { kind: 'canceled', result: null, reason: null }
      const suspension = await suspendReminderService('导出备份')
      if (!suspension.ok) {
        return { kind: 'error', result: null, reason: `导出前暂停提醒同步失败：${suspension.reason ?? '未知原因'}` }
      }
      suspended = true
      await waitForWriteQueues()
      const result = await enqueue(
        (current) => exportBackupToDirectory(current.db, fs as BackupFileSystem, picked.uri),
        { allowBackupGate: true, refreshAfter: false },
      )
      // 只有真正写完文件才更新；失败 / 取消保留上一条有效记录。
      rememberLatestExport(result)
      return { kind: 'ok', result, reason: null }
    } catch (cause) {
      return { kind: 'error', result: null, reason: cause instanceof Error ? cause.message : String(cause) }
    } finally {
      if (suspended) taskReminderServiceRef.current?.resumeAfterBackup()
      endBackup()
    }
  }, [beginBackup, enqueue, endBackup, rememberLatestExport, suspendReminderService, waitForWriteQueues])

  const backupCreateLocalBackup = useCallback(async (): Promise<BackupExportOutcome> => {
    if (!beginBackup('exporting')) {
      return { kind: 'busy', result: null, reason: '已有导出或恢复正在进行，请等它结束。' }
    }
    let suspended = false
    try {
      const repos = repositories.current
      if (!repos) return { kind: 'error', result: null, reason: '本机数据库还没有准备好，请稍后再试。' }
      const fs = await createExpoBackupFileSystem()
      const suspension = await suspendReminderService('创建本机备份')
      if (!suspension.ok) {
        return { kind: 'error', result: null, reason: `创建前暂停提醒同步失败：${suspension.reason ?? '未知原因'}` }
      }
      suspended = true
      await waitForWriteQueues()
      const result = await enqueue(
        (current) => createLocalBackup(current.db, fs),
        { allowBackupGate: true, refreshAfter: false },
      )
      rememberLatestExport(result)
      return { kind: 'ok', result, reason: null }
    } catch (cause) {
      return { kind: 'error', result: null, reason: cause instanceof Error ? cause.message : String(cause) }
    } finally {
      if (suspended) taskReminderServiceRef.current?.resumeAfterBackup()
      endBackup()
    }
  }, [beginBackup, enqueue, endBackup, rememberLatestExport, suspendReminderService, waitForWriteQueues])

  const backupListLibrary = useCallback(async (): Promise<BackupLibraryListOutcome> => {
    try {
      const fs = await createExpoBackupFileSystem()
      return { entries: await listBackupLibrary(fs), reason: null }
    } catch (cause) {
      return { entries: [], reason: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [])

  const backupCloseContentView = useCallback(async (expectedViewDir?: string): Promise<void> => {
    const view = backupContentViewRef.current
    if (!shouldCloseContentView(view?.viewDir ?? null, expectedViewDir)) return
    if (!view) return
    backupContentViewRef.current = null
    setBackupContentView(null)
    try {
      const fs = await createExpoBackupFileSystem()
      await closeBackupContentView(fs, view.viewDir)
    } catch {
      // 只读视图清理失败不影响备份文件本身
    }
  }, [])

  const backupRetainContentView = useCallback((viewDir: string): void => {
    contentViewLeasesRef.current.retain(viewDir)
  }, [])

  const backupReleaseContentView = useCallback(
    (viewDir: string): void => {
      // 延迟到下一轮事件循环；StrictMode 的 setup → cleanup → setup 会先重新 retain。
      contentViewLeasesRef.current.release(viewDir, (dir) => {
        void backupCloseContentView(dir)
      })
    },
    [backupCloseContentView],
  )

  const backupOpenContentView = useCallback(
    async (entry: BackupLibraryEntry): Promise<BackupContentViewOutcome> => {
      if (!beginBackup('previewing')) {
        return { kind: 'busy', view: null, reason: '已有导出或恢复正在进行，请等它结束。' }
      }
      try {
        // 切换快照前先清掉上一个只读视图，避免 view-* 暂存目录泄漏。
        await backupCloseContentView()
        const fs = await createExpoBackupFileSystem()
        const view = await openBackupContentView(fs, entry)
        backupContentViewRef.current = view
        setBackupContentView(view)
        return { kind: 'ok', view, reason: null }
      } catch (cause) {
        return { kind: 'error', view: null, reason: cause instanceof Error ? cause.message : String(cause) }
      } finally {
        endBackup()
      }
    },
    [backupCloseContentView, beginBackup, endBackup],
  )

  const backupSaveLibraryEntryToFiles = useCallback(
    async (entry: BackupLibraryEntry): Promise<BackupFileSaveOutcome> => {
      if (!beginBackup('exporting')) {
        return { kind: 'busy', fileName: null, byteLength: null, reason: '已有导出或恢复正在进行，请等它结束。' }
      }
      try {
        const fs = await createExpoBackupFileSystem()
        const picked = await fs.pickDirectory()
        if (picked.canceled) return { kind: 'canceled', fileName: null, byteLength: null, reason: null }
        const result = await saveBackupLibraryEntryToDirectory(fs, entry, picked.uri)
        return { kind: 'ok', fileName: result.fileName, byteLength: result.byteLength, reason: null }
      } catch (cause) {
        return {
          kind: 'error',
          fileName: null,
          byteLength: null,
          reason: cause instanceof Error ? cause.message : String(cause),
        }
      } finally {
        endBackup()
      }
    },
    [beginBackup, endBackup],
  )

  /**
   * 预览流程的唯一入口：暂停提醒 → 等队列 → stageBackupForPreview。
   *
   * 手动选文件和「预览刚导出的备份」都走这里，确保 stale 指纹、严格 parser、
   * 通知暂停 / 恢复、清理语义完全一致。调用方负责 gate 与 fs。
   */
  const previewBackupFromUri = useCallback(
    async (fs: BackupFileSystem, uri: string, sourceName: string): Promise<BackupPreviewOutcome> => {
      let suspended = false
      try {
        const suspension = await suspendReminderService('预览备份')
        if (!suspension.ok) {
          return { kind: 'error', preview: null, reason: `预览前暂停提醒同步失败：${suspension.reason ?? '未知原因'}` }
        }
        suspended = true
        await waitForWriteQueues()
        const preview = await enqueue(
          (current) => stageBackupForPreview(current.db, fs, uri, { sourceName }),
          { allowBackupGate: true, refreshAfter: false },
        )
        return { kind: 'ok', preview, reason: null }
      } catch (cause) {
        return { kind: 'error', preview: null, reason: cause instanceof Error ? cause.message : String(cause) }
      } finally {
        if (suspended) taskReminderServiceRef.current?.resumeAfterBackup()
      }
    },
    [enqueue, suspendReminderService, waitForWriteQueues],
  )

  const backupRetainPreviewInLibrary = useCallback(
    async (preview: BackupPreviewSummary): Promise<BackupExportOutcome> => {
      if (!beginBackup('exporting')) {
        return { kind: 'busy', result: null, reason: '已有导出或恢复正在进行，请等它结束。' }
      }
      try {
        const fs = await createExpoBackupFileSystem()
        const result = await retainBackupInLibrary(fs, preview.stagedUri)
        rememberLatestExport(result)
        return { kind: 'ok', result, reason: null }
      } catch (cause) {
        return { kind: 'error', result: null, reason: cause instanceof Error ? cause.message : String(cause) }
      } finally {
        endBackup()
      }
    },
    [beginBackup, endBackup, rememberLatestExport],
  )

  const backupPickPreview = useCallback(async (): Promise<BackupPreviewOutcome> => {
    if (!beginBackup('previewing')) {
      return { kind: 'busy', preview: null, reason: '已有导出或恢复正在进行，请等它结束。' }
    }
    try {
      const repos = repositories.current
      if (!repos) return { kind: 'error', preview: null, reason: '本机数据库还没有准备好，请稍后再试。' }
      const fs = await createExpoBackupFileSystem()
      // 手动选择器从本会话最近一次成功导出的目录开始（installed API 的 initialUri）。
      const picked = await fs.pickFile(latestBackupExportRef.current?.directoryUri)
      if (picked.canceled) return { kind: 'canceled', preview: null, reason: null }
      return await previewBackupFromUri(fs, picked.uri, picked.name)
    } catch (cause) {
      return { kind: 'error', preview: null, reason: cause instanceof Error ? cause.message : String(cause) }
    } finally {
      endBackup()
    }
  }, [beginBackup, endBackup, previewBackupFromUri])

  const backupPreviewLatestExport = useCallback(async (): Promise<BackupPreviewOutcome> => {
    if (!beginBackup('previewing')) {
      return { kind: 'busy', preview: null, reason: '已有导出或恢复正在进行，请等它结束。' }
    }
    try {
      const latest = latestBackupExportRef.current
      if (!latest) {
        return {
          kind: 'error',
          preview: null,
          reason: '这次打开应用后还没有成功导出过备份。请先导出，或用「选择备份文件并预览」手动选择。',
        }
      }
      const repos = repositories.current
      if (!repos) return { kind: 'error', preview: null, reason: '本机数据库还没有准备好，请稍后再试。' }
      const fs = await createExpoBackupFileSystem()
      const outcome = await previewBackupFromUri(fs, latest.uri, latest.fileName)
      if (outcome.kind === 'error') {
        return {
          ...outcome,
          reason: `无法读取最近导出的备份（可能已移动、删除，或系统访问权限已过期）：${outcome.reason ?? '读取失败'}。仍可用「选择备份文件并预览」手动选择。`,
        }
      }
      return outcome
    } catch (cause) {
      return {
        kind: 'error',
        preview: null,
        reason: `无法读取最近导出的备份（可能已移动、删除，或系统访问权限已过期）：${cause instanceof Error ? cause.message : String(cause)}。仍可用「选择备份文件并预览」手动选择。`,
      }
    } finally {
      endBackup()
    }
  }, [beginBackup, endBackup, previewBackupFromUri])

  /** 直接预览本机备份库 / 恢复备份里的权威文件（不需要另存 / 重新选择）。 */
  const backupPreviewLibraryEntry = useCallback(
    async (entry: BackupLibraryEntry): Promise<BackupPreviewOutcome> => {
      if (!beginBackup('previewing')) {
        return { kind: 'busy', preview: null, reason: '已有导出或恢复正在进行，请等它结束。' }
      }
      try {
        const fs = await createExpoBackupFileSystem()
        const source = await resolveBackupLibraryFile(fs, entry)
        return await previewBackupFromUri(fs, source, entry.fileName)
      } catch (cause) {
        return {
          kind: 'error',
          preview: null,
          reason: `无法读取这份本机备份：${cause instanceof Error ? cause.message : String(cause)}`,
        }
      } finally {
        endBackup()
      }
    },
    [beginBackup, endBackup, previewBackupFromUri],
  )

  const backupRestore = useCallback(
    async (preview: BackupPreviewSummary): Promise<BackupRestoreOutcome> => {
      if (!beginBackup('restoring')) {
        return {
          kind: 'busy',
          result: null,
          code: null,
          reason: '已有导出或恢复正在进行，请等它结束。',
          recoveryBackup: null,
          refreshError: null,
          notificationWarning: null,
          cleanupWarning: null,
          navigationResetFailed: false,
        }
      }
      let fs: BackupFileSystem | null = null
      let suspended = false
      let keepSuspended = false
      let keepGateClosed = false
      let committed = false
      let committedResult: BackupRestoreSuccess | null = null
      let notificationWarning: string | null = null
      let navigationResetFailed = false
      try {
        const repos = repositories.current
        if (!repos) {
          return {
            kind: 'failed',
            result: null,
            code: 'NOT_READY',
            reason: '本机数据库还没有准备好，请稍后再试。',
            recoveryBackup: null,
            refreshError: null,
            notificationWarning: null,
            cleanupWarning: null,
            navigationResetFailed: false,
          }
        }
        fs = await createExpoBackupFileSystem()
        // 过期预览 / 文件变化 / 损坏备份必须在暂停通知、取消旧提醒之前拒绝。
        const preflight = await preflightRestore(repos.db, fs, preview)
        if (!preflight.ok) {
          return {
            kind: 'failed',
            result: null,
            code: preflight.code,
            reason: preflight.reason,
            recoveryBackup: null,
            refreshError: null,
            notificationWarning: null,
            cleanupWarning: null,
            navigationResetFailed: false,
          }
        }
        const suspension = await suspendReminderService('恢复备份')
        if (!suspension.ok) {
          const recoveryError = await recoverReminderScheduling('恢复前暂停失败，恢复原提醒')
          suspended = false
          return {
            kind: 'failed',
            result: null,
            code: 'NOTIFICATION_SUSPEND_FAILED',
            reason: `恢复前无法暂停提醒同步：${suspension.reason ?? '未知原因'}${recoveryError ? `；${recoveryError}` : ''}`,
            recoveryBackup: null,
            refreshError: null,
            notificationWarning: null,
            cleanupWarning: null,
            navigationResetFailed: false,
          }
        }
        suspended = true
        const service = taskReminderServiceRef.current
        if (service) {
          const preCancel = await service.cancelAllOwnedNotifications('恢复前取消旧提醒')
          if (!preCancel.ok) {
            const recoveryError = await recoverReminderScheduling('恢复未开始，重新安排原提醒')
            suspended = false
            return {
              kind: 'failed',
              result: null,
              code: 'NOTIFICATION_CANCEL_FAILED',
              reason: `${preCancel.reason ?? '无法确认旧提醒已取消，恢复没有开始。'}${recoveryError ? `；${recoveryError}` : ''}`,
              recoveryBackup: null,
              refreshError: null,
              notificationWarning: null,
              cleanupWarning: null,
              navigationResetFailed: false,
            }
          }
        }
        await waitForWriteQueues()
        const outcome = await enqueue(
          (current) =>
            restoreStagedBackup(current.db, fs as BackupFileSystem, preview, {
              postCommit: async () => {
                // 先失效旧刷新，再请求根容器重建；只有 onReady 确认后才刷新并释放闸门。
                snapshotTokenRef.current += 1
                setRestoreEpoch((value) => value + 1)
                const expectedKey = requestNavigationRemount()
                try {
                  await waitForNavigationReset(expectedKey)
                } catch (cause) {
                  navigationResetFailed = true
                  throw cause
                }
                await refresh()
                return refreshErrorRef.current
              },
            }),
          { allowBackupGate: true, refreshAfter: false },
        )
        if (!outcome.committed) {
          // 旧 OS 提醒可能已经被取消；数据库没有变，必须按原数据重新安排。
          const recoveryError = await recoverReminderScheduling('恢复未提交，重新安排原提醒')
          suspended = false
          return {
            kind: 'failed',
            result: null,
            code: outcome.code,
            reason: recoveryError ? `${outcome.reason}；${recoveryError}` : outcome.reason,
            recoveryBackup: outcome.recoveryBackup,
            refreshError: null,
            notificationWarning: null,
            cleanupWarning: outcome.cleanupWarning,
            navigationResetFailed: false,
          }
        }
        committed = true
        committedResult = outcome
        // 代次已随恢复事务提交；先同步内存 ref，通知 router 的 await 后复查立刻生效。
        notificationRouteGenerationRef.current = outcome.notificationGeneration
        setNotificationRouteGeneration(outcome.notificationGeneration)
        if (service) {
          const postCancel = await service.cancelAllOwnedNotifications('恢复后取消旧提醒')
          if (!postCancel.ok) {
            // 数据已提交；保持提醒服务暂停，避免旧通知继续触发。用户可以点重试。
            notificationWarning = postCancel.reason ?? '恢复后未能确认旧提醒全部取消。'
            keepSuspended = true
          } else {
            service.resumeAfterBackup()
            suspended = false
          }
        } else {
          suspended = false
        }
        if (navigationResetFailed) {
          keepGateClosed = true
          const warning = '数据已经恢复，但根导航没有在限定时间内完成重建。为避免旧表单写回，写入仍被锁住；请点「重试界面重置」。'
          notificationWarning = notificationWarning ? `${notificationWarning} ${warning}` : warning
        }
        const last: BackupLastRestore = {
          at: new Date().toISOString(),
          result: outcome,
          refreshError: outcome.refreshError,
          notificationWarning,
          navigationResetFailed,
        }
        setBackupLastRestore(last)
        return {
          kind: 'committed',
          result: outcome,
          code: null,
          reason: null,
          recoveryBackup: outcome.recoveryBackup,
          refreshError: outcome.refreshError,
          notificationWarning,
          cleanupWarning: null,
          navigationResetFailed,
        }
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        if (committed && committedResult) {
          // 提交后只有收尾动作可能失败；绝不能把它说成「没有恢复」。
          const warning = `数据已经恢复，但收尾时出错：${reason}`
          if (navigationResetFailed) {
            keepGateClosed = true
          }
          setBackupLastRestore({
            at: new Date().toISOString(),
            result: committedResult,
            refreshError: committedResult.refreshError,
            notificationWarning: warning,
            navigationResetFailed,
          })
          return {
            kind: 'committed',
            result: committedResult,
            code: null,
            reason: null,
            recoveryBackup: committedResult.recoveryBackup,
            refreshError: committedResult.refreshError,
            notificationWarning: warning,
            cleanupWarning: null,
            navigationResetFailed,
          }
        }
        const recoveryError = suspended ? await recoverReminderScheduling('恢复异常，重新安排原提醒') : null
        if (suspended) suspended = false
        return {
          kind: 'failed',
          result: null,
          code: 'UNEXPECTED',
          reason: recoveryError ? `${reason}；${recoveryError}` : reason,
          recoveryBackup: null,
          refreshError: null,
          notificationWarning: null,
          cleanupWarning: null,
          navigationResetFailed: false,
        }
      } finally {
        if (suspended && !keepSuspended) taskReminderServiceRef.current?.resumeAfterBackup()
        // 导航没有确认重建时保持 restoring 闸门：旧表单仍拿不到写权限。
        if (!keepGateClosed) endBackup()
      }
    },
    [
      beginBackup,
      endBackup,
      enqueue,
      recoverReminderScheduling,
      refresh,
      requestNavigationRemount,
      suspendReminderService,
      waitForNavigationReset,
      waitForWriteQueues,
    ],
  )

  const backupDiscardPreview = useCallback(async (preview: BackupPreviewSummary): Promise<void> => {
    // 正在恢复时不能删它正在用的暂存目录；恢复失败后由 service 自己清理。
    if (backupGateRef.current.state !== 'idle') return
    try {
      const fs = await createExpoBackupFileSystem()
      await discardBackupStaging(fs, preview.stageDir)
    } catch {
      // 暂存目录清理失败不影响用户数据；下次预览会建唯一新目录。
    }
  }, [])

  /**
   * 「只导入截图」的共享实现（预览 / 只读内容视图两个入口）。
   *
   * 全程占用同一个备份闸门：导入期间其它界面写入 / 另一个备份动作都会被拒绝；
   * 文件 + SQLite 写入排在现有公共队列里，不另开队列、不嵌套事务。
   * 提交后刷新失败只进 `refreshError`，绝不改写成导入失败。
   */
  const backupImportImages = useCallback(
    async (
      source:
        | { kind: 'preview'; preview: BackupPreviewSummary }
        | { kind: 'content'; view: BackupContentView },
    ): Promise<BackupImageImportOutcome> => {
      if (!beginBackup('importing')) {
        return { kind: 'busy', result: null, reason: '已有备份 / 导入动作正在进行，请等它结束。', refreshError: null }
      }
      try {
        let fs: BackupFileSystem
        try {
          fs = await createExpoBackupFileSystem()
        } catch (cause) {
          return {
            kind: 'error',
            result: null,
            reason: `这台设备上的备份文件系统不可用：${cause instanceof Error ? cause.message : String(cause)}`,
            refreshError: null,
          }
        }
        // 闸门已经挡住新写入；等已经在队列里的写入完成后再读备份 / 写截图库。
        await waitForWriteQueues()
        let outcome: ScreenshotImageImportOutcome
        try {
          outcome = await enqueue(
            async (current) => {
              const images =
                source.kind === 'preview'
                  ? await readImagesFromStagedBackup(fs, {
                      stagedUri: source.preview.stagedUri,
                      fileByteLength: source.preview.fileByteLength,
                      backupDigest: source.preview.backupDigest,
                      counts: source.preview.counts,
                      totalImageBytes: source.preview.totalImageBytes,
                    })
                  : imagesFromBackupContentView(source.view)
              return importScreenshotImagesFromBackup({
                db: current.db,
                fs,
                repository: current.screenshots,
                images,
              })
            },
            { allowBackupGate: true, refreshAfter: false },
          )
        } catch (cause) {
          return {
            kind: 'error',
            result: null,
            reason: `只导入截图没有完成：${cause instanceof Error ? cause.message : String(cause)}`,
            refreshError: null,
          }
        }
        /**
         * 提交之后的刷新**单独处理**：刷新失败只能说明「列表没读出来」，
         * 不能把已经提交的截图库写入改写成「导入失败」。
         */
        let refreshError: string | null = null
        if (outcome.committed) {
          try {
            await refresh()
            refreshError = refreshErrorRef.current
          } catch (cause) {
            refreshError = cause instanceof Error ? cause.message : String(cause)
          }
        }
        return {
          kind: outcome.committed ? 'committed' : 'error',
          result: outcome,
          reason: outcome.committed ? null : outcome.reason,
          refreshError,
        }
      } catch (cause) {
        return {
          kind: 'error',
          result: null,
          reason: `只导入截图没有完成：${cause instanceof Error ? cause.message : String(cause)}`,
          refreshError: null,
        }
      } finally {
        endBackup()
      }
    },
    [beginBackup, endBackup, enqueue, refresh, waitForWriteQueues],
  )

  const backupImportImagesFromPreview = useCallback(
    (preview: BackupPreviewSummary): Promise<BackupImageImportOutcome> =>
      backupImportImages({ kind: 'preview', preview }),
    [backupImportImages],
  )

  const backupImportImagesFromContentView = useCallback(
    (view: BackupContentView): Promise<BackupImageImportOutcome> => backupImportImages({ kind: 'content', view }),
    [backupImportImages],
  )

  /**
   * 手动重跑旧路径检查。启动时已经自动跑过一次；用户也可以在这里重试。
   *
   * 占用 `repairing` 闸门，避免与恢复 / 导入交错；只做带条件的单列更新。
   */
  const repairScreenshotPaths = useCallback(async (): Promise<ScreenshotPathRepairOutcome> => {
    if (!repositories.current) {
      return { ok: false, report: null, reason: '本机数据库还没有准备好，请稍后再试。' }
    }
    if (!beginBackup('repairing')) {
      return { ok: false, report: null, reason: '已有备份 / 导入 / 修复动作正在进行，请等它结束。' }
    }
    try {
      let report: ScreenshotPathRepairReport
      try {
        await waitForWriteQueues()
        report = await enqueue((current) => repairScreenshotPathsFor(current), {
          allowBackupGate: true,
          refreshAfter: false,
        })
      } catch (cause) {
        const outcome: ScreenshotPathRepairOutcome = {
          ok: false,
          report: null,
          reason: `检查旧图片路径失败：${cause instanceof Error ? cause.message : String(cause)}`,
        }
        if (mounted.current) setScreenshotPathRepair(outcome)
        return outcome
      }
      // 路径修复已经提交；之后的刷新失败只说明列表没读出来，不改写修复结论。
      let refreshError: string | null = null
      if (report.repaired > 0) {
        try {
          await refresh()
          refreshError = refreshErrorRef.current
        } catch (cause) {
          refreshError = cause instanceof Error ? cause.message : String(cause)
        }
      }
      const outcome: ScreenshotPathRepairOutcome = {
        ok: true,
        report,
        reason: refreshError ? `旧图片路径已经修复，但列表刷新失败：${refreshError}` : null,
      }
      if (mounted.current) setScreenshotPathRepair(outcome)
      return outcome
    } finally {
      endBackup()
    }
  }, [beginBackup, endBackup, enqueue, refresh, repairScreenshotPathsFor, waitForWriteQueues])

  const backupListRecovery = useCallback(async (): Promise<RecoveryBackupFile[]> => {
    try {
      const fs = await createExpoBackupFileSystem()
      return await listRecoveryBackups(fs)
    } catch {
      return []
    }
  }, [])

  const backupSaveRecoveryToFiles = useCallback(
    async (fileName: string): Promise<BackupFileSaveOutcome> => {
      if (!beginBackup('exporting')) {
        return { kind: 'busy', fileName: null, byteLength: null, reason: '已有导出或恢复正在进行，请等它结束。' }
      }
      try {
        const fs = await createExpoBackupFileSystem()
        const picked = await fs.pickDirectory()
        if (picked.canceled) return { kind: 'canceled', fileName: null, byteLength: null, reason: null }
        const result = await saveRecoveryBackupToDirectory(fs, fileName, picked.uri)
        return { kind: 'ok', fileName: result.fileName, byteLength: result.byteLength, reason: null }
      } catch (cause) {
        return {
          kind: 'error',
          fileName: null,
          byteLength: null,
          reason: cause instanceof Error ? cause.message : String(cause),
        }
      } finally {
        endBackup()
      }
    },
    [beginBackup, endBackup],
  )

  const backupRetryNotificationCleanup = useCallback(async (): Promise<{ ok: boolean; reason: string | null }> => {
    const service = taskReminderServiceRef.current
    if (!service) return { ok: true, reason: null }
    try {
      const report = await service.cancelAllOwnedNotifications('重试取消旧提醒')
      if (report.ok) {
        service.resumeAfterBackup()
        setBackupLastRestore((value) => (value ? { ...value, notificationWarning: null } : value))
      }
      return { ok: report.ok, reason: report.reason }
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [])

  const backupRetryNavigationReset = useCallback(async (): Promise<{ ok: boolean; reason: string | null }> => {
    if (backupGateRef.current.state !== 'restoring') {
      return { ok: false, reason: '当前没有等待重置的恢复。' }
    }
    try {
      const expectedKey = requestNavigationRemount()
      await waitForNavigationReset(expectedKey)
      snapshotTokenRef.current += 1
      await refresh()
      const service = taskReminderServiceRef.current
      if (service) {
        const postCancel = await service.cancelAllOwnedNotifications('重试界面重置后取消旧提醒')
        if (!postCancel.ok) {
          return { ok: false, reason: postCancel.reason ?? '旧提醒仍未能完全取消；写入闸门保持关闭。' }
        }
        service.resumeAfterBackup()
      }
      setBackupLastRestore((current) =>
        current
          ? { ...current, navigationResetFailed: false, refreshError: refreshErrorRef.current, notificationWarning: null }
          : current,
      )
      endBackup()
      return { ok: true, reason: null }
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [endBackup, refresh, requestNavigationRemount, waitForNavigationReset])

  const value = useMemo<AppStoreValue>(() => {
    const courseMap = new Map(data.courses.map((course) => [course.id, course]))
    return {
      status,
      error,
      refreshError,
      schemaVersion,
      data,
      calibration,
      today,
      studyReferenceMinutes,
      saveStudyReferenceMinutes: async (raw) => {
        if (backupGateRef.current.state !== 'idle') {
          return {
            ok: false,
            committed: false,
            minutes: null,
            reason: '正在导出、预览或恢复备份，请等这一步结束再改动数据。',
            refreshError: null,
          }
        }
        const run = async (): Promise<StudyReferenceSaveResult> => {
          const repos = repositories.current
          if (!repos) {
            return {
              ok: false,
              committed: false,
              minutes: null,
              reason: '本机数据库还没有准备好，请稍后再试。',
              refreshError: null,
            }
          }
          const result = await repos.settings.saveDailyStudyReferenceMinutes(raw)
          if (!result.ok) {
            // 输入被拒绝：一个字节都没写，明确区分于「写了但没刷新出来」。
            return { ok: false, committed: false, minutes: null, reason: result.reason, refreshError: null }
          }
          // 写入已经提交 → 立即同步内存快照，界面马上就能看到新值。
          if (mounted.current) setStudyReferenceMinutes(result.minutes)
          await refresh()
          return {
            ok: true,
            committed: true,
            minutes: result.minutes,
            reason: null,
            refreshError: refreshErrorRef.current,
          }
        }
        const chained = queue.current.then(run, run)
        queue.current = chained.then(
          () => undefined,
          () => undefined,
        )
        return chained
      },
      notificationRouteGeneration,
      getNotificationRouteGeneration,
      latestBackupExport,
      backupContentView,
      backup: {
        gate: backupGate,
        exportToFiles: backupExportToFiles,
        createLocalBackup: backupCreateLocalBackup,
        previewLatestExport: backupPreviewLatestExport,
        pickPreview: backupPickPreview,
        retainPreviewInLibrary: backupRetainPreviewInLibrary,
        listLibrary: backupListLibrary,
        previewLibraryEntry: backupPreviewLibraryEntry,
        openContentView: backupOpenContentView,
        closeContentView: backupCloseContentView,
        retainContentView: backupRetainContentView,
        releaseContentView: backupReleaseContentView,
        saveLibraryEntryToFiles: backupSaveLibraryEntryToFiles,
        restore: backupRestore,
        discardPreview: backupDiscardPreview,
        importImagesFromPreview: backupImportImagesFromPreview,
        importImagesFromContentView: backupImportImagesFromContentView,
        listRecovery: backupListRecovery,
        saveRecoveryToFiles: backupSaveRecoveryToFiles,
        retryNotificationCleanup: backupRetryNotificationCleanup,
        retryNavigationReset: backupRetryNavigationReset,
      },
      backupLastRestore,
      dismissBackupLastRestore: () => setBackupLastRestore(null),
      restoreEpoch,
      navigationRemountKey,
      acknowledgeRestoreNavigationReset,
      refresh,
      getTaskFresh,
      notificationReceipts: {
        hasConsumed: async (token) => {
          const repository = notificationReceiptsRepositoryRef.current
          if (!repository) {
            return { ok: false, consumed: false, reason: '本机数据库还没有准备好，请稍后重试。' }
          }
          // 与任务写事务共用一条串行队列：读回执也不能插进正在提交的事务中间。
          return runSerializedRead(() => repository.hasConsumed(token))
        },
        recordConsumption: async (receipt) => {
          const repository = notificationReceiptsRepositoryRef.current
          if (!repository) {
            return {
              ok: false,
              stored: false,
              receipts: null,
              reason: '本机数据库还没有准备好，请稍后重试。',
            }
          }
          // 回执仓库自己开事务；这里只负责与任务 / 课程写入严格串行，不触发全量刷新。
          return runSerializedRead(() => repository.recordConsumption(receipt))
        },
      },
      retryBootstrap: bootstrap,
      todayPlan: {
        /**
         * 只读快照：直接读库，**不进写队列**（和截图库的只读视图同一个考虑）。
         * 读出来的计划可能是 `null`（今天还没排）或一条不可用原因（JSON 坏了）。
         */
        loadTodayPlan: async (date) => {
          if (!todayPlanRepository) {
            return {
              ok: false,
              reason: '本机数据库还没有准备好，请稍后再试。',
              rawExcerpt: null,
            }
          }
          return todayPlanRepository.loadTodayPlan(date)
        },
        /**
         * 保存走**公共串行队列**：与任务 / 课程 / 设置的写入严格一个接一个。
         * `enqueue` 本身不开事务（只串行化），而计划仓库内部自己开一个事务，
         * 因此不会出现嵌套事务；随后的 `refresh()` 由 `enqueue` 统一执行。
         *
         * 注意：即使写成功、随后的快照刷新失败，提交结论也不被改写
         * （`SaveTodayPlanResult.committed` 才是唯一事实）。
         */
        saveTodayPlan: async (input) => {
          if (!todayPlanRepository) {
            return {
              ok: false,
              committed: false,
              revision: null,
              reason: '本机数据库还没有准备好，请稍后再试。',
              readbackError: null,
            }
          }
          return enqueue(() => todayPlanRepository.saveTodayPlan(input))
        },
      },
      /**
       * 任务步骤清单：读取只走 SELECT（不进队列、不建表、不写任何东西）；
       * 保存走**公共串行队列**，与任务 / 课程 / 设置 / 今日计划严格一个接一个。
       * 队列只做串行化、不开事务，事务在仓库内部开，因此不会嵌套。
       */
      taskSteps: {
        loadSteps: async (taskId) => {
          if (!taskStepsRepository) {
            return {
              ok: false,
              code: 'NOT_READY',
              reason: '本机数据库还没有准备好，请稍后再试。',
              rawExcerpt: null,
            }
          }
          return taskStepsRepository.loadSteps(taskId)
        },
        saveSteps: async (input) => {
          if (!taskStepsRepository) {
            return {
              ok: false,
              committed: false,
              revision: null,
              reason: '本机数据库还没有准备好，请稍后再试。',
              readbackError: null,
            }
          }
          return enqueue(() => taskStepsRepository.saveSteps(input))
        },
      },
      /**
       * 任务原图：读取只走 SELECT（不进队列）；添加 / 解除关联走**公共串行队列**
       * （`enqueue` 本身不开事务，仓库内部自己开，因此不会嵌套）。
       * 提交之后的全量快照刷新失败只记进 `refreshError`，不改写 `committed`。
       */
      taskPhotos: {
        listPhotos: async (taskId) => {
          const repos = repositories.current
          return repos ? repos.taskPhotos.listPhotos(taskId) : { taskExists: false, photos: [] }
        },
        listAddable: async (taskId, limit) => {
          const repos = repositories.current
          return repos ? repos.taskPhotos.listAddable(taskId, limit) : { taskExists: false, photos: [] }
        },
        attachPhoto: async (taskId, attemptId) => {
          const repos = repositories.current
          if (!repos) {
            return {
              committed: false,
              idempotent: false,
              taskId,
              attemptId,
              manualRefId: null,
              code: 'WRITE_FAILED' as const,
              reason: '本机数据库还没有准备好，请稍后再试。',
              refreshError: null,
            }
          }
          try {
            const outcome = await enqueue((current) => current.taskPhotos.attach(taskId, attemptId))
            return { ...outcome, refreshError: refreshErrorRef.current }
          } catch (cause) {
            return {
              committed: false,
              idempotent: false,
              taskId,
              attemptId,
              manualRefId: null,
              code: 'WRITE_FAILED' as const,
              reason: `这条关联没有写入：${cause instanceof Error ? cause.message : String(cause)}`,
              refreshError: refreshErrorRef.current,
            }
          }
        },
        detachPhoto: async (taskId, attemptId) => {
          const repos = repositories.current
          if (!repos) {
            return {
              committed: false,
              removed: false,
              taskId,
              attemptId,
              code: 'WRITE_FAILED' as const,
              reason: '本机数据库还没有准备好，请稍后再试。',
              refreshError: null,
            }
          }
          try {
            const outcome = await enqueue((current) => current.taskPhotos.detach(taskId, attemptId))
            return { ...outcome, refreshError: refreshErrorRef.current }
          } catch (cause) {
            return {
              committed: false,
              removed: false,
              taskId,
              attemptId,
              code: 'WRITE_FAILED' as const,
              reason: `这条关联没有解除：${cause instanceof Error ? cause.message : String(cause)}`,
              refreshError: refreshErrorRef.current,
            }
          }
        },
      },
      /**
       * 任务截止提醒：读取走服务的只读检查；保存 / 测试 / 重试由服务串行执行。
       * 所有方法通过 ref 取当前服务，避免 bootstrap 的一个新实例让整个 store value 重建。
       */
      getClassReminder: () => classReminderServiceRef.current,
      taskReminder: {
        inspect: async (taskId) => {
          const service = taskReminderServiceRef.current
          if (!service) throw new Error('本机数据库还没有准备好，请稍后再试。')
          return service.inspectTask(taskId)
        },
        save: async (input) => {
          assertBackupWritable()
          const service = taskReminderServiceRef.current
          if (!service) throw new Error('本机数据库还没有准备好，请稍后再试。')
          return service.saveSettings(input)
        },
        test: async (taskId) => {
          assertBackupWritable()
          const service = taskReminderServiceRef.current
          if (!service) throw new Error('本机数据库还没有准备好，请稍后再试。')
          return service.testReminder(taskId)
        },
        retry: async (taskId) => {
          assertBackupWritable()
          const service = taskReminderServiceRef.current
          if (!service) throw new Error('本机数据库还没有准备好，请稍后再试。')
          const report = await service.reconcile('manual-retry')
          const inspection = await service.inspectTask(taskId)
          return { inspection, reason: report.reason ?? inspection.pendingReason }
        },
        reconcile: async (reason) => {
          const service = taskReminderServiceRef.current
          if (!service) throw new Error('本机数据库还没有准备好，请稍后再试。')
          return service.reconcile(reason)
        },
        getSnapshot: () => {
          const service = taskReminderServiceRef.current
          return (
            service?.getSnapshot() ?? {
              permission: { status: 'undetermined' as const, canAskAgain: true, detail: null },
              lastError: null,
              lastReconciledAtMs: null,
              lastReport: null,
              busy: false,
            }
          )
        },
        subscribe: (listener) => {
          const service = taskReminderServiceRef.current
          return service ? service.subscribe(listener) : () => undefined
        },
      },
      importExamPhoto: async (input) => {
        const result = await enqueue(async (repos) => {
          assertBackupWritable()
          if (input.generation !== notificationRouteGenerationRef.current) throw new Error('数据已恢复，请重新选择照片并核对。')
          return importExamPhoto(repos.db, repos.tasks, input)
        }, { refreshAfter: false })
        let warning: string | null = null
        try { await refresh(); warning = refreshErrorRef.current }
        catch (cause) { warning = cause instanceof Error ? cause.message : String(cause) }
        return { ...result, refreshError: warning }
      },
      weeklyGoal: {
        load: () => runSerializedRead(async () => {
          assertBackupWritable()
          const repos = repositories.current
          if (!repos) throw new Error('本机数据还没有准备好。')
          return { goals: await loadWeeklyGoals(repos.settings), focus: await loadFocus(repos.settings), generation: notificationRouteGenerationRef.current }
        }),
        save: (revision, generation, week, minutes) => enqueue(async repos => {
          assertBackupWritable()
          if (generation !== notificationRouteGenerationRef.current) throw new Error('数据已恢复，请重新读取学习目标。')
          return saveWeeklyGoal(repos.settings, revision, week, minutes)
        }, { refreshAfter: false }),
      },
      focusTime: {
        getReminder: () => focusReminderServiceRef.current,
        load: () => runSerializedRead(async () => {
          assertBackupWritable()
          const repos = repositories.current
          if (!repos) throw new Error('本机数据还没有准备好。')
          return { ...await loadFocus(repos.settings), generation: notificationRouteGenerationRef.current }
        }),
        act: async (revision, generation, action) => {
          const result = await enqueue(async repos => {
            assertBackupWritable()
            if (generation !== notificationRouteGenerationRef.current) throw new Error('数据已恢复，请重新读取专注状态。')
            const snapshot = await saveFocusAction(repos.settings, revision, action)
            focusReminderServiceRef.current?.changed()
            return { ...snapshot, generation }
          }, { refreshAfter: false })
          // Notification failures must never turn an already committed timer write into a failed save.
          try {
            const reminder = await focusReminderServiceRef.current?.reconcile(action.type === 'reminder' && action.enabled)
            return { ...result, reminder }
          } catch (cause) {
            return { ...result, reminder: { queuedAt: null, busy: false, permission: 'unavailable', error: `计时已保存；提醒同步失败：${cause instanceof Error ? cause.message : String(cause)}` } }
          }
        },
      },
      examRevision: {
        load: () => runSerializedRead(async () => {
          assertBackupWritable()
          const repos = repositories.current
          if (!repos) throw new Error('本机数据还没有准备好。')
          const snapshot = await new ExamRevisionRepository(repos.db, repos.tasks).load()
          return { ...snapshot, generation: notificationRouteGenerationRef.current }
        }),
        create: async (input) => {
          const result = await enqueue(async (repos) => {
            assertBackupWritable()
            if (input.generation !== notificationRouteGenerationRef.current) throw new Error('数据已恢复，请重新打开考试并预览。')
            return new ExamRevisionRepository(repos.db, repos.tasks).create(input)
          }, { refreshAfter: false })
          let warning: string | null = null
          try { await refresh(); warning = refreshErrorRef.current }
          catch (cause) { warning = cause instanceof Error ? cause.message : String(cause) }
          return { ...result, refreshError: warning }
        },
      },
      taskTemplates: {
        saveFromTask: async (taskId, input) => {
          const template = await enqueue((repos) => repos.taskTemplates.createTemplateFromTask(taskId, input))
          return { committed: true, template, refreshError: refreshErrorRef.current }
        },
        create: async (input) => {
          const template = await enqueue((repos) => repos.taskTemplates.createTemplate(input))
          return { committed: true, template, refreshError: refreshErrorRef.current }
        },
        update: async (id, input) => {
          const template = await enqueue((repos) => repos.taskTemplates.updateTemplate(id, input))
          return { committed: true, template, refreshError: refreshErrorRef.current }
        },
        remove: async (id) => {
          await enqueue((repos) => repos.taskTemplates.removeTemplate(id))
        },
        apply: async (templateId) => {
          const repos = repositories.current
          if (!repos) return { ok: false, draft: null, warnings: [], reason: '本机数据库还没有准备好，请稍后再试。' }
          if (backupGateRef.current.state !== 'idle') {
            return { ok: false, draft: null, warnings: [], reason: '正在导出、预览或恢复备份，请等这一步结束再应用模板。' }
          }
          try {
            const result = await runSerializedRead(() => repos.taskTemplates.applyTemplate(templateId))
            return { ok: true, draft: result.draft, warnings: result.warnings, reason: null }
          } catch (cause) {
            return {
              ok: false,
              draft: null,
              warnings: [],
              reason: cause instanceof Error ? cause.message : String(cause),
            }
          }
        },
        preview: (input, ruleId = null) => {
          const snapshot = {
            templates: data.templates,
            rules: data.recurrenceRules,
            ledger: data.recurrenceLedger,
            nextRuleId: data.recurrenceNextRuleId,
            error: data.templateStoreError,
          }
          return TaskTemplateRepository.previewWithSnapshot(
            input,
            snapshot,
            new Set(data.courses.map((course) => course.id)),
            new Set(data.tasks.map((task) => task.id)),
            ruleId,
          )
        },
        generate: async (input, options) => {
          const outcome = await enqueue((repos) => repos.taskTemplates.generateRecurrence(input, options))
          if (outcome.created > 0) afterTaskMutation('recurrence-generate')
          return { ...outcome, refreshError: refreshErrorRef.current }
        },
        removeRule: async (id) => {
          await enqueue((repos) => repos.taskTemplates.removeRecurrenceRule(id))
        },
      },
      templateStoreError: data.templateStoreError,
      readSearchTarget: async (input) => {
        const { kind, id } = input.owner
        const generation = input.generation
        if (!Number.isSafeInteger(id) || id <= 0 || (kind !== 'task' && kind !== 'course')) throw new Error('搜索结果无效，请重新搜索。')
        assertBackupWritable()
        return runSerializedRead(async () => {
          assertBackupWritable()
          if (generation !== notificationRouteGenerationRef.current) throw new Error('数据已恢复，请重新核对搜索结果。')
          const repos = repositories.current
          if (!repos) throw new Error('数据还没有准备好，请稍后再试。')
          const record = kind === 'task' ? await repos.tasks.getById(id) : await repos.courses.getById(id)
          assertBackupWritable()
          if (generation !== notificationRouteGenerationRef.current) throw new Error('数据已恢复，请重新核对搜索结果。')
          return record !== null
        })
      },
      applyTaskBatch: async (input) => {
        // Freeze the caller's preview before waiting for other writes.
        const snapshot = { ...input, action: { ...input.action }, targets: input.targets.map(target => ({ ...target })) }
        const result = await enqueue(async (repos) => {
          assertBackupWritable()
          if (snapshot.generation !== notificationRouteGenerationRef.current) throw new Error('数据已恢复，请重新选择任务并预览。')
          return applyTaskBatch(repos.db, repos.tasks, snapshot)
        }, { refreshAfter: false })
        let warning: string | null = null
        try { afterTaskMutation('task-batch') }
        catch { warning = '任务已保存，提醒同步暂未完成，请到提醒设置重试。' }
        try { await refresh(); if (refreshErrorRef.current) warning = '任务已保存，列表刷新失败，请刷新列表。' }
        catch { warning = '任务已保存，列表刷新失败，请刷新列表。' }
        return { ...result, warning }
      },
      createTask: async (draft) => {
        const outcome = await enqueue((repos) => repos.tasks.create(draft))
        if (outcome.committed) afterTaskMutation('task-create')
        return outcome
      },
      updateTask: async (id, draft) => {
        const outcome = await enqueue((repos) => repos.tasks.update(id, draft))
        if (outcome.committed) afterTaskMutation('task-update')
        return outcome
      },
      appendTaskOriginalText: async (id, text) => {
        await enqueue((repos) => repos.tasks.appendOriginalText(id, text))
      },
      changeTaskStatus: async (id, taskStatus) => {
        const updated = await enqueue((repos) => repos.tasks.changeStatus(id, taskStatus))
        afterTaskMutation('task-status')
        return updated
      },
      toggleTaskComplete: async (id) => {
        const updated = await enqueue((repos) => repos.tasks.toggleComplete(id))
        afterTaskMutation('task-toggle')
        return updated
      },
      deleteTask: async (id) => {
        await enqueue((repos) => repos.tasks.remove(id))
        afterTaskMutation('task-delete')
      },
      createCourse: (draft) => enqueue((repos) => repos.courses.create(draft)),
      updateCourse: (id, draft) => enqueue((repos) => repos.courses.update(id, draft)),
      deleteCourse: (id, options) => enqueue((repos) => repos.courses.removeCourse(id, options)),
      countCourseReferences: async (id) => {
        const repos = repositories.current
        if (!repos) return { taskCount: 0, scheduleCount: 0 }
        const refs = await repos.courses.describeReferences(id)
        return { taskCount: refs.taskCount, scheduleCount: refs.scheduleCount }
      },
      createSchedule: (courseId, draft) => enqueue((repos) => repos.courses.createSchedule(courseId, draft)),
      updateSchedule: (scheduleId, draft) => enqueue((repos) => repos.courses.updateSchedule(scheduleId, draft)),
      applyScheduleBatch: (courseId, change) => enqueue((repos) => repos.courses.applyScheduleBatch(courseId, change)),
      deleteSchedule: (scheduleId) => enqueue((repos) => repos.courses.removeSchedule(scheduleId)),
      saveCalibration: (currentWeek) => {
        const run = async (): Promise<CalibrationSaveResult> => {
          const repos = repositories.current
          if (!repos) return { ok: false, reason: '本机数据库还没有准备好，请稍后再试。', calibration: null }
          if (backupGateRef.current.state !== 'idle') {
            return { ok: false, reason: '正在导出、预览或恢复备份，请等这一步结束再改动数据。', calibration: null }
          }
          const result = await repos.settings.saveTeachingWeekCalibration({
            today: todayInBeijing(),
            currentWeek,
          })
          await refresh()
          if (!result.ok) return { ok: false, reason: result.reason, calibration: null }
          return { ok: true, calibration: result.calibration }
        }
        const chained = queue.current.then(run, run)
        queue.current = chained.then(
          () => undefined,
          () => undefined,
        )
        return chained
      },
      clearCalibration: async () => {
        assertBackupWritable()
        const run = async (): Promise<void> => {
          const repos = repositories.current
          if (!repos) throw new Error('本机数据库还没有准备好，请稍后再试。')
          await repos.settings.clearTeachingWeekCalibration()
          await refresh()
        }
        const chained = queue.current.then(run, run)
        queue.current = chained.then(
          () => undefined,
          () => undefined,
        )
        await chained
      },
      importSchedules: (request) => {
        assertBackupWritable()
        const run = async (): Promise<ScheduleImportOutcome> => {
          const repos = repositories.current
          if (!repos) throw new Error('本机数据库还没有准备好，请稍后再试。')
          return repos.imports.importCandidates(request)
        }
        const chained = importQueue.current.then(run, run)
        importQueue.current = chained.then(
          () => undefined,
          () => undefined,
        )
        // 导入自带事务，完成后单独刷新一次快照；刷新失败只影响列表，不改写导入结论。
        return chained.then(async (outcome) => {
          await refresh()
          return outcome
        })
      },
      /**
       * 通知原文转待办。
       *
       * **刻意复用 store 的公共串行队列**（与 `createTask` / `saveCalibration` 同一条），
       * 而不是像照片导入那样另开一条队列：同一个 SQLite 连接上，如果通知导入自己开事务、
       * 同时用户在别的标签页改课程 / 任务，两条写入就可能重叠。
       * 公共队列保证「写入 → 刷新」严格一个接一个（`enqueue` 本身**不开**事务，
       * 只做串行化，因此这里不会嵌套事务）。
       *
       * 提交结论由 `outcome.committed` 决定：随后的刷新失败只影响列表，不改写导入结论。
       */
      importNoticeCandidates: async (request) => {
        const outcome = await enqueue((repos) => repos.noticeImports.importNoticeCandidates(request))
        if (outcome.committed) afterTaskMutation('notice-import')
        return outcome
      },
      ocrEndpoint,
      inferredOcrEndpoint: inferCompanionEndpoint(),
      saveOcrEndpoint,
      checkOcrEndpoint,
      autoConfigureOcrEndpoint,
      courseById: (id) => (id === null || id === undefined ? null : (courseMap.get(id) ?? null)),
      /* ------------------------------ 截图库（v3） ------------------------------ */
      screenshotPathRepair,
      repairScreenshotPaths,
      screenshotLibrary: {
        /**
         * 只读视图：直接读仓库（SELECT 不进队列）。
         * 写入全部走下面的显式动作，因此这里不会和导入事务抢写。
         */
        listAttempts: async (limit) => {
          const repos = repositories.current
          return repos ? repos.screenshots.listAttempts(limit) : []
        },
        getAttempt: async (attemptId) => {
          const repos = repositories.current
          return repos ? repos.screenshots.getAttempt(attemptId) : null
        },
        listViewableAttempts: async (limit) => {
          const repos = repositories.current
          return repos ? repos.screenshots.listViewableAttempts(limit) : []
        },
        listSources: async () => {
          const repos = repositories.current
          return repos ? repos.screenshots.listSources() : []
        },
        listAttemptsLinkedTo: async (targetKind, targetId) => {
          const repos = repositories.current
          return repos ? repos.screenshots.listAttemptsLinkedTo(targetKind, targetId) : []
        },
        getOcrResultByAttempt: async (attemptId) => {
          const repos = repositories.current
          return repos ? repos.screenshots.getOcrResultByAttempt(attemptId) : null
        },
        countAttemptsWithFile: async () => {
          const repos = repositories.current
          return repos ? repos.screenshots.countAttemptsWithFile() : 0
        },
        getSourceByKey: async (catalogKey) => {
          const repos = repositories.current
          return repos ? repos.screenshots.getSourceByKey(catalogKey) : null
        },
        countRefsTo: async (targetKind, targetId) => {
          const repos = repositories.current
          return repos ? repos.screenshots.countRefsTo(targetKind, targetId) : 0
        },
      },
      archiveOriginal: async (uri, source, attemptSource) => {
        const repos = repositories.current
        if (!repos) {
          return { ok: false, attemptId: null, message: '本机数据库还没有准备好，这张图暂时没法保存。', archivedUri: null }
        }
        if (backupGateRef.current.state !== 'idle') {
          return {
            ok: false,
            attemptId: null,
            message: '正在导出、预览、恢复备份或只导入截图，请等这一步结束再提交图片。',
            archivedUri: null,
          }
        }
        try {
          /**
           * 文件落盘与 `recordAttempt` 都放进**公共串行写队列**（不另开队列）。
           *
           * 这样它与任务 / 课程写入、备份恢复不会交错；备份动作开始后，`enqueue`
           * 的闸门检查会同步拒绝新的归档。`refreshAfter: false` 是有意的：
           * 归档只写截图库，不改变任务 / 课程快照，随后的界面自己会刷新。
           */
          const outcome: ScreenshotArchiveOutcome = await enqueue(
            async (current) => {
              const fs = await loadNativeFileSystem()
              return archivePickedPhoto(
                { uri, source, attemptSource },
                {
                  fs,
                  readSourceBase64,
                  recordAttempt: (input) => current.screenshots.recordAttempt(input),
                },
              )
            },
            { refreshAfter: false },
          )
          return {
            ok: outcome.ok,
            attemptId: outcome.attemptId,
            message: outcome.ok ? null : outcome.message,
            archivedUri: outcome.ok ? outcome.archivedUri : null,
          }
        } catch (cause) {
          return {
            ok: false,
            attemptId: null,
            message: `这张图没能保存到截图库：${cause instanceof Error ? cause.message : String(cause)}`,
            archivedUri: null,
          }
        }
      },
      recordScreenshotResult: async (input) => {
        const repos = repositories.current
        if (!repos || input.attemptId === null) return
        // 恢复期间旧 OCR 结果绝不能按旧 attempt id 写进新数据集。
        if (backupGateRef.current.state !== 'idle') return
        await repos.screenshots.recordOcrResult({
          attemptId: input.attemptId,
          status: input.status,
          // 通知 OCR 没有 response：只记录它真实拥有的字段，不会伪造课表 layout / week / 候选。
          requestId: input.requestId ?? input.response?.requestId ?? null,
          layout: input.response?.layout ?? null,
          week: input.response?.week ?? null,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          warnings: input.warnings ?? input.response?.warnings ?? null,
          payload: input.response ?? null,
          rawText: input.rawText ?? input.response?.rawText ?? null,
          ocrCalls: input.response?.ocrCalls ?? null,
          durationMs: input.durationMs ?? input.response?.ms ?? null,
          image: input.image ?? input.response?.image ?? null,
          candidates: (input.candidates ?? []).map((candidate, index) => ({
            rowIndex: index,
            name: candidate.name ?? null,
            weekday: candidate.weekday ?? null,
            startTime: candidate.startTime ?? null,
            endTime: candidate.endTime ?? null,
            location: candidate.location ?? null,
            startWeek: candidate.startWeek ?? null,
            endWeek: candidate.endWeek ?? null,
            weekPattern: candidate.weekPattern ?? null,
            // 选课序号与内部编号分开存：这里写的就是图上那串数字。
            selectionSerial: candidate.courseCode ?? null,
            rawText: candidate.rawText ?? null,
            warnings: candidate.warnings ?? null,
          })),
        })
      },
      readArchivedPhoto: (uri) => readArchivedBase64(uri),
      rerunArchiveOriginal: async (target) => {
        const repos = repositories.current
        if (!repos) return { ok: false, attemptId: null, message: '本机数据库还没有准备好，请稍后再试。' }
        if (backupGateRef.current.state !== 'idle') {
          return { ok: false, attemptId: null, message: '正在导出、预览或恢复备份，请等这一步结束再重新识别。' }
        }
        if (!target?.archivedPath) {
          return { ok: false, attemptId: null, message: '这一条没有可用的原图，无法重新识别。' }
        }
        // 先确认文件真的还在（可能被系统清过）：不在就明确说，别让用户对着一个空流程等。
        const exists = await archivedFileExists(target.archivedPath)
        if (!exists) {
          return {
            ok: false,
            attemptId: null,
            message: '这张截图在本机找不到了（可能被系统清理过）。请重新提交一次。',
          }
        }
        try {
          const recorded = await repos.screenshots.recordAttempt({
            source: 'LIBRARY',
            status: 'ARCHIVED',
            archivedPath: target.archivedPath,
            originalUri: target.archivedPath,
            sha256: target.sha256,
            byteLength: target.byteLength,
            width: target.width,
            height: target.height,
            format: target.format,
            mimeType: target.mimeType,
            note: '用截图库里的原图重新识别（新的一次尝试，不改写旧结果）',
          })
          return {
            ok: true,
            attemptId: recorded.attempt.id,
            message: recorded.deduplicated ? '同一份原图，这次只新增一次识别历史。' : null,
          }
        } catch (cause) {
          return {
            ok: false,
            attemptId: null,
            message: `这次尝试没能登记：${cause instanceof Error ? cause.message : String(cause)}`,
          }
        }
      },
      knownSources: KNOWN_SOURCE_CATALOG,
      fetchArchiveMetadata: () =>
        fetchCompanionArchiveSources(ocrEndpointRef.current ?? inferCompanionEndpoint(), { timeoutMs: 6_000 }),
      /**
       * 把历史来源清单同步进本机登记表。
       *
       * 顺序（复核对要求「优先从电脑读目录、失败才用离线清单」）：
       * 1. 先按**离线清单**确保每条都存在（只含路径 + 校验和 + 中性标题），
       *    这样即使电脑没开机也能列出条目、也能离线校验；
       * 2. 再尝试从电脑读目录：读到了就用它的标题 / 说明 / 图上事实**更新文案**
       *    （`upsertSourceEntry` 只更新文案字段，不删除任何历史）；
       * 3. 读不到就保持中性标题 —— 绝不编造「图上有体育」这类内容。
       */
      syncKnownSources: async () => {
        const repos = repositories.current
        if (!repos) return
        if (backupGateRef.current.state !== 'idle') return
        for (const entry of KNOWN_SOURCE_CATALOG) {
          await repos.screenshots.upsertSourceEntry(knownSourceToCatalogEntry(entry))
        }
        const remote = await fetchCompanionArchiveSources(ocrEndpointRef.current ?? inferCompanionEndpoint(), {
          timeoutMs: 6_000,
        })
        if (!remote.ok) return
        // 只更新离线清单里登记过的那几条（不从电脑引入任意新条目）。
        for (const entry of remote.sources) {
          const known = knownSourceByKey(entry.catalogKey)
          if (!known) continue
          await repos.screenshots.upsertSourceEntry({
            catalogKey: entry.catalogKey,
            title: entry.title,
            description: entry.description,
            archiveRelPath: known.archiveRelPath,
            sha256: known.sha256,
            byteLength: entry.byteLength ?? known.byteLength,
            width: entry.width,
            height: entry.height,
            layout: null,
            capturedAt: null,
            provenance: null,
          })
        }
      },
      restoreKnownSource: async (catalogKey) => {
        const repos = repositories.current
        const entry = knownSourceByKey(catalogKey)
        if (!repos) return { ok: false, attemptId: null, message: '本机数据库还没有准备好，请稍后再试。' }
        if (backupGateRef.current.state !== 'idle') {
          return { ok: false, attemptId: null, message: '正在导出、预览或恢复备份，请等这一步结束再恢复历史截图。' }
        }
        if (!entry) return { ok: false, attemptId: null, message: '这个来源不在本机登记的目录里。' }
        const endpoint = ocrEndpointRef.current ?? inferCompanionEndpoint()
        const resolved = resolveOcrEndpoint(endpoint)
        if (!resolved.ok) {
          return {
            ok: false,
            attemptId: null,
            message: '还没有可用的电脑地址：先到「识别服务设置」填好同一 Wi-Fi 下这台电脑的地址，再恢复。',
          }
        }
        try {
          // 下载就带**期望的**哈希：`downloadArchivedSource` 会先落到唯一临时文件、
          // 校验 HTTP 状态与真实字节的 SHA256，全部通过才改名成内容寻址的稳定文件。
          // 因此中断的第二次下载**不会**截断本机已经验证过的那一份。
          const downloaded = await downloadArchivedSource({
            remoteUri: `${resolved.endpoint}/v1/archive/source/${encodeURIComponent(catalogKey)}`,
            expectedSha256: entry.sha256,
            format: 'png',
            deps: { fs: await loadNativeFileSystem() },
          })
          // 尺寸 / 标题优先取本机登记表里已经持久化的文案（可能来自上一次电脑目录同步），
          // 拿不到就留空：尺寸只是展示用，不影响「原图是否完整」这件事（那由哈希保证）。
          const registered = await repos.screenshots.getSourceByKey(catalogKey)
          const recorded = await repos.screenshots.recordAttempt({
            source: 'ARCHIVE',
            status: 'ARCHIVED',
            archivedPath: downloaded.uri,
            originalUri: downloaded.uri,
            sha256: downloaded.sha256,
            byteLength: downloaded.byteLength,
            width: registered?.width ?? null,
            height: registered?.height ?? null,
            format: 'png',
            mimeType: 'image/png',
            note: '从电脑恢复的历史截图（原图字节逐字节校验过）',
          })
          await repos.screenshots.attachSourceAttempt(catalogKey, recorded.attempt.id)
          return {
            ok: true,
            attemptId: recorded.attempt.id,
            message: recorded.deduplicated
              ? '这张图本机已经有了，这次只补记了一次提交历史（字节共用一份）。'
              : `已恢复到本机截图库：${registered?.title ?? entry.neutralTitle}`,
          }
        } catch (cause) {
          return {
            ok: false,
            attemptId: null,
            message: `恢复失败：${cause instanceof Error ? cause.message : String(cause)}`,
          }
        }
      },
    }
  }, [
    acknowledgeRestoreNavigationReset,
    afterTaskMutation,
    assertBackupWritable,
    autoConfigureOcrEndpoint,
    backupCloseContentView,
    backupContentView,
    backupCreateLocalBackup,
    backupDiscardPreview,
    backupExportToFiles,
    backupGate,
    backupImportImagesFromContentView,
    backupImportImagesFromPreview,
    backupLastRestore,
    backupListLibrary,
    backupListRecovery,
    backupOpenContentView,
    backupPickPreview,
    backupPreviewLatestExport,
    backupPreviewLibraryEntry,
    backupReleaseContentView,
    backupRestore,
    backupRetainContentView,
    backupRetainPreviewInLibrary,
    backupSaveLibraryEntryToFiles,
    backupRetryNavigationReset,
    backupRetryNotificationCleanup,
    backupSaveRecoveryToFiles,
    bootstrap,
    calibration,
    checkOcrEndpoint,
    data,
    enqueue,
    error,
    getNotificationRouteGeneration,
    getTaskFresh,
    latestBackupExport,
    navigationRemountKey,
    notificationRouteGeneration,
    ocrEndpoint,
    refresh,
    repairScreenshotPaths,
    restoreEpoch,
    runSerializedRead,
    refreshError,
    saveOcrEndpoint,
    schemaVersion,
    screenshotPathRepair,
    status,
    studyReferenceMinutes,
    taskStepsRepository,
    today,
    todayPlanRepository,
  ])

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useAppStore(): AppStoreValue {
  const value = useContext(StoreContext)
  if (!value) throw new Error('useAppStore 必须在 <AppStoreProvider> 内部使用。')
  return value
}
