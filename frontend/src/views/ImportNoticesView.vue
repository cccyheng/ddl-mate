<script setup>
/**
 * 通知导入：粘贴通知文字 / 一次最多 8 张截图 → 浏览器本地文字识别 → 保守规则生成可编辑候选
 * → 勾选后一次保存为任务 + 原通知 + 原图。
 *
 * 诚实边界（界面与代码一致）：
 *   - 文字识别是真的在本机完成（图片不上传、不访问外网），没有任何云端语义抽取；
 *   - 候选由本地保守规则生成：只有完整「日期 + 时刻」才填 DDL，其余留空并提示核对；
 *   - 截止时间一律按上海墙上时间（+08:00）保存，不看运行电脑的时区；
 *   - 未勾选的候选、没有被引用到的来源与图片都不会提交；
 *   - 保存结果未知时只提示去任务列表（新标签页）核对，**不自动重试**，避免重复任务。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ApiError, courseApi, metaApi, taskApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import TimeAssistant from '@/components/TimeAssistant.vue'
import { formatDateTime, fromShanghaiWallClock, toShanghaiWallClock } from '@/utils/datetime'
import { toOffsetDateTime } from '@/ocr/noticeParser'
import {
  OcrCancelledError,
  prepareImage,
  recognizeImage,
  releaseObjectUrl,
  terminateWorker,
  toChineseStatus,
} from '@/ocr/tesseractClient'
import { parseNoticeText } from '@/ocr/noticeParser'
import {
  addManualCandidate,
  createNoticeSource,
  detachSource,
  markEdited,
  mergeSourceCandidates,
} from '@/ocr/candidatePool'
import {
  DEFAULT_LIMITS,
  buildImportPayload,
  formatBytes,
  normalizeLimits,
  rawTextLength,
  toFormData,
  usedFilesBytes,
  validateSelection,
} from '@/ocr/importPayload'
import {
  countableImageCount,
  createSaveSnapshot,
  filterAcceptableFiles,
  findSourceById,
  isSourceAlive as isAliveInList,
  removeSubmittedCandidates,
  removeSubmittedSources,
} from '@/ocr/noticeImportGuards'

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
/** 正文通知整页识别用统一文本块（PSM 6），比稀疏文本更适合成段的正文。 */
const NOTICE_OCR_PSM = 6

/** 内置合成样例（不是用户截图）：用于真实验收本地识别链路。 */
const SAMPLES = [
  { file: 'notice-01-homework.png', name: '示例1 明确截止时间', note: '完整日期 + 时刻，应自动填 DDL' },
  { file: 'notice-02-chat-time.png', name: '示例2 聊天发送时间', note: '发送时间不能被当成截止时间' },
  { file: 'notice-03-two-tasks.png', name: '示例3 一条两条任务', note: '编号任务应拆成两条、互不串联' },
  { file: 'notice-04-email.png', name: '示例4 邮箱提交', note: '邮箱地址不能被标点切碎' },
  { file: 'notice-05-month-day.png', name: '示例5 只有月日', note: '没有年份 → 必须留空提示' },
  { file: 'notice-06-vague.png', name: '示例6 相对时间', note: '明天 / 下节课前 → 必须留空提示' },
  { file: 'notice-07-list.png', name: '示例7 三条清单', note: '批量识别与勾选' },
  { file: 'notice-08-url.png', name: '示例8 链接提交', note: 'URL 原样保留' },
]

const LIMIT_HINT = '一次最多 8 张图片'

const courses = ref([])
const limits = reactive({ ...DEFAULT_LIMITS, maxImagePixels: 12_000_000 })
const limitsWarning = ref('')

const sources = ref([])
const candidates = ref([])
const activeSourceId = ref(null)
const mergeNotice = ref(null) // { sourceId, added, updated, conflicts: [{ id, sourceId, title, fields }], stale }

const ocr = reactive({
  running: false,
  /** 取消请求已发出、引擎还没终止完：这段时间不允许开始新的识别，避免被旧取消覆盖。 */
  cancelling: false,
  sourceId: null,
  progress: 0,
  message: '',
  queue: [],
})

const addingImages = ref(false)
const saving = ref(false)
const unknownResult = ref(false)
const submitError = ref('')
const fieldErrors = ref({})
const result = ref(null)
/** 真正的错误：会让页面顶部渲染成错误样式。 */
const pageError = ref('')
/** 正常操作结果（例如「已移除损坏图片」）：只做普通提示，不能当错误显示。 */
const pageInfo = ref('')

const fileInput = ref(null)
let runId = 0
/** 图片「准备阶段」（解码 / 取示例图）的代次：离页时递增，让在途的 prepare 结果失效。 */
let prepareRunId = 0
let unmounted = false

const activeSource = computed(() => sources.value.find((source) => source.id === activeSourceId.value) ?? null)
const selectedCandidates = computed(() => candidates.value.filter((candidate) => candidate.selected))
const imageCount = computed(() => sources.value.reduce((sum, source) => sum + (source.files?.length ?? 0), 0))
const pendingOcrCount = computed(() => sources.value.filter((source) => source.type === 'IMAGE' && source.ocrStatus !== 'done').length)
/** 导入相关操作全部冻结：保存中、正在准备图片、识别中、取消收尾中都算忙。 */
const busy = computed(() => saving.value || addingImages.value || ocr.running || ocr.cancelling)

const selectedBytes = computed(() => usedFilesBytes({ sources: sources.value, candidates: candidates.value }))
const selectionIssues = computed(() =>
  validateSelection({
    sources: sources.value,
    candidates: candidates.value,
    limits: { ...limits },
    totalBytes: selectedBytes.value,
  }),
)
const canSave = computed(() => !busy.value && selectionIssues.value.length === 0)
const selectedMissingInfo = computed(() =>
  selectedCandidates.value.filter((candidate) => !candidate.deadline || !candidate.courseId),
)
/** 保存前的预览：与真正提交用同一套组装函数，保证「看到什么就提交什么」。 */
const buildPreview = computed(() =>
  buildImportPayload({ sources: sources.value, candidates: candidates.value, limits: { ...limits } }),
)

const typeOptions = [
  { value: 'HOMEWORK', label: '作业' },
  { value: 'LAB', label: '实验' },
  { value: 'REPORT', label: '报告' },
  { value: 'PROJECT', label: '课程设计' },
  { value: 'EXAM', label: '考试' },
  { value: 'PRESENTATION', label: '展示/答辩' },
  { value: 'READING', label: '阅读' },
  { value: 'OTHER', label: '其他' },
]

