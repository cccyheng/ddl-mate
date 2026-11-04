/** 周视图的来源跟随候选保留，不能因框选重识别或清空周次变成无期限重复课表。 */
export function weekViewImportGate(rows, { confirmed, semesterStartDate }) {
  const scoped = rows.filter(row => row.selected !== false && row.sourceWeekView)
  if (!scoped.length) return { blocked: false, reason: '' }
  let reason = ''
  if (scoped.some(row => !Number.isInteger(Number(row.startWeek)) || Number(row.startWeek) < 1 ||
    !Number.isInteger(Number(row.endWeek)) || Number(row.endWeek) > 53 || Number(row.endWeek) < Number(row.startWeek))) {
    reason = '请为周视图中的课程填写完整的起止教学周（1–53），不能留空。'
  } else if (!semesterStartDate) {
    reason = '请填写学期第一周周一，才能把教学周对应到日历日期。'
  } else {
    const date = new Date(`${semesterStartDate}T00:00:00Z`)
    if (Number.isNaN(date.getTime()) || date.getUTCDay() !== 1 || date.toISOString().slice(0, 10) !== semesterStartDate) {
      reason = '学期第一周的起点必须是有效的周一日期。'
    } else if (!confirmed) {
      reason = '请核对下面每条课程的起止教学周和单双周设置，再勾选确认。'
    }
  }
  return { blocked: Boolean(reason), reason }
}
