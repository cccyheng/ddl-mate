/**
 * 智能复习安排（纯函数，不读写任何数据）。
 *
 * 根据考试日期、考试类型、自评难度、每天可用学习时间，以及每天已有的负担
 * （上课时长、当天到期的 DDL、其他考试的复习、其他考试本身），
 * 生成「前疏后密」的复习计划：先把每个主题过一遍，再第二轮练习回顾，考前一天轻量通读。
 */

export const DIFFICULTY = {
  easy: { label: '比较轻松', window: 10, chunk: 45 },
  normal: { label: '一般', window: 14, chunk: 60 },
  hard: { label: '比较吃力', window: 21, chunk: 75 },
}

/** 默认总复习时长（分钟）：按考试类型 × 难度。 */
const TOTAL = {
  final: { easy: 360, normal: 600, hard: 900 },
  midterm: { easy: 180, normal: 300, hard: 480 },
  other: { easy: 120, normal: 180, hard: 300 },
}

export const MAX_SESSIONS = 30
const DEFAULT_PHASES = ['梳理知识框架', '重点章节精学', '刷题 / 真题', '错题回顾']
const FINAL_REVIEW = '考前回顾：错题与重点'

export function examKindOf(title = '') {
  if (/期中/.test(title)) return 'midterm'
  if (/期末|考试周|结课|补考|重修/.test(title)) return 'final'
  return 'other'
}

export function defaultTotalMinutes(kind, difficulty) {
  return (TOTAL[kind] || TOTAL.other)[difficulty] ?? TOTAL.other.normal
}

function dayNumber(key) {
  const [y, m, d] = key.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / 86400000)
}
function keyOf(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10)
}
function weekdayOf(key) {
  return ((new Date(dayNumber(key) * 86400000).getUTCDay() + 6) % 7) + 1
}

/**
 * @param {object} input
 * @param {{ title: string, date: string }} input.exam 考试（date 为北京时间 YYYY-MM-DD）
 * @param {string} input.today
 * @param {string} [input.startDate] 不填则按难度从考前若干天开始（不早于今天）
 * @param {'easy'|'normal'|'hard'} [input.difficulty]
 * @param {number} [input.dailyBudget] 每天可用于学习的分钟数
 * @param {number} [input.totalMinutes] 总复习时长；不填按考试类型和难度给默认值
 * @param {number} [input.sessionMinutes] 每次时长；不填按难度
 * @param {string[]} [input.topics]
 * @param {Record<string, { classMinutes?: number, taskMinutes?: number, revisionMinutes?: number, exams?: string[], examTomorrow?: string[] }>} [input.busy]
 */