onMounted(async () => {
  try {
    courses.value = await courseApi.list()
  } catch (error) {
    pageError.value = `课程列表加载失败：${error.message}`
  }
  try {
    Object.assign(limits, normalizeLimits(await metaApi.storageLimits()))
  } catch {
    limitsWarning.value = '暂时没读到服务器的保存上限，先按默认值检查；保存时服务器还会再检查一次。'
  }
})

onBeforeUnmount(() => {
  unmounted = true
  runId += 1
  // 让还在 prepareImage / fetch 示例图的调用失效，避免它们回来时推进列表并留下未释放的 URL
  prepareRunId += 1
  for (const source of sources.value) releaseSourceUrl(source)
  terminateWorker()
})

/* ------------------------------------------------------------ 来源管理 */

function pickFiles() {
  if (busy.value) return
  fileInput.value?.click()
}

function releaseSourceUrl(source) {
  if (source.previewUrl) releaseObjectUrl(source.previewUrl)
  source.previewUrl = ''
}

async function onFileChange(event) {
  const files = [...(event.target.files ?? [])]
  event.target.value = ''
  if (!files.length) return
  await addImageFiles(files)
}

/**
 * 可计数图片数：只统计**真实已经在列表里的图片**（预留额度由调用方作为第二参数传入）。
 * 不能用 addingImages 虚构 1 张：空列表第一次选 8 张就会被算成 8+1 而只收 7 张。
 */
function countedImages(pendingCount = 0) {
  return countableImageCount(sources.value, pendingCount)
}

/** 选择图片：先按服务器上限逐张校验，再加进来源列表并排队识别。 */
async function addImageFiles(files) {
  // 准备阶段（解码）是异步的：先置位，后到的第二次选择会被挡住（不需要再虚构一张占额度）
  if (addingImages.value || saving.value || unmounted) return
  // 本次准备过程的代次：离页 / 取消时失效，迟到的图片不再入列表，并且释放本轮已建的 URL
  const myRun = ++prepareRunId
  addingImages.value = true
  const startedSources = []
  const isStale = () => unmounted || myRun !== prepareRunId
  const releaseStarted = () => {
    for (const source of startedSources) releaseSourceUrl(source)
  }
  try {
    pageError.value = ''
    const { accepted, problems } = filterAcceptableFiles({
      files,
      currentCount: countedImages(),
      limits: { ...limits, imageTypes: IMAGE_TYPES },
    })
    if (problems.length) pageError.value = problems.join('；')

    const created = []
    for (const file of accepted) {
      const source = createNoticeSource({
        name: file.name.replace(/\.[^.]+$/, '').slice(0, 128) || '通知截图',
        type: 'IMAGE',
        rawText: '',
        file,
      })
      source.files = [file]
      startedSources.push(source)
      try {
        const prepared = await prepareImage(file)
        // 准备期间离页 / 失效：不推进列表，并释放本轮已经建好的 blob URL
        if (isStale()) {
          releaseStarted()
          return
        }
        source.previewUrl = URL.createObjectURL(file)
        source.meta = { width: prepared.width, height: prepared.height, scaled: prepared.scaled, size: file.size }
      } catch (error) {
        if (isStale()) {
          releaseStarted()
          return
        }
        // 解码失败：保留来源并标记失败，同时给「移除损坏图片，只保留文字」的出口；
        // 否则用户补了文本也会因为还带着这张解码不了的图而被服务器拒收。
        source.ocrStatus = 'failed'
        source.ocrError = error.message
        source.decodeFailed = true
      }
      const totalBytes = sources.value.reduce((sum, item) => sum + bytesOf(item), 0) + bytesOf(source)
      if (totalBytes > limits.maxRequestSizeBytes) {
        source.ocrError = `加上这张图后总量超过单次上限 ${formatBytes(limits.maxRequestSizeBytes)}，请先少选几张`
        source.ocrStatus = 'failed'
      }
      sources.value = [...sources.value, source]
      if (source.ocrStatus !== 'failed') created.push(source)
    }
    if (isStale()) {
      releaseStarted()
      return
    }
    activeSourceId.value = created[created.length - 1]?.id ?? sources.value[sources.value.length - 1]?.id ?? null
    if (created.length) await processQueue(created)
  } finally {
    addingImages.value = false
  }
}

function bytesOf(source) {
  return (source.files ?? []).reduce((sum, file) => sum + (file.size || 0), 0)
}

/** 载入内置合成样例（标明是示例，仍然走真实识别）。 */
async function loadSample(sample) {
  if (busy.value) return
  pageError.value = ''
  if (imageCount.value >= limits.maxAttachments) {
    pageError.value = `一次最多 ${limits.maxAttachments} 张图片，请先删掉一些来源`
    return
  }
  const source = createNoticeSource({ name: `示例：${sample.name}`, type: 'IMAGE' })
  source.sampleFile = sample.file
  source.note = sample.note
  // fetch / 解码期间可能离页：用代次判定，失效时不入列表并释放本轮新建的 URL
  const myRun = ++prepareRunId
  const isStale = () => unmounted || myRun !== prepareRunId
  try {
    const response = await fetch(`/samples/notices/${sample.file}`)
    if (!response.ok) throw new Error(`示例图读取失败（HTTP ${response.status}）`)
    const blob = await response.blob()
    const file = new File([blob], sample.file, { type: 'image/png' })
    source.file = file
    source.files = [file]
    const prepared = await prepareImage(file)
    if (isStale()) {
      releaseSourceUrl(source)
      return
    }
    source.previewUrl = URL.createObjectURL(file)
    source.meta = { width: prepared.width, height: prepared.height, scaled: prepared.scaled, size: file.size }
  } catch (error) {
    if (isStale()) {
      releaseSourceUrl(source)
      return
    }
    pageError.value = `${error.message}（示例图仅在执行过前端构建后可用）`
    return
  }
  if (isStale()) {
    releaseSourceUrl(source)
    return
  }
  sources.value = [...sources.value, source]
  activeSourceId.value = source.id
  await processQueue([source])
}

function addTextSource() {
  if (busy.value) return
  const source = createNoticeSource({ name: '粘贴的通知文字', type: 'TEXT', rawText: '' })
  sources.value = [...sources.value, source]
  activeSourceId.value = source.id
}

