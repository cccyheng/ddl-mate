<script setup>
/**
 * 照片导入课表：选择课表照片 → 浏览器本地 OCR（中文+英文）→ 可编辑候选 → 勾选确认后批量写库。
 *
 * 要点：
 *   - OCR 完全在浏览器里跑，图片不上传，运行期不访问外网（资源来自 /tesseract）；
 *   - 识别结果只是**候选**：缺字段一律留空并提示，不臆测上课时间；
 *   - 整图识别 + 框选单门课重识别（可追加也可替换指定候选，不会丢掉已确认的其它课）；
 *   - 识别不理想时可以查看 OCR 原文并手工补候选（手工入口始终可见）；
 *   - 确认时调用后端批量导入接口（单事务），成功提示独立显示，失败不会留下半截数据。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ApiError, courseApi, scheduleApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import { weekdayOptions } from '@/utils/datetime'
import { flattenOcrLines, parseTimetable } from '@/ocr/timetableParser'
import {
  OcrCancelledError,
  cropImage,
  imageToImageData,
  prepareImage,
  recognizeImage,
  releaseObjectUrl,
  terminateWorker,
  toChineseStatus,
  validateImageFile,
} from '@/ocr/tesseractClient'
import { recognizeTimetableLayout } from '@/ocr/timetableLayout'
import { weekViewImportGate } from '@/ocr/importScope'
import { importBlockReason } from '@/ocr/importValidation'
import { parseAcademicTimetable } from '@/import/academicTimetable'
import { parseAcademicExams, PENDING_EXAMS_KEY } from '@/import/academicExams'
import { isTrustedSchoolOrigin, MAX_SCHOOL_PAYLOAD_CHARS } from '@/import/schoolBookmarklet'
import { calibrationFromRows, loadCalibrationRows } from '@/domain/teachingWeekStore'
import { currentTeachingWeekOn, todayInBeijing } from '@domain/teachingWeek'

const router = useRouter()

const fileInput = ref(null)
const dataFileInput = ref(null)
/** 候选来自教务数据文件（而不是图片识别）时的来源说明。 */
const dataSource = ref('')
/** 以导入数据为准：已有的同名课程改用数据里的教师，并用数据替换它们原来的课表。 */
const replaceWithData = ref(true)
const MAX_DATA_FILE_BYTES = 30 * 1024 * 1024
const imageUrl = ref('')
const imageMeta = ref(null) // { name, width, height, scaled, size }
const ocrImage = ref(null) // 真正交给识别的 Canvas / 图片（可能是缩放后的）

const ocrState = reactive({
  running: false,
  progress: 0,
  status: '',
  rawText: '',
  layout: '',
  warnings: [],
  candidates: [],
  error: '',
  /** 周视图信息：{ week, confirmed } —— 只有手机周视图截图才会有 */
  weekView: null,
})

/** 周视图导入确认：核对实际填写的教学周范围与单双周后才允许写库。 */
const weekViewConfirmed = ref(false)

const semesterStartDate = ref('')
/** 来自「教学周校准」的学期起点（今天是第几周），用来自动填写并提示来源。 */
const calibratedStart = ref(null)
/** 周视图一键改为整学期：第 1 周到第 N 周。 */
const semesterEndWeek = ref(16)
const courses = ref([])
const submitting = ref(false)
const submitError = ref('')
const submitFieldErrors = ref({})
const notices = ref([])
const result = ref(null)

/* 框选识别结果的处理方式：'append' 追加，或指定候选 id 做替换 */
const regionTarget = ref('append')
const selection = reactive({ active: false, x: 0, y: 0, width: 0, height: 0 })
let dragStart = null

/**
 * 识别任务序号：取消 / 换图 / 离开页面时自增。
 * 只有序号仍然匹配的任务才允许更新界面，避免旧任务的回调或 finally 覆盖新任务状态。
 */
let runId = 0
let unmounted = false
let candidateSequence = 0

const patternOptions = [
  { value: 'ALL', label: '每周' },
  { value: 'ODD', label: '单周' },
  { value: 'EVEN', label: '双周' },
]

const selectedCandidates = computed(() => ocrState.candidates.filter((item) => item.selected))

/**
 * 来源为周视图的候选必须填写有效的教学周和学期第一周周一，
 * 并显式核对实际导入范围；清空起止周或框选重识别都不能绕过此约束。
 * 图上没有年份，不能替用户反算学期起点。
 * 普通白底表格/列表照片（没有周视图信息）不受影响。
 */
const weekViewGate = computed(() => weekViewImportGate(selectedCandidates.value, {
  confirmed: weekViewConfirmed.value, semesterStartDate: semesterStartDate.value,
}))
const weekViewContext = computed(() => ocrState.weekView ||
  ocrState.candidates.find(row => row.sourceWeekView)?.sourceWeekView)
watch(() => JSON.stringify([semesterStartDate.value, selectedCandidates.value
  .filter(row => row.sourceWeekView)
  .map(row => [row.id, row.startWeek, row.endWeek, row.weekPattern])]), () => { weekViewConfirmed.value = false })

/** 第一条挡住导入的原因；空串表示可以导入。按钮旁实时显示，点击时同样用它检查。 */
const blockReason = computed(() => importBlockReason(selectedCandidates.value, {
  courses: courses.value, gate: weekViewGate.value, semesterStartDate: semesterStartDate.value,
}))
/** 已有课程里不在导入数据中的（多半是照片识别时名字认错了），提示用户自行清理。 */
const coursesNotInData = computed(() => {
  if (!dataSource.value) return []
  const names = new Set(ocrState.candidates.map((row) => normalizeName(row.courseName || row.name)))
  const ids = new Set(ocrState.candidates.filter((row) => row.existingCourseId).map((row) => row.existingCourseId))
  return courses.value.filter((course) => !ids.has(course.id) && !names.has(normalizeName(course.name)))
})

const canSubmit = computed(() => !submitting.value && !ocrState.running && !blockReason.value)

/** 代码是否已被占用（已有课程或本批候选）。 */
function codeTaken(code, ignoreCandidate) {
  const target = String(code || '').trim().toLowerCase()
  if (!target) return true
  if (courses.value.some((course) => String(course.code || '').toLowerCase() === target)) return true
  return ocrState.candidates.some(
    (candidate) => candidate !== ignoreCandidate && String(candidate.code || '').trim().toLowerCase() === target,
  )
}

