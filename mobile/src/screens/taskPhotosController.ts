/**
 * 「任务原图」屏的**运行状态机**（不依赖 React / Expo，可在 Node 里真异步测试）。
 *
 * 只做显式读写，没有自动选择、没有自动关联：
 * - `refresh()`：只读地重新读取「已关联」与「可添加」两份列表；
 * - `attach()` / `detach()`：只在用户明确点击后调用仓库写入；
 * - **同步 busy 闸门**：任何写入在第一个 `await` 之前置位，同一帧里的第二次点击
 *   直接得到 `busy`，绝不会发起第二个写请求；
 * - **迟到的读取一律作废**：每次读取有递增序号，切换任务 / 卸载会推进 epoch，
 *   旧读回即使晚到也不能再改当前任务的状态；
 * - **提交后刷新失败只说「已保存」**：写入提交是事实，随后的列表读失败只提示
 *   「点重新读取列表」，并把页面置为只能重试刷新（不能重复添加 / 解除）；
 * - 任务在页面打开后被删除时，读取返回「任务不在」，写入由仓库在事务里拒绝，
 *   状态机把页面切到「任务不在」，不再允许任何写入。
 */

import {
  isPositiveSafeInteger,
  TASK_PHOTO_CANDIDATE_LIMIT as REPOSITORY_TASK_PHOTO_CANDIDATE_LIMIT,
  type AttachTaskPhotoOutcome,
  type DetachTaskPhotoOutcome,
  type TaskPhoto,
  type TaskPhotoAttempt,
  type TaskPhotoCandidatesSnapshot,
  type TaskPhotoFailureCode,
  type TaskPhotosSnapshot,
} from '../domain/taskPhotoRepository'
import type { PhotoPickResult } from '../domain/photoPicker'

export type TaskPhotosAction = 'attach' | 'detach' | 'add'

/** 「直接放一张截图」的三个真实阶段（界面据此显示诚实的进度，而不是一个假转圈）。 */
export type TaskPhotosAddPhase = 'idle' | 'picking' | 'saving' | 'attaching'

export interface TaskPhotosNotice {
  tone: 'success' | 'error'
  text: string
}

export interface TaskPhotosState {
  taskId: number
  /** 至少完成过一次读取（成功或失败）。 */
  loaded: boolean
  loading: boolean
  /** 同步在途闸门的界面镜像；真正的双击保护看 `busyRef`。 */
  busy: boolean
  busyAttemptId: number | null
  busyAction: TaskPhotosAction | null
  /** 直接选图 / 保存 / 关联的当前阶段；`idle` 表示没有在直接添加。 */
  addPhase: TaskPhotosAddPhase
  taskExists: boolean
  photos: TaskPhoto[]
  candidates: TaskPhotoAttempt[]
  /** 普通读取失败（不代表没有原图）。 */
  loadError: string | null
  /** 写入已提交、但随后列表刷新失败；只能重试刷新，不能重复写。 */
  staleAfterCommit: string | null
  /**
   * 写入已提交、本地列表也读回来了，但 store 的全量快照刷新失败。
   *
   * 这不是写入失败：只提示「已保存」，并禁用写入直到重新读取；绝不引导用户重做。
   */
  commitRefreshWarning: string | null
  notice: TaskPhotosNotice | null
}

export type TaskPhotosLoadMode = 'initial' | 'focus' | 'postCommit' | 'retry'

/** store 的写入结果可能带 `refreshError`（全量快照刷新失败，但写入已提交）。 */
type AttachOutcome = AttachTaskPhotoOutcome & { refreshError?: string | null }
type DetachOutcome = DetachTaskPhotoOutcome & { refreshError?: string | null }

