import type { FocusInterval } from './focusTime'
export type HistoryIntervalDraft = { start: string; end: string; original?: FocusInterval }
export function historyWall(ms: number): string { return new Date(ms + 8 * 3600000).toISOString().slice(0, 16) }
export function historyLabel(ms: number): string { return new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') }
function parseWall(text: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) throw new Error('请用滚轮选择完整的日期和时间。')
  const value = Date.parse(`${text}:00+08:00`)
  if (!Number.isFinite(value) || historyWall(value) !== text) throw new Error('日期或时间无效，请重新选择。')
  return value
}
export function historyDrafts(intervals: FocusInterval[]): HistoryIntervalDraft[] {
  return intervals.map(i => ({ start: historyWall(i.start), end: historyWall(i.end), original: { ...i } }))
}
export function historyIntervals(drafts: HistoryIntervalDraft[]): FocusInterval[] {
  return drafts.map(d => ({
    start: d.original && historyWall(d.original.start) === d.start ? d.original.start : parseWall(d.start),
    end: d.original && historyWall(d.original.end) === d.end ? d.original.end : parseWall(d.end),
  }))
}