onMounted(async () => {
  try {
    courses.value = await courseApi.list()
  } catch (error) {
    ocrState.error = error.message
  }
  // 已在「教学周校准」里设过"本周是第几周"：直接用它推出的学期第一周周一，不用再手填
  try {
    const calibration = calibrationFromRows(await loadCalibrationRows())
    if (calibration) {
      calibratedStart.value = {
        monday: calibration.semesterStartMonday,
        week: currentTeachingWeekOn(calibration, todayInBeijing()),
      }
      if (!semesterStartDate.value) semesterStartDate.value = calibration.semesterStartMonday
    }
  } catch {
    /* 读不到校准就保持手填 */
  }
})

/* ------------------------------------------------ 课程抓取（书签发来的课表和考试） */

const route = useRoute()
/** '' | 'waiting' | 'received' | 'error' | 'no-opener' | 'timeout' */
const schoolStatus = ref('')
const schoolMessage = ref('')
let schoolTimer = null
let schoolDeadline = 0

function stopSchoolHandshake() {
  if (schoolTimer) window.clearInterval(schoolTimer)
  schoolTimer = null
  window.removeEventListener('message', onSchoolMessage)
}

function onSchoolMessage(event) {
  if (!window.opener || event.source !== window.opener) return
  if (!isTrustedSchoolOrigin(event.origin, window.location.hostname)) return
  const data = event.data || {}
  if (data.type === 'ddlmate:school-error') {
    stopSchoolHandshake()
    schoolStatus.value = 'error'
    schoolMessage.value = String(data.message || '教务页面没能取到课表。').slice(0, 300)
    return
  }
  if (data.type !== 'ddlmate:school-timetable') return
  const text = data.payload?.text
  if (typeof text !== 'string' || !text || text.length > MAX_SCHOOL_PAYLOAD_CHARS) {
    schoolStatus.value = 'error'
    schoolMessage.value = '收到的课表数据为空或太大。'
    return
  }
  stopSchoolHandshake()
  try {
    event.source.postMessage({ type: 'ddlmate:received' }, event.origin)
  } catch {
    /* 教务页面已关闭也没关系 */
  }
  const result = parseAcademicTimetable(text)
  stashExams(typeof data.payload?.examText === 'string' ? data.payload.examText.slice(0, MAX_SCHOOL_PAYLOAD_CHARS) : '', '课程抓取（学校教务系统）')
  if (result.error) {
    schoolStatus.value = 'error'
    schoolMessage.value = result.error
    return
  }
  schoolStatus.value = 'received'
  applyAcademicResult(result, `学校教务系统 ${String(data.payload?.host || '').slice(0, 60)}`)
}

function startSchoolHandshake() {
  if (!window.opener) {
    schoolStatus.value = 'no-opener'
    return
  }
  schoolStatus.value = 'waiting'
  schoolDeadline = Date.now() + 2 * 60 * 1000
  window.addEventListener('message', onSchoolMessage)
  const ping = () => {
    if (Date.now() > schoolDeadline) {
      stopSchoolHandshake()
      schoolStatus.value = 'timeout'
      return
    }
    try {
      // 「我准备好了」不含任何数据，发给打开我的那个页面即可
      window.opener?.postMessage({ type: 'ddlmate:ready' }, '*')
    } catch {
      /* ignore */
    }
  }
  ping()
  schoolTimer = window.setInterval(ping, 1000)
}

onMounted(() => {
  if (route.query.from === 'school') startSchoolHandshake()
})

onBeforeUnmount(() => {
  stopSchoolHandshake()
  unmounted = true
  runId += 1 // 让进行中的识别任务作废，不再写回状态
  releaseObjectUrl(imageUrl.value)
  terminateWorker()
})

function pickFile() {
  fileInput.value?.click()
}

function pickDataFile() {
  dataFileInput.value?.click()
}

/**
 * 导入教务数据：HAR 抓包 / 课表接口 JSON / 教务课表网页。文件只在浏览器里解析，
 * 不上传；抓包里的 Cookie、令牌等一概不读取、不保存。
 */
async function onDataFileChange(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  ocrState.error = ''
  if (file.size > MAX_DATA_FILE_BYTES) {
    ocrState.error = '文件太大（超过 30 MB）。请只抓课表页面那一小段再导出。'
    return
  }
  let result
  let text = ''
  try {
    text = await file.text()
    result = parseAcademicTimetable(text)
  } catch (error) {
    ocrState.error = `读取文件失败：${error.message}`
    return
  }
  const examCount = stashExams(text, file.name)
  if (result.error) {
    // 只有考试、没有课表的抓包：直接引导去考试抓取
    ocrState.error = examCount ? '' : result.error
    return
  }
  applyAcademicResult(result, file.name)
}

/** 同一份数据里的考试安排：存起来交给「考试抓取」页，并在这里提示。返回场数。 */
const pendingExams = ref(0)
function stashExams(input, label) {
  if (!input) return 0
  const parsed = parseAcademicExams(input)
  pendingExams.value = parsed.exams.length
  if (!parsed.exams.length) return 0
  try {
    sessionStorage.setItem(PENDING_EXAMS_KEY, JSON.stringify({ exams: parsed.exams, label }))
  } catch {
    /* 存不下也没关系：考试抓取页可以直接选文件 */
  }
  return parsed.exams.length
}

/** 把解析好的教务课表放进候选表（文件导入与课程抓取共用）。 */
function applyAcademicResult(result, label) {
  runId += 1 // 作废进行中的图片识别，避免它稍后覆盖这里的结果
  ocrState.running = false
  ocrState.error = ''
  ocrState.weekView = null
  weekViewConfirmed.value = false
  dataSource.value = `${label}（${result.source === 'eams' ? '教务网页课表' : '小程序课表接口'}）`
  ocrState.layout = result.source === 'eams' ? '教务网页课表' : '小程序课表接口'
  ocrState.rawText = result.summary
  ocrState.warnings = result.warnings
  ocrState.candidates = result.candidates.map(toEditable)
  if (result.semesterStartDate) semesterStartDate.value = result.semesterStartDate
}

async function onFileChange(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  await loadFile(file)
}

/** 载入图片：校验 → 准备（像素保护）→ 识别。任何一步失败都给出可读提示，不留坏状态。 */
async function loadFile(file) {
  const invalid = validateImageFile(file)
  if (invalid) {
    ocrState.error = invalid
    return
  }
  ocrState.error = ''
  result.value = null
  let prepared
  try {
    prepared = await prepareImage(file)
  } catch (error) {
    // 解码失败：保留当前图片与已有候选不变，只提示这次选择没生效
    ocrState.error = `${error.message}（当前图片与已有候选保持不变）`
    return
  }
  setImage(URL.createObjectURL(file), file.name, prepared, file.size)
  await runOcr(ocrImage.value, 'auto')
}