export interface TaskPhotosDeps {
  taskId: number
  state?: Partial<TaskPhotosState>
  listPhotos: (taskId: number) => Promise<TaskPhotosSnapshot>
  listAddable: (taskId: number, limit: number) => Promise<TaskPhotoCandidatesSnapshot>
  attach: (taskId: number, attemptId: number) => Promise<AttachOutcome>
  detach: (taskId: number, attemptId: number) => Promise<DetachOutcome>
  /**
   * 直接添加一张截图：从相册 / 相机拿 URI（只在本机）。
   *
   * 未注入时「直接添加」按钮不显示（测试替身只需要关联流程时不必造选择器）。
   */
  pickFromLibrary?: () => Promise<PhotoPickResult>
  captureFromCamera?: () => Promise<PhotoPickResult>
  /**
   * 把选到的原图**先落盘并登记到全局截图库**（识别之前 / 之后都可以，本页不识别）。
   *
   * 必须复用 `AppStore.archiveOriginal` 这一条既有归档路径，不能另写一套文件写入。
   */
  archiveOriginal?: (
    uri: string,
    source: { width?: number | null; height?: number | null; mimeType?: string | null } | undefined,
    attemptSource: 'LIBRARY' | 'CAMERA',
  ) => Promise<{ ok: boolean; attemptId: number | null; message: string | null }>
  /** 备份恢复代次：选图期间若发生了恢复，绝不把旧 attempt 关联到恢复后的同号任务。 */
  getRestoreEpoch?: () => number
  /** 写入闸门（备份 / 预览 / 恢复 / 只导入截图期间返回 false）。 */
  canWriteNow?: () => boolean
  /** 界面明确写出的候选上限；默认与仓库一致为 300。 */
  candidateLimit?: number
}

export type TaskPhotosActionStart = 'started' | 'busy' | 'blocked' | 'invalid'

export interface TaskPhotosOperation {
  getState: () => TaskPhotosState
  subscribe: (listener: () => void) => () => void
  refresh: () => Promise<void>
  attach: (attemptId: number) => Promise<TaskPhotosActionStart>
  detach: (attemptId: number) => Promise<TaskPhotosActionStart>
  /** 直接打开相册选一张，保存到截图库并显式关联到当前任务。 */
  addFromLibrary: () => Promise<TaskPhotosActionStart>
  /** 直接拍照，保存到截图库并显式关联到当前任务。 */
  addFromCamera: () => Promise<TaskPhotosActionStart>
  setTaskId: (taskId: number) => void
  /**
   * 重新挂上界面（React StrictMode / Fast Refresh 的 setup → cleanup → setup）。
   *
   * 与 `attach(attemptId)`（添加原图）刻意不同名，避免生命周期和业务动作混淆。
   * 重新挂上会推进 epoch、作废旧读回 / 旧写入回调、清掉 busy / loading 与旧快照，
   * 并把 `loaded` 置回 false：必须重新读成功之后才允许写入。旧的在途写入仍可能
   * 完成一次（无法撤回已提交的存储动作），但它不能再改状态或放掉新写入的闸门。
   */
  activate: () => void
  /** 真正卸载 / cleanup 时调用；之后 `activate()` 可以继续用。 */
  dispose: () => void
  /** 当前是否已经挂上（测试 / 诊断用）。 */
  readonly attached: boolean
  readonly busy: boolean
}

/** 默认候选上限（与仓库 / 界面文案保持同一个数字）。 */
export const TASK_PHOTO_CANDIDATE_LIMIT = REPOSITORY_TASK_PHOTO_CANDIDATE_LIMIT

const SAVED_BUT_STALE =
  '这次操作已经保存好了，只是列表没刷新出来。请不要重复操作，点「重新读取列表」即可。'

export function createInitialTaskPhotosState(
  taskId: number,
  overrides: Partial<TaskPhotosState> = {},
): TaskPhotosState {
  return {
    taskId,
    loaded: false,
    loading: false,
    busy: false,
    busyAttemptId: null,
    busyAction: null,
    addPhase: 'idle',
    taskExists: true,
    photos: [],
    candidates: [],
    loadError: null,
    staleAfterCommit: null,
    commitRefreshWarning: null,
    notice: null,
    ...overrides,
  }
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback
}

function failureText(code: TaskPhotoFailureCode | null, fallback: string): string {
  return code === 'TASK_MISSING' ? '这条任务已经不在本机了（可能已被删除），没有写入任何关联。' : fallback
}

