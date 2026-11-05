/**
 * 课表导入前的检查：返回第一条挡住导入的原因（中文，指明是哪门课、缺什么），没问题返回 ''。
 *
 * 按钮旁的实时提示和点击"确认导入"时的检查共用这一个函数，两处说法保持一致；
 * 以前按钮在不满足条件时直接变灰，用户点了没反应也不知道差什么。
 */

const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

function label(row) {
  const name = String(row.courseName || '').trim()
  return name ? `「${name}」` : '有一条候选'
}

/**
 * @param {Array<object>} rows 勾选的候选
 * @param {{ courses?: Array<{code?: string}>, gate?: {blocked: boolean, reason: string}, semesterStartDate?: string }} context
 */
export function importBlockReason(rows, { courses = [], gate = null, semesterStartDate = '' } = {}) {
  if (!rows?.length) return '请至少勾选一条要导入的课表。'

  for (const row of rows) {
    const missing = []
    if (row.courseMode === 'existing') {
      if (!row.existingCourseId) missing.push('要归入的已有课程')
    } else if (!String(row.courseName || '').trim()) {
      missing.push('课程名')
    }
    if (!row.weekday) missing.push('星期')
    if (!row.startTime) missing.push('开始时间')
    if (!row.endTime) missing.push('结束时间')
    if (missing.length) return `${label(row)}还缺少${missing.join('、')}，请在下面的表格里补全。`
  }

  for (const row of rows) {
    if (row.startTime >= row.endTime) {
      const day = WEEKDAY_NAMES[Number(row.weekday)] || ''
      return `${label(row)}${day}的开始时间（${row.startTime}）不早于结束时间（${row.endTime}），请修正。`
    }
  }

  const taken = new Set(courses.map((course) => String(course.code || '').trim().toLowerCase()).filter(Boolean))
  const seen = new Map()
  for (const row of rows) {
    if (row.courseMode === 'existing') continue
    const code = String(row.code || '').trim().toLowerCase()
    if (!code) return `${label(row)}缺少课程代码，请填写一个（例如 MA101）。`
    if (taken.has(code)) return `${label(row)}的课程代码 ${row.code} 已被你的其他课程占用，请换一个，或改为"已有课程"。`
    const name = String(row.courseName || '').trim()
    if (seen.has(code) && seen.get(code) !== name) {
      return `「${seen.get(code)}」和${label(row)}用了同一个课程代码 ${row.code}，请换一个。`
    }
    seen.set(code, name)
  }

  if (gate?.blocked) return gate.reason

  if (!semesterStartDate && rows.some((row) => row.startWeek && row.endWeek)) {
    return '填写了起止教学周，需要在上方选择"学期第一周周一"（必须是周一）；如果不限定周次，可以清空起止周。'
  }
  if (!semesterStartDate && rows.some((row) => (row.weekPattern || 'ALL') !== 'ALL')) {
    return '单周/双周需要在上方选择"学期第一周周一"，或把周次规律改为"每周"。'
  }
  return ''
}