/** 载入内置样例图（用于验证真实 OCR 链路，不是模拟识别）。 */
async function loadSample(name) {
  ocrState.error = ''
  result.value = null
  let prepared
  try {
    prepared = await prepareImage(`/samples/${name}`)
  } catch (error) {
    // 解码失败：保留当前图片与已有候选不变，只提示这次选择没生效
    ocrState.error = `${error.message}（当前图片与已有候选保持不变）`
    return
  }
  setImage(`/samples/${name}`, name, prepared, null)
  await runOcr(ocrImage.value, 'auto')
}

function setImage(url, name, prepared, size) {
  dataSource.value = ''
  // 换图即作废进行中的识别任务（旧任务不得再写回状态）
  runId += 1
  terminateWorker()
  weekViewConfirmed.value = false
  ocrState.weekView = null
  ocrState.candidates = []
  ocrState.rawText = ''
  ocrState.warnings = []
  // 无论新图是本地文件还是内置样例，都先释放上一张的 objectURL（只对 blob: 生效）
  releaseObjectUrl(imageUrl.value)
  imageUrl.value = url
  ocrImage.value = prepared.image
  imageMeta.value = { name, width: prepared.width, height: prepared.height, scaled: prepared.scaled, size }
  Object.assign(selection, { active: false, x: 0, y: 0, width: 0, height: 0 })
  regionTarget.value = 'append'
}

async function runOcr(source, mode, { replaceCandidateId = null } = {}) {
  const myRun = ++runId
  weekViewConfirmed.value = false
  const isCurrent = () => myRun === runId && !unmounted
  ocrState.running = true
  ocrState.error = ''
  ocrState.progress = 0
  ocrState.status = '正在准备识别…'
  try {
    // ① 先试自动版式流水线：有线框表格（真实手机拍的横版课表）或卡片式周视图（手机截图）
    let layoutResult = null
    if (mode === 'auto') {
      layoutResult = await tryLayoutPipeline(source, isCurrent, myRun)
      if (!isCurrent()) return
    }

    if (layoutResult?.matched && !layoutResult.cancelled) {
      applyLayoutResult(layoutResult)
      return
    }

    // ② 回退：整图识别（列表照片等走这条，行为与之前一致）
    if (layoutResult && !layoutResult.matched) {
      ocrState.status = '这不是课表表格/周视图，改用整图识别…'
    }
    const data = await recognizeImage(source, {
      onProgress: (value) => {
        if (isCurrent()) ocrState.progress = value
      },
      onStatus: (status) => {
        if (isCurrent()) ocrState.status = toChineseStatus(status)
      },
    })
    if (!isCurrent()) return // 已被取消 / 已换图 / 已离开页面：不写任何状态
    const lines = flattenOcrLines(data)
    const parsed = parseTimetable(lines, { mode })
    ocrState.rawText = parsed.rawText
    ocrState.layout = parsed.layout
    ocrState.warnings = parsed.warnings
    if (mode !== 'region') ocrState.weekView = null
    if (mode === 'region' && ocrState.weekView) {
      for (const candidate of parsed.candidates) {
        candidate.sourceWeekView = { week: ocrState.weekView.week }
        candidate.startWeek ??= ocrState.weekView.week
        candidate.endWeek ??= ocrState.weekView.week
      }
    }
    if (parsed.semesterStartDate) {
      semesterStartDate.value = parsed.semesterStartDate
    }

    if (replaceCandidateId) {
      const index = ocrState.candidates.findIndex((item) => item.id === replaceCandidateId)
      if (index >= 0 && parsed.candidates.length) {
        const previous = ocrState.candidates[index]
        const updated = applyCandidateFields(previous, parsed.candidates[0], true)
        ocrState.candidates.splice(index, 1, updated)
        ocrState.warnings = [
          ...parsed.warnings,
          `已用框选识别结果更新「${updated.courseName || updated.name || '该候选'}」，其它候选未改动。`,
        ]
      } else if (parsed.candidates.length) {
        ocrState.candidates = [...ocrState.candidates, ...parsed.candidates.map(toEditable)]
      } else {
        ocrState.warnings = [...parsed.warnings, '框选区域没有识别出内容，请重新框选或手工添加。']
      }
    } else if (mode === 'region') {
      // 区域识别默认追加，不删除已有候选
      if (parsed.candidates.length) {
        ocrState.candidates = [...ocrState.candidates, ...parsed.candidates.map(toEditable)]
        ocrState.warnings = [...parsed.warnings, `已追加 ${parsed.candidates.length} 条候选，原有候选保持不变。`]
      } else {
        ocrState.warnings = [...parsed.warnings, '框选区域没有识别出内容，请重新框选或手工添加。']
      }
    } else {
      ocrState.candidates = parsed.candidates.map(toEditable)
      if (!ocrState.candidates.length) {
        ocrState.warnings = [
          ...parsed.warnings,
          '没有自动解析出课程：可以框选单门课单独识别，或点"手工添加候选"自己填。',
        ]
      }
    }
  } catch (error) {
    if (isCurrent() && !(error instanceof OcrCancelledError)) {
      ocrState.error = error.message
    }
  } finally {
    // 只有"当前这次任务"才能收尾，否则旧任务的 finally 会把新任务的状态清掉
    if (isCurrent()) {
      ocrState.running = false
      ocrState.progress = 0
      ocrState.status = ''
    }
  }
}

/**
 * 尝试自动版式流水线（有线框表格 / 卡片式周视图，由 timetableLayout 路由选择）。
 * 返回 { matched } —— matched=false 时调用方回退到整图识别，不会把状态栏文字当课程。
 */
async function tryLayoutPipeline(source, isCurrent, myRun) {
  try {
    const imageData = imageToImageData(source)
    const result = await recognizeTimetableLayout(imageData, {
      recognize: (canvas, { psm }) =>
        recognizeImage(canvas, {
          psm,
          onStatus: (status) => {
            if (isCurrent()) ocrState.status = toChineseStatus(status)
          },
        }),
      isCancelled: () => myRun !== runId || unmounted,
      onStage: (text, ratio) => {
        if (!isCurrent()) return
        ocrState.status = text
        ocrState.progress = ratio
      },
    })
    return result
  } catch (error) {
    if (error instanceof OcrCancelledError) throw error
    // 几何分析失败不应该打断流程：直接回退旧路径
    console.warn('[ocr] 版式流水线不可用，回退整图识别', error)
    return { matched: false, reason: error.message }
  }
}

