/**
 * 从教务系统抓包里读出课表，转成导入页的候选（不联网、不上传，文件只在浏览器里解析）。
 *
 * 支持两种来源（都可以直接是 HAR 抓包文件，也可以是单独的响应 JSON / HTML）：
 *   1. 微信小程序接口 …/academic/courseTake 的 JSON：
 *      { data: { courses: [{ name, teacher, classroom, weeks(星期 1–7), startSection, endSection,
 *        range(30 位 01，第 i 位=第 i+1 周) }], semesterBeginAt(毫秒) } }
 *   2. 教务网页（EAMS）courseTableForStd!courseTable.action 的 HTML：
 *      逐条 `new TaskActivity(…,"课程号(课程序号)","课程名("+lessonNo+")",roomId,"教室","0101…")`
 *      + `index = 星期(0 起)*unitCount + 节次(0 起)`；页面里还带「1-2 8:00-9:35」这样的节次时间。
 *
 * 学校原始数据的周次很零碎（如 "3,5-18周"、"1,5,7,…,15周"），而这里的一条课表只能是
 * 「起止周 + 每周/单周/双周」，所以按周次拆成若干段；同一时段的多位老师 / 多个教室合并成一条。
 */

/** 大连海事大学的节次时间（来自教务网页，两节连上）。网页里能读到时以网页为准。 */
export const DLMU_PERIOD_PAIRS = [
  { start: 1, end: 2, from: '08:00', to: '09:35' },
  { start: 3, end: 4, from: '10:00', to: '11:35' },
  { start: 5, end: 6, from: '13:30', to: '15:05' },
  { start: 7, end: 8, from: '15:30', to: '17:05' },
  { start: 9, end: 10, from: '18:00', to: '19:35' },
]

const MAX_WEEK = 53

function pad(n) {
  return String(n).padStart(2, '0')
}

function clock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim())
  return match ? `${pad(Number(match[1]))}:${match[2]}` : null
}

function addMinutes(value, minutes) {
  const [h, m] = value.split(':').map(Number)
  const total = h * 60 + m + minutes
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

/* ------------------------------------------------------------- 输入整理 */

/** 把 HAR / 单个 JSON / HTML 文本整理成若干「响应」：{ url, text } */
export function responsesFromInput(input) {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return responsesFromInput(JSON.parse(trimmed))
      } catch {
        /* 不是 JSON，当 HTML 处理 */
      }
    }
    return [{ url: '', text: input }]
  }
  const entries = input?.log?.entries
  if (Array.isArray(entries)) {
    const list = []
    for (const entry of entries) {
      const content = entry?.response?.content
      let text = content?.text
      if (!text) continue
      if (content.encoding === 'base64') {
        try {
          text = new TextDecoder('utf-8').decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)))
        } catch {
          continue
        }
      }
      list.push({ url: String(entry?.request?.url || ''), text })
    }
    return list
  }
  if (input && typeof input === 'object') return [{ url: '', text: JSON.stringify(input) }]
  return []
}

/* ------------------------------------------------------------- 两种来源 → 统一记录 */

/** 统一记录：{ name, code, teacher, location, weekday, startSection, endSection, weeks:number[] } */
function courseTakeRecords(json) {
  const courses = json?.data?.courses
  if (!Array.isArray(courses)) return null
  const records = []
  for (const c of courses) {
    const bits = String(c.range || '')
    const weeks = []
    for (let i = 0; i < bits.length && i < MAX_WEEK; i += 1) if (bits[i] === '1') weeks.push(i + 1)
    records.push({
      name: String(c.name || '').trim(),
      code: '',
      teacher: String(c.teacher || '').trim(),
      location: String(c.classroom || '').trim(),
      weekday: Number(c.weeks),
      startSection: Number(c.startSection),
      endSection: Number(c.endSection),
      weeks,
    })
  }
  let semesterStartDate = ''
  const begin = Number(json?.data?.semesterBeginAt)
  if (Number.isFinite(begin) && begin > 0) {
    // 时间戳是北京时间 0 点；+8 小时后取 UTC 日期就是当天
    semesterStartDate = new Date(begin + 8 * 3600 * 1000).toISOString().slice(0, 10)
  }
  const undefinedItems = (json?.data?.extra || [])
    .map((x) => String(x?.title || '').trim())
    .filter(Boolean)
  return { records, semesterStartDate, undefinedItems }
}