function removeSource(source) {
  if (busy.value) return
  // 让这条来源的在途识别立刻失效（runId 不变也没关系，靠「来源还在不在」判断）
  source.removed = true
  const { kept, dropped } = detachSource(candidates.value, source)
  // 只保留 kept 里仍有其它有效来源的候选；dropped 是「只引用这条来源」的候选，
  // 已经和来源一起删掉了，绝不能再放回候选列表（否则会出现来源 0 条却有候选的幽灵）。
  const survivors = kept.filter((candidate) => (candidate.sourceRefs ?? []).length > 0)
  candidates.value = survivors
  // 真正被删掉的候选数＝dropped（多来源候选保留后不算删除）
  const removedCount = dropped.length
  releaseSourceUrl(source)
  sources.value = sources.value.filter((item) => item !== source)
  if (activeSourceId.value === source.id) {
    activeSourceId.value = sources.value[0]?.id ?? null
  }
  if (removedCount) {
    mergeNotice.value = {
      sourceId: null,
      added: 0,
      updated: 0,
      conflicts: [],
      stale: 0,
      message: `已删除来源「${source.name || '未命名来源'}」，同时移除了只引用它的 ${removedCount} 条候选。`,
    }
  }
  pageInfo.value =
    removedCount > 0
      ? `已删除来源「${source.name || '未命名来源'}」，并移除 ${removedCount} 条只引用它的候选；引用其它来源的候选都保留了。`
      : `已删除来源「${source.name || '未命名来源'}」；没有候选只引用它，候选列表未变。`
}

/** 图片坏了 / 用户不想留原图：移除图片、保留文字，按纯文字来源保存。 */
function dropBrokenImage(source) {
  if (busy.value) return
  releaseSourceUrl(source)
  source.files = []
  source.dropImage = true
  source.decodeFailed = false
  source.ocrStatus = 'empty'
  source.ocrError = ''
  source.ocrMessage = ''
  source.ocrProgress = 0
  // 这是正常的操作结果，不是错误：清掉真正的错误，改用普通信息提示
  pageError.value = ''
  pageInfo.value = `已移除「${source.name || '未命名来源'}」的这张图片：它会按文字来源保存，原图不会再上传（也不会假装原图还在）。`
}

function renameSource(source, name) {
  source.name = name
}

/* ------------------------------------------------------------ 本地 OCR（串行 + 可取消） */

/** 串行处理队列；取消 / 换图 / 离页后旧任务不会写回状态（runId 失效）。 */
async function processQueue(targets = null) {
  if (!targets) {
    targets = sources.value.filter((source) => source.type === 'IMAGE' && source.files?.length && source.ocrStatus === 'idle')
  }
  if (!targets.length) return
  const myRun = ++runId
  ocr.running = true
  // 队列只记 id：sources.value 每次展开赋值后数组里是 Vue proxy，
  // 而 targets 可能是准备阶段攒下的 raw 对象，不能拿对象引用判断存活。
  const targetIds = targets.map((source) => source.id)
  ocr.queue = [...targetIds]
  try {
    for (const targetId of targetIds) {
      if (myRun !== runId || unmounted || ocr.cancelling) return
      // 每次都从 sources.value 按 id 取当前那个响应式对象：
      // 队列里的来源可能已被用户删除（跳过它，余下的继续），也必须拿到 proxy 才能让状态更新被响应。
      const current = findSourceById(sources.value, targetId)
      if (!current) continue
      await recognizeSource(current, myRun)
    }
  } finally {
    if (myRun === runId) {
      ocr.running = false
      ocr.sourceId = null
      ocr.progress = 0
      ocr.message = ''
      ocr.queue = []
    }
  }
}

/** 来源是否还在页面上（按稳定 id）：删除来源后，它在途的识别结果一律作废（不生成悬空候选）。 */
function isSourceAlive(source) {
  if (!source || source.removed) return false
  return isAliveInList(sources.value, source.id)
}

async function recognizeSource(source, myRun) {
  const isCurrent = () => myRun === runId && !unmounted && isSourceAlive(source)
  const file = source.file ?? source.files?.[0]
  if (!file) return
  source.ocrStatus = 'running'
  source.ocrProgress = 0
  source.ocrMessage = '正在准备识别…'
  source.ocrError = ''
  ocr.sourceId = source.id
  try {
    const prepared = await prepareImage(source.previewUrl || file)
    if (!isCurrent()) return
    source.meta = source.meta ?? { width: prepared.width, height: prepared.height, scaled: prepared.scaled }
    const data = await recognizeImage(prepared.image, {
      psm: NOTICE_OCR_PSM,
      onProgress: (value) => {
        if (isCurrent() && ocr.sourceId === source.id) {
          source.ocrProgress = value
          ocr.progress = value
        }
      },
      onStatus: (status) => {
        if (isCurrent() && ocr.sourceId === source.id) {
          source.ocrMessage = toChineseStatus(status)
        }
      },
    })
    if (!isCurrent()) return
    const text = (data?.text ?? '').trim()
    if (!text) {
      source.ocrStatus = 'empty'
      source.ocrError = '这张图没有识别出文字：可以手工补文本，或点「重新识别」再试一次。'
      return
    }
    source.ocrStatus = 'done'
    source.ocrProgress = 1
    source.ocrMessage = ''
    // 识别原文放在「识别原文」框里便于人工核对；解析前先去掉中文字之间被插入的空格
    source.ocrText = text
    applyOcrResult(source, normalizeOcrText(text))
  } catch (error) {
    // 失败分支同样要检查 isCurrent：迟到的异常不能回写到已删除 / 已取消的来源
    if (error instanceof OcrCancelledError || !isCurrent()) return
    source.ocrStatus = 'failed'
    source.ocrError = `${error.message}（可以点「重新识别」，或直接手工补文本继续）`
  } finally {
    if (isCurrent() && ocr.sourceId === source.id) {
      ocr.sourceId = null
      ocr.message = ''
    }
  }
}

/**
 * 识别完成后把文字交给来源：
 *   - 用户没动过原文 → 直接采用（并生成候选）；
 *   - 用户已经手改过原文 → 只把新识别结果留成「待采用」，绝不静默覆盖；
 *   - 已移除损坏图片的纯文字来源 → 文字直接填进原文框，由用户点「用这段文字重新解析」。
 */