/** 采用版式流水线（表格 / 卡片周视图）的结果填充候选。 */
function applyLayoutResult(result) {
  const week = result.week
  ocrState.layout = result.layout || 'week-grid'
  ocrState.rawText = result.candidates
    .map(
      (candidate) =>
        `周${candidate.weekday ?? '?'} 第${candidate.periodStart ?? '?'}-${candidate.periodEnd ?? '?'}节 ` +
        `${candidate.rawText || ''}`,
    )
    .join('\n')
  ocrState.weekView = { week }
  ocrState.warnings = [
    // 有线框表格是整学期课表：教学周来自每一格，不需要"第 N 周"标题，也不该提示缺标题。
    ...(week || result.layout === 'table-grid'
      ? []
      : ['没有识别到"第 N 周"标题，请手动确认这些课属于哪一周']),
    ...result.warnings,
  ]
  ocrState.candidates = result.candidates.map((candidate) => {
    const row = toEditable({ ...candidate, sourceWeekView: week ? { week } : null })
    // 周视图：默认只此一周 + 每周规律，不推断单双周（表格版式的教学周来自格子里读到的周次）
    if (week) {
      row.startWeek = week
      row.endWeek = week
      row.weekPattern = 'ALL'
    }
    return row
  })
  if (!ocrState.candidates.length) {
    ocrState.warnings = [
      ...ocrState.warnings,
      '没有从这张图里解析出课程块：可以用框选识别单门课，或点"手工添加候选"自己填。',
    ]
  }
}

/** 解析结果 → 可编辑行（自动匹配已有课程，优先复用而不是新建）。 */
function toEditable(candidate) {
  return applyCandidateFields(
    reactive({
      // 解析器每次从 c1 重新编号；框选追加必须重新分配页面内唯一 ID。
      id: `candidate-${++candidateSequence}`,
      selected: true,
      name: '',
      courseName: '',
      courseMode: 'new',
      existingCourseId: null,
      code: '',
      teacher: '',
      instructor: '',
      weekday: null,
      startTime: '',
      endTime: '',
      periodStart: null,
      periodEnd: null,
      location: '',
      startWeek: null,
      endWeek: null,
      weekPattern: 'ALL',
      warnings: [],
      rawText: '',
    }),
    candidate,
    false,
  )
}

function applyCandidateFields(row, candidate, keepSelection) {
  const preserveWeekScope = keepSelection && row.sourceWeekView
  row.sourceWeekView = candidate.sourceWeekView || row.sourceWeekView || null
  const matched = matchExistingCourse(candidate.name)
  row.name = candidate.name || row.name || ''
  row.courseName = matched ? matched.name : candidate.name || row.courseName || ''
  row.courseMode = matched ? 'existing' : 'new'
  row.existingCourseId = matched ? matched.id : null
  row.code = matched
    ? matched.code
    : preferredCode(candidate.code, row) ||
      (row.code && !codeTaken(row.code, row) ? row.code : suggestCode(row.courseName || row.name))
  if (candidate.teacher) row.teacher = candidate.teacher
  if (candidate.instructor) row.instructor = candidate.instructor
  row.weekday = candidate.weekday ?? row.weekday ?? null
  row.startTime = candidate.startTime || row.startTime || ''
  row.endTime = candidate.endTime || row.endTime || ''
  row.periodStart = candidate.periodStart ?? row.periodStart ?? null
  row.periodEnd = candidate.periodEnd ?? row.periodEnd ?? null
  row.location = candidate.location || row.location || ''
  if (!preserveWeekScope) {
    row.startWeek = candidate.startWeek ?? row.startWeek ?? null
    row.endWeek = candidate.endWeek ?? row.endWeek ?? null
    row.weekPattern = candidate.weekPattern || row.weekPattern || 'ALL'
  }
  row.warnings = (candidate.warnings || []).filter(warning =>
    !row.sourceWeekView || !warning.startsWith('图片是第'))
  row.rawText = candidate.rawText || row.rawText || ''
  if (!keepSelection) row.selected = true
  return row
}

/** 数据里自带的课程号：没被已有课程占用、且本批里只被同名课程使用时直接采用。 */
function preferredCode(code, row) {
  const target = String(code || '').trim().toLowerCase()
  if (!target || target.length > 32) return ''
  if (courses.value.some((course) => String(course.code || '').toLowerCase() === target)) return ''
  const clash = ocrState.candidates.some(
    (other) =>
      other !== row &&
      String(other.code || '').trim().toLowerCase() === target &&
      normalizeName(other.courseName) !== normalizeName(row.courseName || row.name),
  )
  return clash ? '' : String(code).trim()
}

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase()
}

/** 只做精确匹配（课程名或课程代码完全一致），避免把「高等数学实验」并进「高等数学」。 */
function matchExistingCourse(name) {
  const target = normalizeName(name)
  if (!target) return null
  return (
    courses.value.find(
      (course) => normalizeName(course.name) === target || normalizeName(course.code) === target,
    ) || null
  )
}

let codeSeed = 1
/** 生成不与已有课程、也不与本批候选冲突的课程代码。 */
function suggestCode(name) {
  const ascii = String(name || '')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 6)
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const suffix = String(codeSeed++).padStart(2, '0')
    const candidate = ascii ? `OCR${ascii}${suffix}`.slice(0, 32) : `OCR${suffix}`
    if (!codeTaken(candidate)) return candidate
  }
  return `OCR${Date.now().toString().slice(-6)}`
}

function onCourseNameChange(candidate) {
  const matched = matchExistingCourse(candidate.courseName)
  if (matched) {
    candidate.courseMode = 'existing'
    candidate.existingCourseId = matched.id
    candidate.courseName = matched.name
    candidate.code = matched.code
  } else if (candidate.courseMode === 'existing') {
    candidate.courseMode = 'new'
    candidate.existingCourseId = null
    candidate.code = suggestCode(candidate.courseName)
  } else if (codeTaken(candidate.code, candidate)) {
    candidate.code = suggestCode(candidate.courseName)
  }
}