function unquote(value) {
  return value.replace(/\\(.)/g, '$1')
}

function eamsRecords(html) {
  if (!html.includes('TaskActivity')) return null
  const records = []
  const block = /var actTeachers\s*=\s*(\[[^\]]*\]);[\s\S]*?new TaskActivity\(([\s\S]*?)\);\s*((?:index\s*=\s*\d+\s*\*\s*unitCount\s*\+\s*\d+;\s*table0\.activities\[index\]\[table0\.activities\[index\]\.length\]\s*=\s*activity;\s*)+)/g
  for (const match of html.matchAll(block)) {
    const teachers = [...match[1].matchAll(/name\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => unquote(m[1]).trim()).filter(Boolean)
    const strings = [...match[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unquote(m[1]))
    const weekIndex = strings.findIndex((s) => /^[01]{10,}$/.test(s))
    if (weekIndex < 0) continue
    const courseId = strings[0] || ''
    const code = (/\(([^()]+)\)\s*$/.exec(courseId) || [])[1] || ''
    // 课程名：形如 "数据结构(" + lessonNo + ")"，取掉结尾的 "("；房间名在周次串前一个
    const rawName = strings[1] || ''
    const name = rawName.replace(/\($/, '').replace(/\([^()]*\)$/, (tail) => (code && tail === `(${code})` ? '' : tail)).trim()
    const location = (strings[weekIndex - 1] || '').trim()
    const bits = strings[weekIndex]
    const weeks = []
    for (let i = 1; i < bits.length && i <= MAX_WEEK; i += 1) if (bits[i] === '1') weeks.push(i)
    const slots = [...match[3].matchAll(/index\s*=\s*(\d+)\s*\*\s*unitCount\s*\+\s*(\d+)/g)].map((m) => ({
      day: Number(m[1]),
      unit: Number(m[2]),
    }))
    // 同一天连续的节次合成一段
    const byDay = new Map()
    for (const slot of slots) {
      if (!byDay.has(slot.day)) byDay.set(slot.day, [])
      byDay.get(slot.day).push(slot.unit)
    }
    for (const [day, units] of byDay) {
      units.sort((a, b) => a - b)
      let runStart = units[0]
      let prev = units[0]
      const flush = () =>
        records.push({
          name,
          code,
          teacher: teachers.join('、'),
          location,
          weekday: day + 1,
          startSection: runStart + 1,
          endSection: prev + 1,
          weeks,
        })
      for (const unit of units.slice(1)) {
        if (unit === prev + 1) {
          prev = unit
          continue
        }
        flush()
        runStart = unit
        prev = unit
      }
      flush()
    }
  }
  return { records, semesterStartDate: '', undefinedItems: [] }
}

/** 页面里「1-2 8:00-9:35」这样的节次时间。 */
export function periodPairsFromHtml(html) {
  const text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
  const pairs = new Map()
  for (const m of text.matchAll(/(?:^|\s)(\d{1,2})\s*-\s*(\d{1,2})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g)) {
    const start = Number(m[1])
    const end = Number(m[2])
    const from = clock(m[3])
    const to = clock(m[4])
    if (start >= 1 && end >= start && end <= 20 && from && to && from < to) pairs.set(start, { start, end, from, to })
  }
  return [...pairs.values()].sort((a, b) => a.start - b.start)
}

/* ------------------------------------------------------------- 周次拆段 */

/**
 * 周次集合 → 若干段 { startWeek, endWeek, weekPattern }：
 * 先取连续的整段（≥2 周，每周）；剩下零散的周按同奇偶、间隔 2 串成单周/双周段；单独一周就是 N–N 周。
 */
export function weekSegments(weeks) {
  const sorted = [...new Set(weeks.map(Number))].filter((w) => w >= 1 && w <= MAX_WEEK).sort((a, b) => a - b)
  const segments = []
  const singles = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1
    if (j > i) segments.push({ startWeek: sorted[i], endWeek: sorted[j], weekPattern: 'ALL' })
    else singles.push(sorted[i])
    i = j + 1
  }
  const used = new Set()
  for (const week of singles) {
    if (used.has(week)) continue
    const run = [week]
    used.add(week)
    let next = week + 2
    while (singles.includes(next) && !used.has(next)) {
      run.push(next)
      used.add(next)
      next += 2
    }
    if (run.length === 1) segments.push({ startWeek: week, endWeek: week, weekPattern: 'ALL' })
    else segments.push({ startWeek: run[0], endWeek: run[run.length - 1], weekPattern: run[0] % 2 ? 'ODD' : 'EVEN' })
  }
  return segments.sort((a, b) => a.startWeek - b.startWeek)
}

export function describeSegment(segment) {
  const range = segment.startWeek === segment.endWeek ? `第 ${segment.startWeek} 周` : `第 ${segment.startWeek}–${segment.endWeek} 周`
  return segment.weekPattern === 'ODD' ? `${range}（单周）` : segment.weekPattern === 'EVEN' ? `${range}（双周）` : range
}

/* ------------------------------------------------------------- 节次 → 时间 */

function sectionTimes(startSection, endSection, pairs) {
  const startPair = pairs.find((p) => startSection >= p.start && startSection <= p.end)
  const endPair = pairs.find((p) => endSection >= p.start && endSection <= p.end)
  if (!startPair || !endPair) return { startTime: '', endTime: '', exact: false }
  const exact = startSection === startPair.start && endSection === endPair.end
  // 只有两节连上的时间是确定的；从一大节中间开始/结束时按 45 分钟一节估算，并提示核对
  const startTime = startSection === startPair.start ? startPair.from : addMinutes(startPair.from, 50)
  const endTime = endSection === endPair.end ? endPair.to : addMinutes(endPair.from, 45)
  return { startTime, endTime, exact }
}

/* ------------------------------------------------------------- 合并 + 输出候选 */

/**
 * @returns {{ source: string, candidates: object[], semesterStartDate: string, periodPairs: object[],
 *            warnings: string[], summary: string }}
 */
export function parseAcademicTimetable(input, { periodPairs = DLMU_PERIOD_PAIRS } = {}) {
  const responses = responsesFromInput(input)
  let parsed = null
  let source = ''
  let semesterStartDate = ''
  let pairs = []
  const undefinedItems = []
  for (const { url, text } of responses) {
    if (!pairs.length && /\d-\d+\s+\d{1,2}:\d{2}-\d{1,2}:\d{2}/.test(text.replace(/<[^>]+>/g, ' '))) {
      pairs = periodPairsFromHtml(text)
    }
    let json = null
    if (/^\s*[{[]/.test(text)) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    const fromJson = json ? courseTakeRecords(json) : null
    if (fromJson?.records.length) {
      semesterStartDate ||= fromJson.semesterStartDate
      undefinedItems.push(...fromJson.undefinedItems)
      // 教务网页带课程号，优先用它；小程序数据只在没有网页数据时使用
      if (!parsed || source !== 'eams') {
        parsed = fromJson.records
        source = 'courseTake'
      }
      continue
    }
    const fromHtml = !json ? eamsRecords(text) : null
    if (fromHtml?.records.length && (source !== 'eams' || fromHtml.records.length > parsed.length)) {
      parsed = fromHtml.records
      source = 'eams'
    }
    void url
  }
  if (!parsed) {
    return {
      source: '',
      candidates: [],
      semesterStartDate: '',
      periodPairs: [],
      warnings: [],
      summary: '',
      error: '没有在文件里找到课表数据。请在课表页面抓包：小程序的 academic/courseTake 接口，或教务网页的「我的课表」页面。',
    }
  }
  if (!pairs.length) pairs = periodPairs

  // 同一门课、同一星期、同一节次：按周汇总老师和教室
  const groups = new Map()
  for (const r of parsed) {
    if (!r.name || !(r.weekday >= 1 && r.weekday <= 7) || !(r.startSection >= 1) || !(r.endSection >= r.startSection)) continue
    const key = [r.name, r.weekday, r.startSection, r.endSection].join('|')
    if (!groups.has(key)) groups.set(key, { ...r, perWeek: new Map(), codes: new Set() })
    const group = groups.get(key)
    if (r.code) group.codes.add(r.code)
    for (const week of r.weeks) {
      if (!group.perWeek.has(week)) group.perWeek.set(week, { teachers: new Set(), rooms: new Set() })
      const slot = group.perWeek.get(week)
      for (const t of r.teacher.split(/[、,，]/).map((x) => x.trim()).filter(Boolean)) slot.teachers.add(t)
      if (r.location) slot.rooms.add(r.location)
    }
  }

  const candidates = []
  const warnings = []
  let skippedNoWeeks = 0
  for (const group of groups.values()) {
    if (!group.perWeek.size) {
      skippedNoWeeks += 1
      continue
    }
    // 老师/教室相同的周归为一组，再拆成连续段
    const byPlace = new Map()
    for (const [week, slot] of group.perWeek) {
      const teacher = [...slot.teachers].join('、')
      const location = [...slot.rooms].join(' / ')
      const placeKey = `${teacher}|${location}`
      if (!byPlace.has(placeKey)) byPlace.set(placeKey, { teacher, location, weeks: [] })
      byPlace.get(placeKey).weeks.push(week)
    }
    const times = sectionTimes(group.startSection, group.endSection, pairs)
    for (const place of byPlace.values()) {
      for (const segment of weekSegments(place.weeks)) {
        const rowWarnings = []
        if (!times.startTime) rowWarnings.push(`没有第 ${group.startSection}–${group.endSection} 节的时间，请手动填写`)
        else if (!times.exact) rowWarnings.push('这节课不是从一大节开头/结尾上的，时间是按每节 45 分钟估算的，请核对')
        candidates.push({
          name: group.name,
          code: [...group.codes][0] || '',
          teacher: place.teacher,
          location: place.location,
          weekday: group.weekday,
          startTime: times.startTime,
          endTime: times.endTime,
          periodStart: group.startSection,
          periodEnd: group.endSection,
          startWeek: segment.startWeek,
          endWeek: segment.endWeek,
          weekPattern: segment.weekPattern,
          warnings: rowWarnings,
          rawText: `${group.name} 周${'一二三四五六日'[group.weekday - 1]} 第${group.startSection}-${group.endSection}节 ${describeSegment(segment)} ${place.location} ${place.teacher}`.trim(),
        })
      }
    }
  }
  // 课程的任课教师：这门课所有记录里出现过的老师，按上课次数从多到少（理论课老师排在实验老师前面）
  const weight = new Map()
  for (const c of candidates) {
    const weeks = c.endWeek - c.startWeek + 1
    const count = c.weekPattern === 'ALL' ? weeks : Math.ceil(weeks / 2)
    if (!weight.has(c.name)) weight.set(c.name, new Map())
    for (const t of c.teacher.split('、').filter(Boolean)) {
      weight.get(c.name).set(t, (weight.get(c.name).get(t) || 0) + count)
    }
  }
  for (const c of candidates) {
    const names = [...(weight.get(c.name) || new Map()).entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
    let instructor = ''
    for (const t of names) {
      const next = instructor ? `${instructor}、${t}` : t
      if (next.length > 64) break
      instructor = next
    }
    c.instructor = instructor
  }

  candidates.sort(
    (a, b) => a.weekday - b.weekday || a.periodStart - b.periodStart || a.startWeek - b.startWeek || a.name.localeCompare(b.name, 'zh'),
  )

  if (skippedNoWeeks) warnings.push(`有 ${skippedNoWeeks} 条记录没有任何上课周，已跳过。`)
  for (const item of undefinedItems) warnings.push(`学校尚未排定，未导入：${item}`)
  const label = source === 'eams' ? '教务网页课表' : '小程序课表接口'
  const summary =
    `来源：${label}；原始 ${parsed.length} 条，合并、按周次拆段后 ${candidates.length} 条。\n` +
    `节次时间：${pairs.map((p) => `${p.start}-${p.end} 节 ${p.from}-${p.to}`).join('；')}\n\n` +
    candidates.map((c) => c.rawText).join('\n')
  return { source, candidates, semesterStartDate, periodPairs: pairs, warnings, summary, error: '' }
}