function applyOcrResult(source, text) {
  // 只有「确实人工编辑过原文、且这次识别结果不一样」才留成待采用；
  // 其余情况（首次识别 / 自动采用）必须清掉 pending，否则会误报「有新识别文字」「你手改过」。
  if (source.edited && source.rawText?.trim() && source.rawText.trim() !== text) {
    source.pendingOcrText = text
    mergeNotice.value = {
      sourceId: source.id,
      added: 0,
      updated: 0,
      conflicts: [],
      stale: 0,
      message: `「${source.name || '未命名来源'}」重新识别出的文字和你手改过的原文不一样：已保留你的原文，要换成新识别结果请点「采用新识别文字」。`,
    }
    return
  }
  source.pendingOcrText = ''
  source.edited = false
  applyTextToSource(source, text, {
    silent: !candidates.value.some((row) => (row.sourceRefs ?? []).includes(source.ref)),
  })
}

/** 用户确认采用重新识别出的文字（覆盖手改过的原文）。 */
function adoptPendingOcrText(source) {
  if (busy.value || !source?.pendingOcrText) return
  const text = source.pendingOcrText
  source.pendingOcrText = ''
  source.edited = false
  source.rawTextDirty = false
  applyTextToSource(source, text, { manual: false })
}

async function cancelOcr() {
  if (ocr.cancelling) return
  // 先占住「收尾中」：这段时间 pickFiles / 重新识别 / 识别全部 全部被 busy 挡住，
  // 不会出现「新的识别被旧 cancel 覆盖」。
  ocr.cancelling = true
  runId += 1
  try {
    await terminateWorker()
  } finally {
    ocr.running = false
    ocr.cancelling = false
    ocr.sourceId = null
    ocr.progress = 0
    ocr.message = ''
    ocr.queue = []
  }
  for (const source of sources.value) {
    if (source.ocrStatus === 'running') {
      source.ocrStatus = 'idle'
      source.ocrMessage = ''
      source.ocrError = '已取消识别：可以点「重新识别」或直接手工补文本。'
    }
  }
}

async function retrySource(source) {
  if (busy.value || !source.files?.length) return
  const hadText = Boolean(source.rawText?.trim())
  const edited = source.edited
  source.ocrStatus = 'idle'
  await processQueue([source])
  if (hadText && edited) {
    mergeNotice.value = {
      sourceId: source.id,
      added: 0,
      updated: 0,
      conflicts: [],
      stale: 0,
      message: '已重新识别。原文是你手工改过的：解析候选时会保留你的编辑，只有你确认后才覆盖。',
    }
  }
}

async function recognizeAll() {
  if (busy.value) return
  await processQueue(
    sources.value.filter((source) => source.type === 'IMAGE' && source.files?.length && source.ocrStatus !== 'done'),
  )
}

/** 去掉识别结果里被逐字插入的空格（中文之间的空格），保留换行。 */
function normalizeOcrText(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) =>
      line
        .replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '$1')
        .replace(/[ \t]+$/g, '')
        .trim(),
    )
    .join('\n')
    .trim()
}

/* ------------------------------------------------------------ 原文与候选 */

/** 用户在原文框里打字即视为「手改过原文」：重识别不会静默覆盖（不只是点了按钮才算）。 */
function onRawTextInput(source) {
  source.edited = true
  source.rawTextDirty = true
}

/** 用户点「用这段文字重新解析」：按本地规则重新生成候选（保留已编辑字段）。 */
function saveRawText(source) {
  source.edited = true
  source.rawTextDirty = false
  applyTextToSource(source, source.rawText, { manual: true })
}

function applyTextToSource(source, text, { silent = false, manual = false } = {}) {
  source.rawText = text
  const parsed = parseNoticeText(text, {
    courses: courses.value,
    sourceRef: source.ref,
    sourceName: source.name,
    maxTasks: limits.maxTasks,
  })
  const before = candidates.value
  const merged = mergeSourceCandidates(before, source, parsed)
  candidates.value = merged
  if (silent && !before.length) {
    // 第一次识别：直接采用，不需要用户确认
    mergeNotice.value = parsed.length
      ? { sourceId: source.id, added: parsed.length, updated: 0, conflicts: [], stale: 0, message: `识别出 ${parsed.length} 条候选，请核对后再保存。` }
      : { sourceId: source.id, added: 0, updated: 0, conflicts: [], stale: 0, message: '没有从这段文字里提取到候选，可以点「手工添加候选」。' }
    return
  }
  summarizeMerge(source, before, merged, { manual })
}

function summarizeMerge(source, before, after, { manual = false } = {}) {
  const beforeById = new Map(before.map((candidate) => [candidate.id, candidate]))
  let added = 0
  let updated = 0
  const conflicts = []
  let stale = 0
  for (const candidate of after) {
    // 只统计这条来源自己的候选（别的来源的候选不动）
    if (!(candidate.sourceRefs ?? []).includes(source.ref)) continue
    const previous = beforeById.get(candidate.id)
    if (!previous) added += 1
    else if ((candidate.conflictFields ?? []).length) {
      conflicts.push({ id: candidate.id, sourceId: source.id, title: candidate.title, fields: candidate.conflictFields })
    } else if (JSON.stringify(previous) !== JSON.stringify(candidate)) updated += 1
    if (candidate.stale) stale += 1
  }
  const parts = []
  if (added) parts.push(`新增 ${added} 条候选`)
  if (updated) parts.push(`更新 ${updated} 条候选`)
  if (conflicts.length) parts.push(`${conflicts.length} 条候选有你改过的字段被保留（未静默覆盖）`)
  if (stale) parts.push(`${stale} 条候选在新的原文里找不到对应段落，已标记为待确认`)
  mergeNotice.value = {
    sourceId: source.id,
    added,
    updated,
    conflicts,
    stale,
    manual,
    message: parts.length ? `${parts.join('，')}。` : '原文已更新，候选没有变化。',
  }
}

/** 用户确认「用新识别结果覆盖」时，对冲突候选应用新解析结果。 */
function applyNewestToConflicts() {
  const notice = mergeNotice.value
  const conflictSourceIds = [...new Set((notice?.conflicts ?? []).map((conflict) => conflict.sourceId).filter(Boolean))]
  const sourceIds = conflictSourceIds.length ? conflictSourceIds : [notice?.sourceId]
  let applied = false
  for (const sourceId of sourceIds) {
    const source = sources.value.find((item) => item.id === sourceId)
    if (!source) continue
    const parsed = parseNoticeText(source.rawText, {
      courses: courses.value,
      sourceRef: source.ref,
      sourceName: source.name,
      maxTasks: limits.maxTasks,
    })
    candidates.value = mergeSourceCandidates(candidates.value, source, parsed, { applyConflicts: true })
    applied = true
  }
  if (!applied) return
  mergeNotice.value = { ...notice, conflicts: [], message: '已用最新识别结果覆盖这些字段。' }
}