function onCourseModeChange(candidate) {
  if (candidate.courseMode === 'existing') {
    const course =
      matchExistingCourse(candidate.courseName) ||
      courses.value.find((item) => item.id === candidate.existingCourseId) ||
      courses.value[0]
    if (course) {
      // 选了已有课程：必须同步名称与代码，否则无法提交
      candidate.existingCourseId = course.id
      candidate.courseName = course.name
      candidate.code = course.code
    }
  } else {
    candidate.existingCourseId = null
    if (!candidate.courseName) candidate.courseName = candidate.name || ''
    if (codeTaken(candidate.code, candidate)) candidate.code = suggestCode(candidate.courseName)
  }
}

function onExistingCourseChange(candidate) {
  const course = courses.value.find((item) => item.id === candidate.existingCourseId)
  if (course) {
    candidate.courseName = course.name
    candidate.code = course.code
  }
}

function applyPatternToAll(pattern) {
  for (const candidate of ocrState.candidates) {
    candidate.weekPattern = pattern
  }
}

function applyWholeSemester() {
  const end = Math.trunc(Number(semesterEndWeek.value))
  if (!Number.isInteger(end) || end < 1 || end > 53) return
  for (const candidate of ocrState.candidates) {
    if (!candidate.selected) continue
    candidate.startWeek = 1
    candidate.endWeek = end
  }
}

function toggleAll(selected) {
  for (const candidate of ocrState.candidates) {
    candidate.selected = selected
  }
}

function removeCandidate(candidate) {
  ocrState.candidates = ocrState.candidates.filter((item) => item !== candidate)
}

function addManualCandidate() {
  const candidate = toEditable({
    name: '',
    weekday: null,
    startTime: null,
    endTime: null,
    weekPattern: 'ALL',
    warnings: ['手工添加：请填写课程、星期与开始/结束时间'],
  })
  candidate.courseName = ''
  candidate.selected = false
  ocrState.candidates = [...ocrState.candidates, candidate]
}

/* -------------------------------- 框选识别 -------------------------------- */

function pointerPosition(event) {
  const rect = event.currentTarget.getBoundingClientRect()
  const scaleX = imageMeta.value.width / rect.width
  const scaleY = imageMeta.value.height / rect.height
  return {
    x: Math.min(Math.max((event.clientX - rect.left) * scaleX, 0), imageMeta.value.width),
    y: Math.min(Math.max((event.clientY - rect.top) * scaleY, 0), imageMeta.value.height),
  }
}

function onPointerDown(event) {
  if (!imageMeta.value) return
  selection.active = true
  dragStart = pointerPosition(event)
  Object.assign(selection, { x: dragStart.x, y: dragStart.y, width: 0, height: 0 })
  event.currentTarget.setPointerCapture?.(event.pointerId)
}

function onPointerMove(event) {
  if (!selection.active || !dragStart) return
  const current = pointerPosition(event)
  selection.x = Math.min(dragStart.x, current.x)
  selection.y = Math.min(dragStart.y, current.y)
  selection.width = Math.abs(current.x - dragStart.x)
  selection.height = Math.abs(current.y - dragStart.y)
}

function onPointerUp() {
  selection.active = false
}

const selectionStyle = computed(() => {
  if (!imageMeta.value || selection.width < 5 || selection.height < 5) return null
  return {
    left: `${(selection.x / imageMeta.value.width) * 100}%`,
    top: `${(selection.y / imageMeta.value.height) * 100}%`,
    width: `${(selection.width / imageMeta.value.width) * 100}%`,
    height: `${(selection.height / imageMeta.value.height) * 100}%`,
  }
})

async function recognizeSelection() {
  if (!ocrImage.value || selection.width < 10 || selection.height < 10) {
    ocrState.error = '请先在图片上拖拽框出一门课的区域'
    return
  }
  try {
    const cropped = await cropImage(ocrImage.value, {
      x: selection.x,
      y: selection.y,
      width: selection.width,
      height: selection.height,
    })
    const replaceId = regionTarget.value === 'append' ? null : regionTarget.value
    await runOcr(cropped.canvas, 'region', { replaceCandidateId: replaceId })
  } catch (error) {
    if (!(error instanceof OcrCancelledError)) ocrState.error = error.message
  }
}

async function cancelOcr() {
  runId += 1 // 先作废当前任务，再进行中的回调/收尾都不会再改界面
  await terminateWorker()
  ocrState.running = false
  ocrState.progress = 0
  ocrState.status = ''
  ocrState.warnings = [...ocrState.warnings, '已取消本次识别，可以重新识别、框选识别或手工添加。']
}

/* -------------------------------- 提交 -------------------------------- */

