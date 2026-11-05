/**
 * 从教务系统（EAMS「我的考试」stdExamTable!examTable.action）读出考试安排，转成「考试」类 DDL。
 * 输入可以是 HAR 抓包、考试页面 HTML，或书签发来的 HTML；只在浏览器里解析。
 *
 * 表头（按列名定位，不依赖列顺序）：
 *   考试批次 | 课程序号 | 课程名称 | 考试类别 | 考试日期 | 考试安排 | 考试地点 | 考场座位号 | 考试情况 | 其它说明
 * 还没排的考试显示「时间未安排 / 地点未安排」：导入为「未定日期」的考试，排定后再导入会补上时间地点。
 */
import { responsesFromInput } from './academicTimetable.js'

/** 课表导入页顺带收到的考试，经 sessionStorage 交给「导入考试」页。 */
export const PENDING_EXAMS_KEY = 'ddlmate.pendingExams'

function decode(text) {
  return String(text)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function tableRows(html) {
  const rows = []
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => decode(m[1]))
    if (cells.length) rows.push(cells)
  }
  return rows
}

const COLUMNS = {
  batch: ['考试批次'],
  code: ['课程序号', '课程代码'],
  name: ['课程名称'],
  category: ['考试类别', '考试类型'],
  date: ['考试日期'],
  time: ['考试安排', '考试时间'],
  location: ['考试地点', '考场'],
  seat: ['考场座位号', '座位号'],
  status: ['考试情况'],
  note: ['其它说明', '其他说明', '备注'],
}

const UNSET = /未安排|待定|^-*$/

/** 一段 HTML 里可能有多张表（或多次抓包拼在一起）：逐张表解析。 */
function examsFromHtml(html) {
  if (!/考试日期/.test(html) || !/课程名称/.test(html)) return []
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0])
  return (tables.length ? tables : [html]).flatMap(examsFromTable)
}

function examsFromTable(html) {
  if (!/考试日期/.test(html) || !/课程名称/.test(html)) return []
  const rows = tableRows(html)
  const headerIndex = rows.findIndex((cells) => cells.includes('课程名称') && cells.some((c) => c === '考试日期'))
  if (headerIndex < 0) return []
  const header = rows[headerIndex]
  const col = {}
  for (const [key, names] of Object.entries(COLUMNS)) col[key] = header.findIndex((h) => names.includes(h))
  const pick = (cells, key) => (col[key] >= 0 ? cells[col[key]] || '' : '')
  const exams = []
  for (const cells of rows.slice(headerIndex + 1)) {
    if (cells.length < 4) continue
    const name = pick(cells, 'name')
    if (!name || name === '课程名称') continue
    const dateText = pick(cells, 'date')
    const timeText = pick(cells, 'time')
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? dateText : null
    const time = /(\d{1,2}:\d{2})\s*[~\-－—至]\s*(\d{1,2}:\d{2})/.exec(timeText)
    const pad = (t) => (t.length === 4 ? `0${t}` : t)
    const location = pick(cells, 'location')
    const seat = pick(cells, 'seat')
    exams.push({
      name,
      code: pick(cells, 'code'),
      batch: pick(cells, 'batch'),
      category: pick(cells, 'category') || '考试',
      date,
      startTime: date && time ? pad(time[1]) : null,
      endTime: date && time ? pad(time[2]) : null,
      location: UNSET.test(location) ? '' : location,
      seat: UNSET.test(seat) ? '' : seat,
      status: pick(cells, 'status'),
      note: pick(cells, 'note'),
      scheduled: Boolean(date),
    })
  }
  return exams
}

/** @returns {{ exams: object[], error: string }} */
export function parseAcademicExams(input) {
  const seen = new Map()
  for (const { text } of responsesFromInput(input)) {
    for (const exam of examsFromHtml(text)) {
      // 同一场考试可能在多次抓包里重复出现：课程 + 类别 + 日期 相同视为同一场
      const key = [exam.code || exam.name, exam.category, exam.date || ''].join('|')
      if (!seen.has(key)) seen.set(key, exam)
    }
  }
  const exams = [...seen.values()].sort(
    (a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.startTime || '').localeCompare(b.startTime || ''),
  )
  return {
    exams,
    error: exams.length ? '' : '没有在文件里找到考试安排。请在教务系统的「我的考试 / 考试安排」页面抓包。',
  }
}

/** 考试 → DDL 标题，例如「数据结构 期末考试」。 */
export function examTitle(exam) {
  return `${exam.name} ${exam.category}`.trim().slice(0, 200)
}

/** 考试 → 说明文字（时间、地点、座位号、批次）。 */
export function examDescription(exam) {
  const lines = []
  if (exam.date) lines.push(`考试时间：${exam.date} ${exam.startTime || ''}${exam.endTime ? `~${exam.endTime}` : ''}`.trim())
  else lines.push('考试时间：学校尚未安排')
  lines.push(`考试地点：${exam.location || '尚未安排'}`)
  if (exam.seat) lines.push(`座位号：${exam.seat}`)
  if (exam.batch) lines.push(`考试批次：${exam.batch}`)
  if (exam.status && exam.status !== '正常') lines.push(`考试情况：${exam.status}`)
  if (exam.note) lines.push(`说明：${exam.note}`)
  if (exam.code) lines.push(`课程序号：${exam.code}`)
  return lines.join('\n').slice(0, 1000)
}

/** 考试开始时间（北京时间）→ 接口要的带偏移时间；没排时间返回 null（未定日期的考试）。 */
export function examDeadline(exam) {
  if (!exam.date) return null
  return `${exam.date}T${exam.startTime || '08:00'}:00+08:00`
}

export function examMinutes(exam) {
  if (!exam.startTime || !exam.endTime) return null
  const [sh, sm] = exam.startTime.split(':').map(Number)
  const [eh, em] = exam.endTime.split(':').map(Number)
  const minutes = eh * 60 + em - (sh * 60 + sm)
  return minutes > 0 && minutes <= 10000 ? minutes : null
}