function removeCandidate(candidate) {
  if (busy.value) return
  candidates.value = candidates.value.filter((item) => item !== candidate)
}

function addManual() {
  if (busy.value) return
  const ref = activeSource.value?.ref ?? sources.value[0]?.ref
  if (!ref) {
    pageError.value = '请先添加一条通知来源（图片或文字），候选必须来自某条通知。'
    return
  }
  candidates.value = addManualCandidate(candidates.value, ref)
}

function onFieldEdit(candidate, field) {
  markEdited(candidate, field)
}

function onDeadlineInput(candidate, value) {
  // datetime-local 给的是上海墙上时间，原样存（保存时统一补 +08:00）
  candidate.deadline = fromShanghaiWallClock(value)
  markEdited(candidate, 'deadline')
}

/**
 * 时间助手「采用此时间」：只改这一条候选的截止时间，并复用现有 markEdited，
 * 让候选的生成身份 / 来源 / 冲突 / stale / 防重写规则完全不变。
 * 助手本身不会自动从通知里猜语义，必须由用户手输短语 + 显式采用。
 */
function onAssistantDeadline(candidate, payload) {
  if (!payload?.deadline) return
  candidate.deadline = payload.deadline
  markEdited(candidate, 'deadline')
}

function toggleAll(selected) {
  if (busy.value) return
  for (const candidate of candidates.value) candidate.selected = selected
}

function discardStale() {
  if (busy.value) return
  candidates.value = candidates.value.filter((candidate) => !candidate.stale)
  mergeNotice.value = { sourceId: null, added: 0, updated: 0, conflicts: [], stale: 0, message: '已删除在新原文里找不到对应段落的候选。' }
}

/* ------------------------------------------------------------ 保存 */

async function submit() {
  if (saving.value) return
  submitError.value = ''
  fieldErrors.value = {}
  unknownResult.value = false

  const issues = selectionIssues.value
  if (issues.length) {
    submitError.value = issues.map((issue) => issue.message).join('；')
    return
  }
  // 冻结快照：这次请求到底提交了哪些候选与来源，成功后只按它清理
  const snapshot = createSaveSnapshot(candidates.value, sources.value)
  const { payload, files } = buildImportPayload({ sources: sources.value, candidates: candidates.value, limits })
  saving.value = true
  try {
    const formData = toFormData(payload, files)
    const response = await taskApi.importNotices(formData)
    result.value = response
    // 保存成功后按快照清理；保存期间界面已冻结，不会误删没提交的草稿
    candidates.value = removeSubmittedCandidates(candidates.value, snapshot)
    const keptRefs = new Set(candidates.value.flatMap((candidate) => candidate.sourceRefs ?? []))
    for (const source of removeSubmittedSources(sources.value, snapshot)) {
      if (keptRefs.has(source.ref)) continue
      releaseSourceUrl(source)
      source.removed = true
      sources.value = sources.value.filter((item) => item !== source)
    }
    if (!sources.value.some((source) => source.id === activeSourceId.value)) {
      activeSourceId.value = sources.value[0]?.id ?? null
    }
  } catch (error) {
    if (error instanceof ApiError) {
      fieldErrors.value = error.fieldErrorMap()
      submitError.value = error.message
      if (error.status === 0) unknownResult.value = true
    } else {
      submitError.value = error.message
      unknownResult.value = true
    }
  } finally {
    saving.value = false
  }
}

function resetAfterSave() {
  result.value = null
  unknownResult.value = false
  submitError.value = ''
  for (const source of sources.value) releaseSourceUrl(source)
  sources.value = []
  candidates.value = []
  mergeNotice.value = null
  activeSourceId.value = null
}