async function submit() {
  if (submitting.value) return
  submitError.value = ''
  submitFieldErrors.value = {}
  notices.value = []

  const rows = selectedCandidates.value
  const problem = blockReason.value
  if (problem) {
    submitError.value = problem
    return
  }

  // 同一门新课程的多条课表共享一个课程（按课程名归并）
  const newCourses = []
  const refByKey = new Map()
  for (const row of rows) {
    if (row.courseMode === 'existing' && row.existingCourseId) continue
    const key = normalizeName(row.courseName)
    if (refByKey.has(key)) continue
    const ref = `n${refByKey.size + 1}`
    refByKey.set(key, ref)
    newCourses.push({
      ref,
      code: row.code.trim(),
      name: row.courseName.trim(),
      instructor: (row.instructor || row.teacher || '').trim().slice(0, 64) || null,
      semester: null,
      color: null,
    })
  }

  const schedules = rows.map((row) => {
    const usesExisting = row.courseMode === 'existing' && row.existingCourseId
    return {
      courseId: usesExisting ? row.existingCourseId : null,
      courseRef: usesExisting ? null : refByKey.get(normalizeName(row.courseName)) || null,
      weekday: Number(row.weekday),
      startTime: row.startTime || null,
      endTime: row.endTime || null,
      location: row.location?.trim() || null,
      periodStart: row.periodStart ?? null,
      periodEnd: row.periodEnd ?? null,
      weekRange: row.startWeek && row.endWeek ? `${row.startWeek}-${row.endWeek}` : null,
      semesterStartDate: row.startWeek && row.endWeek ? semesterStartDate.value || null : null,
      startWeek: row.startWeek ?? null,
      endWeek: row.endWeek ?? null,
      weekPattern: row.weekPattern || 'ALL',
      teacher: (row.teacher || '').trim() || null,
    }
  })

  submitting.value = true
  try {
    const payload = { courses: newCourses, schedules }
    if (dataSource.value && replaceWithData.value) {
      const updates = new Map()
      for (const row of rows) {
        if (row.courseMode !== 'existing' || !row.existingCourseId || updates.has(row.existingCourseId)) continue
        updates.set(row.existingCourseId, (row.instructor || row.teacher || '').trim().slice(0, 64) || null)
      }
      if (updates.size) {
        const names = [...updates.keys()].map((id) => courses.value.find((c) => c.id === id)?.name).filter(Boolean)
        const ok = window.confirm(
          `以导入数据为准：这 ${updates.size} 门已有课程（${names.join('、')}）原来的课表会被删除，` +
            '换成本次导入的课表，任课教师也改成数据里的老师。课程本身和关联的 DDL 保留。继续吗？',
        )
        if (!ok) {
          submitting.value = false
          return
        }
        payload.courseUpdates = [...updates].map(([id, instructor]) => ({ id, instructor }))
        payload.replaceScheduleCourseIds = [...updates.keys()]
      }
    }
    const response = await scheduleApi.importBatch(payload)
    result.value = response
    notices.value = response.notices || []
    const importedIds = new Set(rows.map((row) => row.id))
    ocrState.candidates = ocrState.candidates.filter((candidate) => !importedIds.has(candidate.id))
    courses.value = await courseApi.list().catch(() => courses.value)
  } catch (error) {
    if (error instanceof ApiError) {
      submitFieldErrors.value = error.fieldErrorMap()
      submitError.value = error.message
    } else {
      submitError.value = error.message
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>照片导入课表</h1>
        <p class="page-head__sub">选一张课表照片，在浏览器里本地识别，确认后写入课表</p>
      </div>
      <RouterLink class="btn" to="/courses">
        <AppIcon name="book" :size="17" />
        返回课程与课表
      </RouterLink>
    </div>

    <section v-if="pendingExams" class="card card--accent" style="margin-bottom: 16px">
      <div class="row" style="justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap">
        <span class="small">还抓到了 <b>{{ pendingExams }}</b> 场考试安排（含考场、座位号）。</span>
        <RouterLink class="btn btn--sm btn--primary" to="/exams/import">去考试抓取</RouterLink>
      </div>
    </section>

    <section v-if="schoolStatus" class="card" :class="{ 'card--accent': schoolStatus === 'received' }" style="margin-bottom: 16px">
      <div class="card__title" style="margin-bottom: 6px">
        <AppIcon name="download" :size="18" />
        课程抓取
      </div>
      <p v-if="schoolStatus === 'waiting'" class="small" style="margin: 0">正在从学校教务系统读取课表…（如果一直没有反应，回到教务页面再点一次书签）</p>
      <p v-else-if="schoolStatus === 'received'" class="small" style="margin: 0">已收到课表，下面是候选，请核对后点底部的「确认导入」。</p>
      <p v-else-if="schoolStatus === 'error'" class="field__error" style="margin: 0">{{ schoolMessage }}</p>
      <p v-else-if="schoolStatus === 'timeout'" class="small" style="margin: 0">两分钟内没有收到课表。请回到教务系统的页面，再点一次「抓取到 DDL Mate」书签。</p>
      <p v-else class="small" style="margin: 0">
        这个页面要由教务系统里的书签打开才能收到课表。设置方法见
        <RouterLink to="/tools/school-import">课程抓取</RouterLink>。
      </p>
    </section>

    <section class="card">
      <div class="card__head">
        <div>
          <div class="card__title">
            <AppIcon name="camera" :size="18" />
            ① 选择课表照片
          </div>
          <p class="card__hint">
            支持 PNG / JPEG / WebP，单张不超过 12 MB（超大图会自动等比缩小）。识别在你的浏览器里完成，图片不会上传。
          </p>
        </div>
        <div class="row">
          <button class="btn btn--primary" type="button" :disabled="ocrState.running" @click="pickFile">
            选择图片
          </button>
          <button
            class="btn btn--sm"
            type="button"
            :disabled="ocrState.running"
            @click="loadSample('timetable-grid.png')"
          >
            载入样例（表格）
          </button>
          <button
            class="btn btn--sm"
            type="button"
            :disabled="ocrState.running"
            @click="loadSample('timetable-list.png')"
          >
            载入样例（列表）
          </button>
          <button class="btn" type="button" :disabled="ocrState.running" @click="pickDataFile">
            <AppIcon name="upload" :size="16" />
            导入教务数据
          </button>
        </div>
      </div>
      <p class="small muted" style="margin: -4px 0 12px">
        「导入教务数据」：选择在课表页面抓包导出的 <span class="mono">.har</span> 文件（支持学校小程序的课表接口、教务网页「我的课表」），
        或单独保存的课表 JSON。文件只在浏览器里读取，不上传；里面的登录信息不会被读取或保存。
        电脑上更省事：用 <RouterLink to="/tools/school-import">课程抓取</RouterLink> 书签，登录教务系统后点一下就行，考试也会一起抓到。
      </p>
      <p v-if="dataSource" class="small" style="margin: -6px 0 12px">已从 {{ dataSource }} 读入 {{ ocrState.candidates.length }} 条课表，请在下面核对。</p>

      <input
        ref="dataFileInput"
        type="file"
        accept=".har,.json,.html,.htm,application/json,text/html"
        hidden
        @change="onDataFileChange"
      />

      <input
        ref="fileInput"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        @change="onFileChange"
      />

      <ErrorState v-if="ocrState.error" :message="ocrState.error" @retry="pickFile" />

      <div v-if="imageUrl" class="stack">
        <div class="row row--between">
          <span class="small muted">
            {{ imageMeta?.name }} · {{ imageMeta?.width }}×{{ imageMeta?.height }}
            <template v-if="imageMeta?.scaled">（原图较大，已缩放识别）</template>
            <template v-if="imageMeta?.size">· {{ (imageMeta.size / 1024).toFixed(0) }} KB</template>
          </span>
          <div class="row">
            <button class="btn btn--sm" type="button" :disabled="ocrState.running" @click="runOcr(ocrImage, 'auto')">
              整图重新识别
            </button>
            <button
              class="btn btn--sm"
              type="button"
              :disabled="ocrState.running || !selectionStyle"
              @click="recognizeSelection"
            >
              识别框选区域
            </button>
            <button v-if="ocrState.running" class="btn btn--sm btn--danger" type="button" @click="cancelOcr">
              取消识别
            </button>
          </div>
        </div>

        <div class="ocr-preview">
          <img :src="imageUrl" alt="课表照片预览" />
          <div
            class="ocr-preview__layer"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointerleave="onPointerUp"
          />
          <div v-if="selectionStyle" class="ocr-preview__selection" :style="selectionStyle" />
        </div>
        <p class="small muted" style="margin: 0">
          提示：表格照片直接整图识别即可；如果某一门课识别不准，可在图片上按住拖拽框出它，再点"识别框选区域"。
        </p>

        <div v-if="ocrState.running" class="stack">
          <div class="progress">
            <div class="progress__bar" :style="{ width: `${Math.round(ocrState.progress * 100)}%` }" />
          </div>
          <span class="small muted">{{ ocrState.status }} {{ Math.round(ocrState.progress * 100) }}%</span>
        </div>
      </div>
      <p v-else class="muted small">还没有选择图片。</p>
    </section>

    <!-- 成功提示独立显示：即使候选全部导入完也依然可见 -->
    <section v-if="result" class="card">
      <div class="card__head">
        <div>
          <div class="card__title">
            <AppIcon name="check" :size="18" />
            导入成功
          </div>
          <p class="card__hint">
            已导入 {{ result.createdSchedules }} 条课表，新建课程 {{ result.createdCourses }} 门。
            <template v-if="result.skippedSchedules">
              跳过与已有课表完全相同的 {{ result.skippedSchedules }} 条。
            </template>
          </p>
        </div>
        <div class="row">
          <RouterLink class="btn btn--primary" to="/courses">去看课程与课表</RouterLink>
          <RouterLink class="btn" to="/calendar">去看日历</RouterLink>
        </div>
      </div>
      <ul v-if="notices.length" class="small muted" style="margin: 0; padding-left: 18px">
        <li v-for="(notice, index) in notices" :key="index">{{ notice }}</li>
      </ul>
      <p v-if="!ocrState.candidates.length" class="small muted" style="margin: 8px 0 0">
        本次候选都已处理完，可以继续选择下一张照片导入。
      </p>
    </section>

    <section class="card">
      <div class="card__head">
        <div>
          <div class="card__title">
            <AppIcon name="book" :size="18" />
            ② 核对识别结果（{{ ocrState.candidates.length }} 条候选）
          </div>
          <p class="card__hint">识别结果只是候选：请核对课程、星期与时间；缺字段会标出来，不会替你猜。</p>
        </div>
        <div class="row">
          <button class="btn btn--sm" type="button" @click="toggleAll(true)">全选</button>
          <button class="btn btn--sm" type="button" @click="toggleAll(false)">全不选</button>
          <button class="btn btn--sm btn--primary" type="button" @click="addManualCandidate">手工添加候选</button>
        </div>
      </div>

      <div v-if="weekViewContext" class="alert alert--warn" style="margin-bottom: 12px">
        <strong>这是一张{{ weekViewContext.week ? `第 ${weekViewContext.week} 周的` : '' }}周视图。</strong>
        <p style="margin: 6px 0">截图只展示一周，不能判断整学期的重复规律。
          <template v-if="weekViewContext.week">默认仅导入第 {{ weekViewContext.week }} 周。</template>
          请填写学期第一周周一；若课程会重复，请自行修改下面的起止教学周和单双周。</p>
        <div class="row" style="gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap">
          <span class="small">每周都上的课：</span>
          <button class="btn btn--sm" type="button" @click="applyWholeSemester">全部设为第 1–{{ semesterEndWeek }} 周</button>
          <label class="row small" style="gap: 4px; align-items: center">
            学期共
            <input v-model.number="semesterEndWeek" type="number" min="1" max="53" style="width: 64px" />
            周
          </label>
        </div>
        <label class="row" style="gap: 6px; align-items: center">
          <input v-model="weekViewConfirmed" type="checkbox" />
          <span>我已核对下面每条课程实际导入的教学周范围和单双周设置</span>
        </label>
        <p v-if="weekViewGate.blocked" class="small" style="margin: 6px 0 0">
          ⛔ {{ weekViewGate.reason }}
        </p>
      </div>

      <div v-if="ocrState.warnings.length" class="alert alert--warn" style="margin-bottom: 12px">
        <div v-for="(warning, index) in ocrState.warnings" :key="index">{{ warning }}</div>
      </div>

      <div class="form-grid" style="margin-bottom: 12px">
        <label class="field">
          <span class="field__label">学期第一周周一（填写后启用教学周与单双周过滤）</span>
          <input v-model="semesterStartDate" type="date" />
          <span v-if="calibratedStart && semesterStartDate === calibratedStart.monday" class="field__hint">
            已按「教学周校准」自动填写{{ calibratedStart.week ? `（今天是第 ${calibratedStart.week} 周）` : '' }}，一般不用改
          </span>
          <span v-else class="field__hint">必须选周一；导入教学周范围或单双周时必填，未限定周次的课表可以留空</span>
        </label>
        <div class="field">
          <span class="field__label">批量设置周次规律</span>
          <div class="row">
            <button
              v-for="option in patternOptions"
              :key="option.value"
              class="btn btn--sm"
              type="button"
              @click="applyPatternToAll(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <label class="field">
          <span class="field__label">框选识别结果如何处理</span>
          <select v-model="regionTarget">
            <option value="append">追加为新候选（不动已有候选）</option>
            <option v-for="candidate in ocrState.candidates" :key="candidate.id" :value="candidate.id">
              替换：{{ candidate.courseName || candidate.name || '未命名候选' }}
            </option>
          </select>
          <span class="field__hint">默认追加；也可指定替换某一条，其它候选保持不变</span>
        </label>
      </div>

      <p v-if="ocrState.candidates.length" class="small muted">表格可左右滑动，核对地点、起止周和单双周设置。</p>
      <div v-if="ocrState.candidates.length" class="table-wrap">
        <table class="candidate-table">
          <thead>
            <tr>
              <th>导入</th>
              <th>课程</th>
              <th>星期</th>
              <th>开始</th>
              <th>结束</th>
              <th>节次</th>
              <th>地点</th>
              <th>教师</th>
              <th>起止周</th>
              <th>周次规律</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="candidate in ocrState.candidates" :key="candidate.id">
              <td>
                <input
                  v-model="candidate.selected"
                  type="checkbox"
                  :aria-label="`导入 ${candidate.courseName || '候选'}`"
                />
              </td>
              <td>
                <div class="stack" style="gap: 4px">
                  <select v-model="candidate.courseMode" @change="onCourseModeChange(candidate)">
                    <option value="new">新建课程</option>
                    <option value="existing">已有课程</option>
                  </select>
                  <template v-if="candidate.courseMode === 'existing'">
                    <select
                      v-model="candidate.existingCourseId"
                      aria-label="选择已有课程"
                      @change="onExistingCourseChange(candidate)"
                    >
                      <option :value="null">请选择课程</option>
                      <option v-for="course in courses" :key="course.id" :value="course.id">
                        {{ course.code }} {{ course.name }}
                      </option>
                    </select>
                    <span class="small muted">{{ candidate.courseName || '未选择课程' }}</span>
                  </template>
                  <template v-else>
                    <input
                      v-model="candidate.courseName"
                      type="text"
                      placeholder="课程名称"
                      @change="onCourseNameChange(candidate)"
                    />
                    <input v-model="candidate.code" type="text" placeholder="课程代码（自动生成，可改）" />
                  </template>
                </div>
              </td>
              <td>
                <select v-model="candidate.weekday" aria-label="星期">
                  <option :value="null">请选择</option>
                  <option v-for="option in weekdayOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
              </td>
              <td><input v-model="candidate.startTime" type="time" /></td>
              <td><input v-model="candidate.endTime" type="time" /></td>
              <td>
                <div class="row" style="gap: 4px">
                  <input
                    v-model="candidate.periodStart"
                    type="number"
                    min="1"
                    max="12"
                    style="width: 62px"
                    placeholder="起"
                  />
                  <input
                    v-model="candidate.periodEnd"
                    type="number"
                    min="1"
                    max="12"
                    style="width: 62px"
                    placeholder="止"
                  />
                </div>
              </td>
              <td><input v-model="candidate.location" type="text" placeholder="地点" /></td>
              <td><input v-model="candidate.teacher" type="text" maxlength="128" placeholder="教师" style="min-width: 110px" /></td>
              <td>
                <div class="row" style="gap: 4px">
                  <input
                    v-model="candidate.startWeek"
                    type="number"
                    min="1"
                    max="53"
                    style="width: 62px"
                    placeholder="起"
                  />
                  <input
                    v-model="candidate.endWeek"
                    type="number"
                    min="1"
                    max="53"
                    style="width: 62px"
                    placeholder="止"
                  />
                </div>
              </td>
              <td>
                <select v-model="candidate.weekPattern" aria-label="周次规律">
                  <option v-for="option in patternOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
              </td>
              <td>
                <button class="btn btn--sm btn--ghost" type="button" @click="removeCandidate(candidate)">删除</button>
                <span v-if="candidate.warnings.length" class="candidate-warning">
                  {{ candidate.warnings.join('；') }}
                </span>
                <details v-if="candidate.rawText" style="max-width: 160px; margin-top: 6px" class="small">
                  <summary>查看识别原文</summary>
                  <pre style="white-space: pre-wrap; overflow-wrap: anywhere; font: inherit">{{ candidate.rawText }}</pre>
                </details>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted small">
        还没有候选。可以整图识别、框选单门课识别，或点上面的"手工添加候选"自己填。
      </p>
    </section>

    <section v-if="ocrState.rawText" class="card">
      <div class="card__title" style="margin-bottom: 6px">{{ dataSource ? '读入的课表数据' : 'OCR 原文（识别不出来时可以对照它手工补）' }}</div>
      <p class="card__hint">
        <template v-if="dataSource">来源：{{ dataSource }}。下面是合并、按周次拆段后的每一条，可直接复制。</template>
        <template v-else>识别布局：{{ ocrState.layout || '未知' }}。这段文字来自图片本身，可直接复制。</template>
      </p>
      <div class="raw-text">{{ ocrState.rawText }}</div>
    </section>

    <section class="card" :class="{ 'import-dock': ocrState.candidates.length, 'import-dock--ready': canSubmit }">
      <div class="card__head">
        <div>
          <div class="card__title">
            <AppIcon name="check" :size="18" />
            ③ 确认导入（{{ selectedCandidates.length }} 条）
          </div>
          <p class="card__hint import-dock__hint">确认后一次性写入；全部取消勾选则不写库。</p>
        </div>
        <button
          class="btn btn--primary"
          :class="{ 'btn--blocked': !canSubmit && !submitting }"
          type="button"
          :disabled="submitting || ocrState.running"
          @click="submit"
        >
          {{ submitting ? '导入中…' : '确认导入' }}
        </button>
      </div>

      <div v-if="submitError" class="alert alert--danger" style="margin-bottom: 12px">
        {{ submitError }}
        <ul v-if="Object.keys(submitFieldErrors).length" style="margin: 6px 0 0; padding-left: 18px">
          <li v-for="(message, field) in submitFieldErrors" :key="field">{{ field }}：{{ message }}</li>
        </ul>
      </div>

      <label v-if="dataSource && ocrState.candidates.length" class="row small" style="gap: 6px; align-items: center; margin: 0 0 6px">
        <input v-model="replaceWithData" type="checkbox" />
        <span>以导入数据为准：同名的已有课程改用数据里的教师，并替换它们原来的课表</span>
      </label>
      <p v-if="coursesNotInData.length" class="small muted" style="margin: 0 0 6px">
        你现有的 {{ coursesNotInData.map((c) => c.name).join('、') }} 不在这份数据里（可能是照片识别时名字认错了），
        导入后可到 <RouterLink to="/courses/manage">编辑课程</RouterLink> 里删除。
      </p>
      <label v-if="weekViewContext && ocrState.candidates.length" class="row small" style="gap: 6px; align-items: center; margin: 0 0 6px">
        <input v-model="weekViewConfirmed" type="checkbox" />
        <span>我已核对每条课程的起止教学周和单双周</span>
      </label>
      <p v-if="blockReason && !submitError && !submitting" class="small" style="margin: 0; color: var(--warn, #b45309)">
        还不能导入：{{ blockReason }}
      </p>
    </section>
  </div>
</template>

<style scoped>
/* 导入栏固定在屏幕底部：候选表很长时也一直看得到按钮和"还差什么" */
.import-dock {
  position: sticky;
  bottom: 12px;
  z-index: 5;
  box-shadow: var(--shadow-lg, 0 10px 30px rgba(0, 0, 0, 0.18));
  border-color: var(--warn-line, var(--border));
}
.import-dock--ready {
  border-color: var(--primary);
}
.import-dock .card__head {
  margin-bottom: 8px;
  align-items: center;
}
@media (max-width: 640px) {
  .import-dock__hint {
    display: none;
  }
}
</style>