export function createTaskPhotosOperation(deps: TaskPhotosDeps): TaskPhotosOperation {
  const candidateLimit = deps.candidateLimit ?? TASK_PHOTO_CANDIDATE_LIMIT
  let currentTaskId = deps.taskId
  let state = createInitialTaskPhotosState(currentTaskId, deps.state)
  const listeners = new Set<() => void>()

  let mounted = true
  /** 切换任务 / 卸载会推进它，旧读回与旧写入结果一律作废。 */
  let epoch = 0
  /** 读取序号：只有最后一次发起的读取能写状态。 */
  let readSeq = 0
  let loadingRef = false
  /** 同步在途闸门（对象包一层，读取时永远看最新值，不依赖 React state）。 */
  const busyRef = { current: false }

  function active(epochAtStart: number, taskIdAtStart: number): boolean {
    return mounted && epoch === epochAtStart && currentTaskId === taskIdAtStart
  }

  function emit(patch: Partial<TaskPhotosState>): void {
    if (!mounted) return
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }

  function emitFull(): void {
    if (!mounted) return
    for (const listener of [...listeners]) listener()
  }

  /** 读取中 / 读取失败 / 提交后待刷新 / 直接添加进行中时一律不允许写入。 */
  function writeBlocked(): boolean {
    return (
      state.staleAfterCommit !== null ||
      state.commitRefreshWarning !== null ||
      state.loadError !== null ||
      state.loading ||
      state.addPhase !== 'idle' ||
      !state.loaded ||
      !state.taskExists
    )
  }

  function committedRefreshWarning(outcome: { refreshError?: string | null }): string | null {
    const text = typeof outcome.refreshError === 'string' ? outcome.refreshError.trim() : ''
    return text.length > 0 ? `原图关联已经保存好了，但任务列表没能刷新：${text}` : null
  }

  async function performLoad(
    taskIdAtStart: number,
    epochAtStart: number,
    mode: TaskPhotosLoadMode,
  ): Promise<void> {
    if (!active(epochAtStart, taskIdAtStart)) return
    // 普通刷新不重入；提交后的强制刷新可以抢在旧读之前。
    if (mode !== 'postCommit' && loadingRef) return
    loadingRef = true
    const seq = readSeq + 1
    readSeq = seq
    emit({
      loading: true,
      loadError: null,
      ...(mode === 'focus' || mode === 'initial' ? { notice: null } : {}),
    })

    try {
      const [photosSnapshot, candidatesSnapshot] = await Promise.all([
        deps.listPhotos(taskIdAtStart),
        deps.listAddable(taskIdAtStart, candidateLimit),
      ])
      if (!active(epochAtStart, taskIdAtStart) || readSeq !== seq) return
      const taskExists = photosSnapshot.taskExists && candidatesSnapshot.taskExists
      emit({
        loaded: true,
        taskExists,
        photos: taskExists ? photosSnapshot.photos : [],
        candidates: taskExists ? candidatesSnapshot.photos : [],
        loadError: null,
        staleAfterCommit: null,
        commitRefreshWarning: null,
      })
    } catch (cause) {
      if (!active(epochAtStart, taskIdAtStart) || readSeq !== seq) return
      if (mode === 'postCommit' || state.staleAfterCommit !== null) {
        // 提交已经成功：只保留「已保存、刷新失败」的提示，不能让用户以为要重做。
        emit({ loaded: true, loadError: null, staleAfterCommit: SAVED_BUT_STALE })
      } else {
        emit({
          loaded: true,
          loadError: `读取这条任务的原图失败：${messageOf(cause, '本机读取出错')}`,
        })
      }
    } finally {
      if (active(epochAtStart, taskIdAtStart) && readSeq === seq) {
        loadingRef = false
        emit({ loading: false })
      }
    }
  }

  async function refresh(): Promise<void> {
    if (!mounted) return
    if (busyRef.current) return
    await performLoad(currentTaskId, epoch, state.staleAfterCommit ? 'retry' : 'focus')
  }

  /**
   * 真正写关联的公共段：`attach()`（从截图库挑一张）与 `addFromPicker()`
   * （直接选一张）都走这里，因此只有**一个** `deps.attach` 调用点。
   *
   * 调用方负责同步 busy 闸门与 finally 释放；这里只处理写入结果与提交后刷新。
   */
  async function performAttachWrite(
    taskIdAtStart: number,
    epochAtStart: number,
    attemptId: number,
    successAddedText: string,
    successIdempotentText: string,
    failurePrefix = '',
  ): Promise<void> {
    try {
      const outcome = await deps.attach(taskIdAtStart, attemptId)
      if (!active(epochAtStart, taskIdAtStart)) return
      if (!outcome.committed) {
        if (outcome.code === 'TASK_MISSING') {
          emit({
            taskExists: false,
            photos: [],
            candidates: [],
            notice: {
              tone: 'error',
              text: `${failurePrefix}${failureText(outcome.code, outcome.reason ?? '添加失败。')}`,
            },
          })
        } else {
          emit({
            notice: {
              tone: 'error',
              text: `${failurePrefix}${outcome.reason ?? '添加失败。'}`,
            },
          })
        }
        return
      }

      emit({
        notice: {
          tone: 'success',
          text: outcome.idempotent ? successIdempotentText : successAddedText,
        },
      })
      await performLoad(taskIdAtStart, epochAtStart, 'postCommit')
      if (!active(epochAtStart, taskIdAtStart)) return
      // store 的全量快照刷新失败 ≠ 写入失败：只提示「已保存、需要重新读取」。
      const warning = committedRefreshWarning(outcome)
      if (warning && state.staleAfterCommit === null) {
        emit({ commitRefreshWarning: warning })
      }
    } catch (cause) {
      if (active(epochAtStart, taskIdAtStart)) {
        emit({
          notice: {
            tone: 'error',
            text: `${failurePrefix}添加失败：${messageOf(cause, '本机写入出错')}`,
          },
        })
      }
    }
  }

  async function attach(attemptId: number): Promise<TaskPhotosActionStart> {
    if (!mounted) return 'blocked'
    if (!isPositiveSafeInteger(attemptId)) return 'invalid'
    if (busyRef.current) return 'busy'
    if (writeBlocked()) return 'blocked'

    const epochAtStart = epoch
    const taskIdAtStart = currentTaskId
    busyRef.current = true
    emit({
      busy: true,
      busyAttemptId: attemptId,
      busyAction: 'attach',
      notice: null,
    })

    try {
      await performAttachWrite(
        taskIdAtStart,
        epochAtStart,
        attemptId,
        '已把这张原图添加到这条任务。',
        '这张图已经关联到这条任务了，没有重复添加。',
      )
      return 'started'
    } finally {
      // 只有「这一次仍属于当前任务」的写入才能解除闸门。
      // 否则旧任务的完成会把新任务正在进行的写入闸门提前放掉。
      if (active(epochAtStart, taskIdAtStart)) {
        busyRef.current = false
        emit({ busy: false, busyAttemptId: null, busyAction: null })
      }
    }
  }

  /**
   * 直接放一张截图：选择器 → **先**复用既有归档路径保存到全局截图库 →
   * 只有仍然是同一条任务、同一恢复代次、写入闸门空闲时，才显式关联到当前任务。
   *
   * 关键边界：
   * - 取消选择是正常结果：不保存、不关联、不报错；
   * - 选到图后即使页面已经离开，字节仍会归档（不会因为用户离开就丢掉输入），
   *   但迟到的回调不会再改界面，也绝不会关联到另一条任务；
   * - 归档成功但关联失败：如实说「已在截图库，但没关联」，不假装成功；
   * - 备份恢复代次变化：不把旧 attempt 关联到恢复后同号任务；
   * - 任务在选图期间被删除：仓库事务拒绝，页面切成「任务不在」，图片仍在截图库。
   */
  async function addFromPicker(kind: 'library' | 'camera'): Promise<TaskPhotosActionStart> {
    if (!mounted) return 'blocked'
    if (busyRef.current) return 'busy'
    if (writeBlocked()) return 'blocked'
    const picker = kind === 'camera' ? deps.captureFromCamera : deps.pickFromLibrary
    if (!picker || !deps.archiveOriginal) return 'invalid'
    if (deps.canWriteNow && !deps.canWriteNow()) {
      emit({
        notice: {
          tone: 'error',
          text: '现在有备份 / 预览 / 恢复 / 只导入截图的动作正在进行，请等它结束再添加截图。',
        },
      })
      return 'blocked'
    }

    const epochAtStart = epoch
    const taskIdAtStart = currentTaskId
    const restoreEpochAtStart = deps.getRestoreEpoch ? deps.getRestoreEpoch() : 0
    busyRef.current = true
    emit({
      busy: true,
      busyAttemptId: null,
      busyAction: 'add',
      addPhase: 'picking',
      notice: null,
    })

    try {
      let picked: PhotoPickResult
      try {
        picked = await picker()
      } catch (cause) {
        if (active(epochAtStart, taskIdAtStart)) {
          emit({
            notice: {
              tone: 'error',
              text: `${kind === 'camera' ? '打开相机' : '打开相册'}失败：${messageOf(cause, '系统选择器出错')}`,
            },
            addPhase: 'idle',
          })
        }
        return 'started'
      }

      if (picked.status === 'cancelled') {
        if (active(epochAtStart, taskIdAtStart)) {
          emit({ notice: { tone: 'success', text: '已取消选择，没有保存或关联任何图片。' }, addPhase: 'idle' })
        }
        return 'started'
      }
      if (picked.status === 'permission' || picked.status === 'error') {
        if (active(epochAtStart, taskIdAtStart)) {
          emit({ notice: { tone: 'error', text: picked.message }, addPhase: 'idle' })
        }
        return 'started'
      }

      // 选到图之后，即使界面已经不在当前任务上，也先把字节存进全局截图库：
      // 这是用户刚刚提交的输入，不能因为页面切换 / 卸载就丢。
      if (active(epochAtStart, taskIdAtStart)) emit({ addPhase: 'saving' })
      const archived = await deps.archiveOriginal(
        picked.uri,
        picked.source,
        kind === 'camera' ? 'CAMERA' : 'LIBRARY',
      )
      if (!active(epochAtStart, taskIdAtStart)) return 'started'
      if (!archived.ok || !isPositiveSafeInteger(archived.attemptId)) {
        emit({
          notice: {
            tone: 'error',
            text: archived.message ?? '这张图没能保存到截图库，也没有添加到这条任务。',
          },
          addPhase: 'idle',
        })
        return 'started'
      }

      if (deps.getRestoreEpoch && deps.getRestoreEpoch() !== restoreEpochAtStart) {
        emit({
          notice: {
            tone: 'error',
            text: '备份恢复已经发生，为避免把旧图关联到恢复后的同号任务，这次没有新建关联。',
          },
          addPhase: 'idle',
        })
        return 'started'
      }
      if (deps.canWriteNow && !deps.canWriteNow()) {
        emit({
          notice: {
            tone: 'error',
            text: '图片已经保存到截图库，但备份 / 导入动作正在进行，所以这次没有关联到任务。',
          },
          addPhase: 'idle',
        })
        // 图片已入库：刷新候选，用户结束备份后可以显式从截图库添加。
        await performLoad(taskIdAtStart, epochAtStart, 'postCommit')
        return 'started'
      }

      // 最后一刻再确认一次恢复代次：检查与 attachPhoto 的闸门检查之间没有 await，
      // 因此恢复不可能在这两行之间插入。
      if (deps.getRestoreEpoch && deps.getRestoreEpoch() !== restoreEpochAtStart) {
        emit({
          notice: {
            tone: 'error',
            text: '备份恢复已经发生，为避免把旧图关联到恢复后的同号任务，这次没有新建关联。',
          },
          addPhase: 'idle',
        })
        return 'started'
      }

      emit({ addPhase: 'attaching' })
      await performAttachWrite(
        taskIdAtStart,
        epochAtStart,
        archived.attemptId,
        '已把这张截图保存到截图库，并关联到这条任务。',
        '这张图已经在截图库里，并且已经关联到这条任务，没有重复添加。',
        '图片已保存到截图库；',
      )
      return 'started'
    } catch (cause) {
      if (active(epochAtStart, taskIdAtStart)) {
        emit({
          notice: { tone: 'error', text: `添加截图失败：${messageOf(cause, '本机操作出错')}` },
          addPhase: 'idle',
        })
      }
      return 'started'
    } finally {
      if (active(epochAtStart, taskIdAtStart)) {
        busyRef.current = false
        emit({ busy: false, busyAttemptId: null, busyAction: null, addPhase: 'idle' })
      }
    }
  }

  async function addFromLibrary(): Promise<TaskPhotosActionStart> {
    return addFromPicker('library')
  }

  async function addFromCamera(): Promise<TaskPhotosActionStart> {
    return addFromPicker('camera')
  }

  async function detach(attemptId: number): Promise<TaskPhotosActionStart> {
    if (!mounted) return 'blocked'
    if (!isPositiveSafeInteger(attemptId)) return 'invalid'
    if (busyRef.current) return 'busy'
    if (writeBlocked()) return 'blocked'
    // 只有本模块手动添加的关联才能解除；历史关系只读。
    const target = state.photos.find((photo) => photo.attempt.id === attemptId)
    if (!target || !target.manual) return 'invalid'

    const epochAtStart = epoch
    const taskIdAtStart = currentTaskId
    busyRef.current = true
    emit({
      busy: true,
      busyAttemptId: attemptId,
      busyAction: 'detach',
      notice: null,
    })

    try {
      const outcome = await deps.detach(taskIdAtStart, attemptId)
      if (!active(epochAtStart, taskIdAtStart)) return 'started'
      if (!outcome.committed) {
        if (outcome.code === 'TASK_MISSING') {
          emit({
            taskExists: false,
            photos: [],
            candidates: [],
            notice: {
              tone: 'error',
              text: failureText(outcome.code, outcome.reason ?? '解除关联失败。'),
            },
          })
        } else {
          emit({ notice: { tone: 'error', text: outcome.reason ?? '解除关联失败。' } })
        }
        return 'started'
      }

      emit({
        notice: {
          tone: 'success',
          text: outcome.removed
            ? '已解除这条任务与原图的关联；原图仍保留在截图库。'
            : '这条关联本来就不在，列表已经是最新。',
        },
      })
      await performLoad(taskIdAtStart, epochAtStart, 'postCommit')
      if (!active(epochAtStart, taskIdAtStart)) return 'started'
      const warning = committedRefreshWarning(outcome)
      if (warning && state.staleAfterCommit === null) {
        emit({ commitRefreshWarning: warning })
      }
      return 'started'
    } catch (cause) {
      if (active(epochAtStart, taskIdAtStart)) {
        emit({ notice: { tone: 'error', text: `解除关联失败：${messageOf(cause, '本机写入出错')}` } })
      }
      return 'started'
    } finally {
      if (active(epochAtStart, taskIdAtStart)) {
        busyRef.current = false
        emit({ busy: false, busyAttemptId: null, busyAction: null })
      }
    }
  }

  function setTaskId(taskId: number): void {
    if (taskId === currentTaskId) return
    const valid = isPositiveSafeInteger(taskId)
    epoch += 1
    readSeq += 1
    loadingRef = false
    busyRef.current = false
    // 无效路由不能把「旧任务」留在可写位置：直接重置成一个不可写的空状态。
    currentTaskId = valid ? taskId : 0
    state = createInitialTaskPhotosState(currentTaskId, valid ? {} : { loaded: true, taskExists: false })
    emitFull()
    if (valid) void refresh()
  }

  /** React effect 的 setup：重新挂上并作废旧一轮的在途回调。 */
  function activate(): void {
    if (mounted) return
    mounted = true
    epoch += 1
    readSeq += 1
    loadingRef = false
    busyRef.current = false
    // 旧快照 / 旧错误 / 旧 busy 全部清掉；`loaded = false` 要求重新读成功后才允许写入。
    state = createInitialTaskPhotosState(currentTaskId)
    emitFull()
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh,
    attach,
    detach,
    addFromLibrary,
    addFromCamera,
    setTaskId,
    activate,
    dispose: () => {
      mounted = false
      epoch += 1
      readSeq += 1
      loadingRef = false
      busyRef.current = false
      state = {
        ...state,
        busy: false,
        busyAttemptId: null,
        busyAction: null,
        addPhase: 'idle',
        loading: false,
      }
      listeners.clear()
    },
    get attached() {
      return mounted
    },
    get busy() {
      return busyRef.current
    },
  }
}