/** 原文长度信息：超长时在页面上挡住保存并提示，绝不截断。 */
function rawTextInfo(source) {
  const length = rawTextLength(source.rawText)
  const max = limits.maxRawTextLength ?? DEFAULT_LIMITS.maxRawTextLength
  return { length, max, over: length > max }
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>从通知创建任务</h1>
        <p class="page-head__sub">
          粘贴通知文字或选最多 8 张截图 → <strong>文字识别在本机完成</strong> → 核对后保存为任务
        </p>
      </div>
      <div class="row">
        <RouterLink class="btn" to="/tasks">返回 DDL 列表</RouterLink>
        <RouterLink class="btn" to="/sources">
          <AppIcon name="inbox" :size="17" />
          原通知
        </RouterLink>
      </div>
    </div>

    <div class="alert alert--warn" style="margin-bottom: 16px">
      <strong>文字识别在本机完成，核对后保存</strong>；不确定的时间请手动补充。
      截图不会被上传去做识别，也不访问外网。
      <details style="margin-top: 6px">
        <summary class="small">识别规则与技术说明</summary>
        <p class="small" style="margin: 6px 0 0">
          候选由本地保守规则提取：只有原文里出现完整「日期 + 时刻」才会填截止时间，
          「明天 / 下周五 / 下节课前 / 只有月日」一律留空并提示核对，不会拿今天或 23:59 去猜。
          截止时间按北京时间（+08:00）保存。也可以点「粘贴文字来源」直接手打通知内容。
          <strong>截止时间旁边还有「时间助手」</strong>：手工写一句简短时间短语（例如「下周五 18:00」或
          「下节课前」，后者需要先选课程），助手才会给出建议，<strong>点「采用此时间」才写进候选</strong>；
          它不会自动从整段通知里猜语义。
        </p>
      </details>
    </div>

    <ErrorState v-if="pageError" :message="pageError" />
    <div v-if="pageInfo" class="alert" style="margin-bottom: 16px">
      {{ pageInfo }}
      <button class="btn btn--sm btn--ghost" type="button" style="margin-left: 8px" @click="pageInfo = ''">知道了</button>
    </div>
    <div v-if="limitsWarning" class="alert alert--warn" style="margin-bottom: 16px">{{ limitsWarning }}</div>

    <!-- ① 选择通知来源 -->
    <section class="card">
      <div class="card__head">
        <div>
          <div class="card__title">
            <AppIcon name="inbox" :size="18" />
            ① 添加通知来源（{{ sources.length }} 条 / 图片 {{ imageCount }}/{{ limits.maxAttachments }}）
          </div>
          <p class="card__hint">
            支持 PNG / JPEG / WebP，单张不超过 {{ formatBytes(limits.maxFileSizeBytes) }}，
            单次总量不超过 {{ formatBytes(limits.maxRequestSizeBytes) }}。{{ LIMIT_HINT }}，识别会一张张来，随时可以取消。
          </p>
        </div>
        <div class="row">
          <button class="btn btn--primary" type="button" :disabled="busy" @click="pickFiles">选择图片</button>
          <button class="btn" type="button" :disabled="busy" @click="addTextSource">粘贴文字来源</button>
          <button
            class="btn"
            type="button"
            :disabled="busy || !sources.some((item) => item.type === 'IMAGE' && item.files?.length && item.ocrStatus !== 'done')"
            @click="recognizeAll"
          >
            识别全部未完成
          </button>
          <button v-if="ocr.running || ocr.cancelling" class="btn btn--danger" type="button" :disabled="ocr.cancelling" @click="cancelOcr">
            {{ ocr.cancelling ? '正在取消…' : '取消识别' }}
          </button>
        </div>
      </div>

      <input
        ref="fileInput"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        @change="onFileChange"
      />

      <details class="notice-samples">
        <summary class="small">试用示例（8 张合成通知图，点开后可一键载入）</summary>
        <div class="row" style="margin-top: 8px">
          <button
            v-for="sample in SAMPLES"
            :key="sample.file"
            class="btn btn--sm"
            type="button"
            :disabled="busy"
            :title="sample.note"
            @click="loadSample(sample)"
          >
            {{ sample.name }}
          </button>
        </div>
      </details>

      <div v-if="ocr.running" class="stack" style="margin-top: 12px">
        <div class="progress"><div class="progress__bar" :style="{ width: `${Math.round(ocr.progress * 100)}%` }" /></div>
        <span class="small muted">
          正在识别第 {{ Math.max(1, ocr.queue.indexOf(ocr.sourceId) + 1) }} / {{ ocr.queue.length }} 张：{{ ocr.message || '准备中…' }}
        </span>
      </div>

      <p v-if="!sources.length" class="muted small" style="margin-top: 12px">
        还没有来源。选几张截图，或点「粘贴文字来源」把老师原话粘进来。
      </p>

      <ul v-else class="source-list">
        <li v-for="source in sources" :key="source.id" class="source-item" :class="{ 'source-item--active': source.id === activeSourceId }">
          <div class="source-item__head">
            <button class="btn btn--sm btn--ghost" type="button" @click="activeSourceId = source.id">
              {{ source.id === activeSourceId ? '▼' : '▶' }}
            </button>
            <input
              :value="source.name"
              class="source-item__name"
              type="text"
              maxlength="128"
              :disabled="saving"
              aria-label="来源名称"
              @input="renameSource(source, $event.target.value)"
            />
            <span class="badge" :class="{
              'badge--success': source.ocrStatus === 'done',
              'badge--danger': source.ocrStatus === 'failed' || source.ocrStatus === 'empty',
              'badge--warn': source.ocrStatus === 'running',
            }">
              {{ source.type === 'TEXT' ? '粘贴文字' : {
                idle: '待识别', running: '识别中', done: '已识别', failed: '识别失败', empty: '没有文字',
              }[source.ocrStatus] || source.ocrStatus }}
            </span>
            <span v-if="source.pendingOcrText" class="badge badge--warn">有新的识别文字待你确认</span>
            <span class="spacer" />
            <button
              v-if="source.type === 'IMAGE' && source.files?.length"
              class="btn btn--sm"
              type="button"
              :disabled="busy"
              @click="retrySource(source)"
            >
              重新识别
            </button>
            <button class="btn btn--sm btn--danger" type="button" :disabled="busy" @click="removeSource(source)">删除来源</button>
          </div>

          <div v-if="source.id === activeSourceId" class="source-item__body">
            <div v-if="source.type === 'IMAGE' && source.files?.length" class="row" style="align-items: flex-start; gap: 12px">
              <img v-if="source.previewUrl" class="source-thumb" :src="source.previewUrl" :alt="`通知截图 ${source.name}`" />
              <div class="stack" style="flex: 1; min-width: 220px">
                <span class="small muted">
                  {{ source.files?.[0]?.name }}
                  <template v-if="source.meta">· {{ source.meta.width }}×{{ source.meta.height }}<template v-if="source.meta.scaled">（已缩放识别）</template></template>
                  <template v-if="source.files?.[0]?.size">· {{ formatBytes(source.files[0].size) }}</template>
                </span>
                <span v-if="source.note" class="small muted">示例说明：{{ source.note }}（合成图，不是真实聊天记录）</span>
                <div v-if="source.ocrStatus === 'running'" class="progress">
                  <div class="progress__bar" :style="{ width: `${Math.round((source.ocrProgress || 0) * 100)}%` }" />
                </div>
                <span v-if="source.ocrError" class="small" style="color: var(--danger)">{{ source.ocrError }}</span>
                <span v-if="source.ocrMessage" class="small muted">{{ source.ocrMessage }}</span>
              </div>
            </div>
            <p v-else-if="source.type === 'IMAGE'" class="small muted" style="margin: 0">
              这张图片已经移除：下面这段文字会作为文字来源保存，原图不会再上传。
            </p>

            <label class="field" style="margin-top: 10px">
              <span class="field__label">识别原文（可以直接改；改完点「用这段文字重新解析」）</span>
              <textarea
                v-model="source.rawText"
                rows="5"
                :disabled="saving"
                :placeholder="source.type === 'TEXT' ? '把通知原文粘到这里，例如：请于 2026年10月15日 22:00 前提交实验报告' : '识别结果会出现在这里，识别不准可以直接改'"
                @input="onRawTextInput(source)"
              />
              <span class="field__hint">
                <template v-if="rawTextInfo(source).over">
                  <strong style="color: var(--danger)">
                    原文 {{ rawTextInfo(source).length }} 字，超过单条上限 {{ rawTextInfo(source).max }} 字：请删到上限以内再保存，原文不会被截断。
                  </strong>
                </template>
                <template v-else>
                  原文 {{ rawTextInfo(source).length }} / {{ rawTextInfo(source).max }} 字。原文会随任务一起保存（原通知），任务详情里能回看。
                </template>
              </span>
            </label>
            <div v-if="source.pendingOcrText" class="alert alert--warn" style="margin-top: 8px">
              又识别出了一版文字。你手改过的原文已保留，确认要换成新识别的文字再点右边的「采用新识别文字」。
            </div>
            <div class="row">
              <button class="btn btn--sm btn--primary" type="button" :disabled="saving || rawTextInfo(source).over" @click="saveRawText(source)">
                用这段文字重新解析
              </button>
              <button
                v-if="source.pendingOcrText"
                class="btn btn--sm"
                type="button"
                :disabled="busy"
                @click="adoptPendingOcrText(source)"
              >
                采用新识别文字
              </button>
              <button
                v-if="source.type === 'IMAGE' && source.files?.length"
                class="btn btn--sm btn--danger"
                type="button"
                :disabled="busy"
                @click="dropBrokenImage(source)"
              >
                移除这张图片，只保留文字
              </button>
            </div>
          </div>
        </li>
      </ul>
    </section>

    <!-- ② 候选 -->
    <section class="card">
      <div class="card__head">
        <div>
          <div class="card__title">
            <AppIcon name="list" :size="18" />
            ② 核对任务候选（{{ candidates.length }} 条，已勾选 {{ selectedCandidates.length }} 条）
          </div>
          <p class="card__hint">
            候选只是草稿：标题、课程、类型、截止时间、提交要求都可以改。
            没勾选的候选不会保存；缺截止时间或没关联课程会提示，但允许留空保存（任务里显示「待补充」）。
            每条候选旁都有可折叠的「时间助手」：手工输入简短时间短语、确认参考时间与课程后，点「采用此时间」才会更新该候选。
          </p>
        </div>
        <div class="row">
          <button class="btn btn--sm" type="button" :disabled="busy" @click="toggleAll(true)">全选</button>
          <button class="btn btn--sm" type="button" :disabled="busy" @click="toggleAll(false)">全不选</button>
          <button class="btn btn--sm btn--primary" type="button" :disabled="busy" @click="addManual">手工添加候选</button>
        </div>
      </div>

      <div v-if="mergeNotice" class="alert alert--warn" style="margin-bottom: 12px">
        <div>{{ mergeNotice.message }}</div>
        <ul v-if="mergeNotice.conflicts?.length" style="margin: 6px 0 0; padding-left: 18px">
          <li v-for="conflict in mergeNotice.conflicts" :key="conflict.id">
            「{{ conflict.title || '未命名候选' }}」你改过：{{ conflict.fields.join('、') }}。已保留你的版本，需要覆盖请点下面的按钮。
          </li>
        </ul>
        <div class="row" style="margin-top: 8px">
          <button v-if="mergeNotice.conflicts?.length" class="btn btn--sm" type="button" @click="applyNewestToConflicts">
            用最新识别结果覆盖这些字段
          </button>
          <button v-if="mergeNotice.stale" class="btn btn--sm btn--danger" type="button" @click="discardStale">
            删除找不到段落的老候选（{{ mergeNotice.stale }} 条）
          </button>
          <button class="btn btn--sm btn--ghost" type="button" @click="mergeNotice = null">知道了</button>
        </div>
      </div>

      <p v-if="!candidates.length" class="muted small">
        还没有候选。识别图片或粘贴文字后会自动生成；也可以点「手工添加候选」自己填。
      </p>

      <div v-else class="candidate-cards">
        <article
          v-for="candidate in candidates"
          :key="candidate.id"
          class="candidate-card"
          :class="{ 'candidate-card--unselected': !candidate.selected, 'candidate-card--stale': candidate.stale }"
        >
          <div class="candidate-card__head">
            <label class="checkbox-row">
              <input v-model="candidate.selected" type="checkbox" :disabled="saving" :aria-label="`勾选 ${candidate.title || '候选'}`" />
              <span>保存这条</span>
            </label>
            <span v-if="candidate.manual" class="badge badge--muted">手工添加</span>
            <span v-if="candidate.stale" class="badge badge--warn">原文已改，待确认</span>
            <span v-if="candidate.sourceRefs?.length" class="badge badge--primary">
              来源：{{ candidate.sourceRefs.map((ref) => sources.find((item) => item.ref === ref)?.name || '已删除的来源').join('、') }}
            </span>
            <span class="spacer" />
            <button class="btn btn--sm btn--danger" type="button" :disabled="saving" @click="removeCandidate(candidate)">删除候选</button>
          </div>

          <div class="form-grid">
            <label class="field">
              <span class="field__label">标题</span>
              <input v-model="candidate.title" type="text" maxlength="200" :disabled="saving" @input="onFieldEdit(candidate, 'title')" />
            </label>
            <label class="field">
              <span class="field__label">类型</span>
              <select v-model="candidate.type" :disabled="saving" @change="onFieldEdit(candidate, 'type')">
                <option v-for="option in typeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <label class="field">
              <span class="field__label">课程</span>
              <select v-model="candidate.courseId" :disabled="saving" @change="onFieldEdit(candidate, 'courseId')">
                <option :value="null">未关联课程（可留空）</option>
                <option v-for="course in courses" :key="course.id" :value="course.id">{{ course.code }} {{ course.name }}</option>
              </select>
              <span v-if="!candidate.courseId" class="field__hint">没有和已有课程完全同名，所以留空让你确认</span>
            </label>
            <label class="field">
              <span class="field__label">截止时间</span>
              <input
                :value="toShanghaiWallClock(candidate.deadline)"
                type="datetime-local"
                :disabled="saving"
                @change="onDeadlineInput(candidate, $event.target.value)"
              />
              <span class="field__hint">
                <template v-if="candidate.deadline">保存为 {{ toOffsetDateTime(candidate.deadline) }}（北京时间 +08:00）</template>
                <template v-else>留空表示「待补充」，不会替你猜时间</template>
              </span>
            </label>
            <div class="form-grid--full">
              <TimeAssistant
                :courses="courses"
                :course-id="candidate.courseId"
                :deadline="toShanghaiWallClock(candidate.deadline)"
                :disabled="saving"
                compact
                summary="时间助手：手工写一句时间短语（可选）"
                @apply="(payload) => onAssistantDeadline(candidate, payload)"
              />
            </div>
            <label class="field">
              <span class="field__label">提交要求</span>
              <input
                v-model="candidate.submitRequirement"
                type="text"
                maxlength="500"
                :disabled="saving"
                @input="onFieldEdit(candidate, 'submitRequirement')"
              />
            </label>
            <label class="field">
              <span class="field__label">提交方式</span>
              <input
                v-model="candidate.submitMethod"
                type="text"
                maxlength="128"
                :disabled="saving"
                @input="onFieldEdit(candidate, 'submitMethod')"
              />
            </label>
          </div>

          <ul v-if="candidate.hints?.length" class="candidate-hints">
            <li v-for="(hint, index) in candidate.hints" :key="index">{{ hint }}</li>
          </ul>
          <details v-if="candidate.origin?.rawText" class="small">
            <summary>查看这条候选对应的原文片段</summary>
            <pre class="raw-text" style="margin-top: 6px">{{ candidate.origin.rawText }}</pre>
          </details>
        </article>
      </div>
    </section>

    <!-- ③ 保存 -->
    <section class="card">
      <div class="card__head">
        <div>
          <div class="card__title">
            <AppIcon name="check" :size="18" />
            ③ 确认保存（{{ selectedCandidates.length }} 条任务）
          </div>
          <p class="card__hint">
            一次保存：你勾选的任务 + 这些任务引用的原通知与图片。同一张图被多条任务引用时会各存一份。
            保存前不会创建任何任务，选图和识别阶段也不会上传图片。
          </p>
        </div>
        <div class="row">
          <span class="small muted">本次会上传共 {{ buildPreview.files.length }} 张图片 · {{ formatBytes(selectedBytes) }}</span>
          <button class="btn btn--primary" type="button" :disabled="!canSave" @click="submit">
            {{ saving ? '保存中…' : '确认保存为任务' }}
          </button>
        </div>
      </div>

      <div v-if="saving" class="alert" style="margin-bottom: 12px">
        正在保存：这期间页面上的勾选、来源和候选都被锁定，等结果出来再改，避免删掉还没保存的草稿。
      </div>

      <div v-if="!selectedCandidates.length" class="alert" style="margin-bottom: 12px">
        一条候选都没勾选：点保存不会创建任何数据（不创建任务、不保存来源、不上传图片）。
      </div>

      <div v-if="selectedMissingInfo.length" class="alert alert--warn" style="margin-bottom: 12px">
        以下候选信息不完整，将按「待补充」保存：
        <ul style="margin: 6px 0 0; padding-left: 18px">
          <li v-for="candidate in selectedMissingInfo" :key="candidate.id">
            {{ candidate.title || '未命名候选' }}：{{ [!candidate.deadline ? '缺截止时间' : '', !candidate.courseId ? '未关联课程' : ''].filter(Boolean).join('，') }}
          </li>
        </ul>
      </div>

      <div v-if="submitError" class="alert alert--danger" style="margin-bottom: 12px">
        {{ submitError }}
        <ul v-if="Object.keys(fieldErrors).length" style="margin: 6px 0 0; padding-left: 18px">
          <li v-for="(message, field) in fieldErrors" :key="field">{{ field }}：{{ message }}</li>
        </ul>
      </div>

      <div v-if="unknownResult" class="alert alert--warn" style="margin-bottom: 12px">
        <strong>这次保存的结果不明确（网络中断，或者服务器没有回应）。</strong>
        为避免创建重复任务，这里<strong>不会自动重试</strong>：请先在新标签页打开
        <a href="/tasks" target="_blank" rel="noopener noreferrer">任务列表</a>
        看看任务是不是已经创建（新标签页打开，这个页面上的草稿不会被清掉）；
        如果确认没写入，再回来重新保存。
      </div>

      <ul v-if="selectionIssues.length" class="candidate-hints">
        <li v-for="(issue, index) in selectionIssues" :key="index">{{ issue.message }}</li>
      </ul>
      <p v-else-if="selectedCandidates.length" class="small muted" style="margin: 0">
        可以保存了：会创建 {{ selectedCandidates.length }} 条任务、保存 {{ buildPreview.payload.sources.length }} 条原通知、上传 {{ buildPreview.files.length }} 张图片。
      </p>
    </section>

    <!-- 保存成功：真实任务详情入口 -->
    <section v-if="result" class="card">
      <div class="card__head">
        <div>
          <div class="card__title">✅ 保存成功</div>
          <p class="card__hint">
            已创建 {{ result.createdTasks }} 条任务、{{ result.createdSources }} 条原通知、{{ result.createdAttachments }} 张图片附件。
          </p>
        </div>
        <div class="row">
          <RouterLink class="btn btn--primary" to="/tasks">去任务列表</RouterLink>
          <RouterLink class="btn" to="/calendar">去看日历</RouterLink>
          <button class="btn" type="button" @click="resetAfterSave">继续导入下一条通知</button>
        </div>
      </div>
      <ul style="margin: 0; padding-left: 18px">
        <li v-for="task in result.tasks" :key="task.id" class="small">
          <RouterLink :to="`/tasks/${task.id}`">打开任务详情：{{ task.title }}</RouterLink>
          <span class="muted">
            （{{ task.deadline ? formatDateTime(task.deadline) : '未设置截止时间' }} ·
            来源 {{ task.sourceCount ?? 0 }} 条 · 附件 {{ task.attachments?.length ?? 0 }} 张）
          </span>
        </li>
      </ul>
      <ul v-if="result.notices?.length" class="small muted" style="margin: 8px 0 0; padding-left: 18px">
        <li v-for="(notice, index) in result.notices" :key="index">{{ notice }}</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.notice-samples {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 10px;
  background: var(--surface-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.source-list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.source-item {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px;
  background: var(--surface);
}

.source-item--active {
  border-color: var(--primary);
  box-shadow: inset 0 0 0 1px var(--primary-soft);
}

.source-item__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.source-item__name {
  flex: 1;
  min-width: 150px;
  max-width: 320px;
  padding: 5px 8px;
  font-size: 0.9rem;
}

.source-item__body {
  margin-top: 10px;
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}

.source-thumb {
  width: 130px;
  max-width: 40vw;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.candidate-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.candidate-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  background: var(--surface);
}

.candidate-card--unselected {
  opacity: 0.62;
}

.candidate-card--stale {
  border-color: var(--warn-line);
  background: var(--warn-soft);
}

.candidate-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.candidate-hints {
  margin: 8px 0 0;
  padding-left: 18px;
  color: var(--warn);
  font-size: 0.82rem;
}
</style>