export function planSmartRevision(input) {
  const difficulty = DIFFICULTY[input.difficulty] ? input.difficulty : 'normal'
  const conf = DIFFICULTY[difficulty]
  const fail = (reason) => ({ ok: false, reason })
  if (!input.exam?.date) return fail('这场考试还没有日期，排定后再安排复习。')
  const today = dayNumber(input.today)
  const examDay = dayNumber(input.exam.date)
  if (examDay <= today) return fail('考试已经到了或已过，没有考前的日子可以安排。')

  const kind = examKindOf(input.exam.title)
  const total = Math.max(30, Math.min(6000, Math.round(input.totalMinutes || defaultTotalMinutes(kind, difficulty))))
  const chunk = Math.max(20, Math.min(180, Math.round(input.sessionMinutes || conf.chunk)))
  const budget = Math.max(30, Math.min(720, Math.round(input.dailyBudget || 120)))
  const lastDay = examDay - 1
  let firstDay = input.startDate ? dayNumber(input.startDate) : examDay - conf.window
  if (firstDay < today) firstDay = today
  if (firstDay > lastDay) return fail('开始日期不能晚于考试前一天。')
  const busy = input.busy || {}

  // 每天的剩余容量与权重
  const days = []
  const span = lastDay - firstDay
  for (let d = firstDay; d <= lastDay; d += 1) {
    const key = keyOf(d)
    const load = busy[key] || {}
    const reasons = []
    let capacity = budget - (load.taskMinutes || 0) - (load.revisionMinutes || 0)
    if ((load.classMinutes || 0) >= 240) {
      capacity -= 30
      reasons.push('这天课多，排少一点')
    } else if ((load.classMinutes || 0) <= 90) {
      reasons.push(load.classMinutes ? '这天课少' : '这天没课')
    }
    if (load.taskMinutes) reasons.push(`当天还有 ${load.taskMinutes} 分钟 DDL`)
    if (load.exams?.length) {
      capacity = 0
      reasons.push(`当天要考《${load.exams[0]}》`)
    } else if (load.examTomorrow?.length) {
      capacity = Math.floor(capacity / 2)
      reasons.push(`第二天要考《${load.examTomorrow[0]}》，减半`)
    }
    const position = span ? (d - firstDay) / span : 1
    const weekendBonus = weekdayOf(key) >= 6 ? 0.25 : 0
    days.push({
      key,
      left: Math.max(0, capacity),
      weight: 1 + 1.6 * position ** 1.3 + weekendBonus,
      count: 0,
      reasons,
      daysToExam: examDay - d,
    })
  }

  const sessions = []
  const warnings = []
  let remaining = total

  // 考前一天（或最近有空的一天）留给轻量回顾
  const finalMinutes = Math.min(45, Math.max(25, Math.round(chunk * 0.6)))
  const finalDay = [...days].reverse().find((day) => day.left >= finalMinutes)
  if (finalDay) {
    finalDay.left -= finalMinutes
    finalDay.count += 1
    remaining -= finalMinutes
    sessions.push({ date: finalDay.key, minutes: finalMinutes, final: true, reasons: finalDay.reasons })
  }

  // 其余按「越近越密、空闲多的日子优先、同一天最多两次」贪心分配
  while (remaining > chunk * 0.4 && sessions.length < MAX_SESSIONS) {
    const minutes = Math.min(chunk, Math.max(20, remaining))
    let best = null
    let bestScore = 0
    for (const day of days) {
      if (day.left < Math.min(minutes, chunk * 0.6) || day.count >= 2) continue
      const score = day.weight * Math.min(1, day.left / chunk) * (day.count ? 0.35 : 1)
      if (score > bestScore) {
        bestScore = score
        best = day
      }
    }
    if (!best) break
    const take = Math.min(minutes, best.left)
    best.left -= take
    best.count += 1
    remaining -= take
    sessions.push({ date: best.key, minutes: take, final: false, reasons: best.reasons })
  }

  if (remaining > chunk * 0.4) {
    const hours = Math.round((remaining / 60) * 10) / 10
    warnings.push(
      sessions.length >= MAX_SESSIONS
        ? `一份安排最多 ${MAX_SESSIONS} 次复习，还有约 ${hours} 小时没排进去，可以把每次时长调长一点。`
        : `考前的空闲时间不够，还差约 ${hours} 小时。可以提前开始、调高每天学习时间，或降低目标时长。`,
    )
  }
  if (!sessions.length) return fail('考前这些天都排满了（课程、DDL 或其他考试），没有空档。可以提前开始或调高每天的学习时间。')

  sessions.sort((a, b) => a.date.localeCompare(b.date) || Number(a.final) - Number(b.final))
  assignTopics(sessions, (input.topics || []).map((t) => String(t).trim()).filter(Boolean))

  const planned = sessions.reduce((sum, s) => sum + s.minutes, 0)
  const result = sessions.map((s) => {
    const daysToExam = examDay - dayNumber(s.date)
    const why = [`离考试 ${daysToExam} 天`, ...s.reasons].slice(0, 3)
    return { date: s.date, minutes: s.minutes, topic: s.topic, title: `复习：${s.topic}`, phase: s.phase, reasons: why }
  })
  return {
    ok: true,
    sessions: result,
    totalMinutes: total,
    plannedMinutes: planned,
    startDate: keyOf(firstDay),
    endDate: keyOf(lastDay),
    kind,
    difficulty,
    warnings,
  }
}

/** 主题分配：第一轮按顺序学一遍；第二轮从前往后练习回顾（间隔重复）；最后一次是考前回顾。 */
function assignTopics(sessions, topics) {
  const regular = sessions.filter((s) => !s.final)
  for (const s of sessions) if (s.final) Object.assign(s, { topic: FINAL_REVIEW, phase: 'final' })
  if (!regular.length) return
  if (!topics.length) {
    regular.forEach((s, i) => {
      const phase = DEFAULT_PHASES[Math.min(DEFAULT_PHASES.length - 1, Math.floor((i / regular.length) * DEFAULT_PHASES.length))]
      Object.assign(s, { topic: phase, phase: i / regular.length < 0.5 ? 'learn' : 'practice' })
    })
    return
  }
  const total = regular.length
  const T = topics.length
  // 次数不比主题多：全部用来第一轮学习，相邻主题合并
  const learnSlots = total <= T ? total : Math.min(total - 1, Math.max(T, Math.ceil(total * 0.5)))
  const practiceSlots = total - learnSlots
  const learn = spread(topics, learnSlots)
  const practice = spread(topics, practiceSlots)
  regular.forEach((s, i) => {
    if (i < learnSlots) Object.assign(s, { topic: learn[i], phase: 'learn' })
    else Object.assign(s, { topic: `练习回顾：${practice[i - learnSlots]}`, phase: 'practice' })
  })
}

/**
 * 把主题按顺序摊到若干次里：次数少于主题时相邻主题合并（每个主题都不落下）；
 * 次数多于主题时按顺序给前面的主题多一次，标「（续）」。
 */
function spread(topics, slots) {
  const T = topics.length
  const out = []
  if (!slots) return out
  if (slots <= T) {
    for (let i = 0; i < slots; i += 1) {
      const from = Math.floor((i * T) / slots)
      const to = Math.floor(((i + 1) * T) / slots)
      out.push(topics.slice(from, to).join('、'))
    }
    return out
  }
  let previous = -1
  for (let i = 0; i < slots; i += 1) {
    const index = Math.floor((i * T) / slots)
    out.push(index === previous ? `${topics[index]}（续）` : topics[index])
    previous = index
  }
  return out
}
