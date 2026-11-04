import type { Course, Task } from './types'
import { taskStatusLabels } from './types'
import { deadlineToShanghaiWallClock } from './datetime'

export type SearchCategory = 'TASK' | 'COURSE' | 'EXAM' | 'NOTE'
export type SearchFilter = 'ALL' | SearchCategory
export type SearchOwner = { kind: 'task' | 'course'; id: number }
export const SEARCH_PAGE_SIZE = 30
export const searchCategoryLabels: Record<SearchFilter, string> = {
  ALL: '全部', TASK: '任务', COURSE: '课程', EXAM: '考试', NOTE: '笔记与原文',
}
interface SearchField { label: string; text: string; normalized: string }
export interface SearchDocument {
  key: string
  category: SearchCategory
  owner: SearchOwner
  title: string
  subtitle: string
  normalizedTitle: string
  haystack: string
  fields: SearchField[]
}
export interface SearchResult {
  key: string
  category: SearchCategory
  owner: SearchOwner
  title: string
  subtitle: string
  snippet: string
}
export interface SearchSnapshot { tasks: readonly Task[]; courses: readonly Course[]; originalTexts: ReadonlyMap<number, string> }

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}
function field(label: string, text: string | null | undefined): SearchField {
  const display = (text ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim()
  return { label, text: display, normalized: normalizeSearchText(display) }
}
function document(category: SearchCategory, owner: SearchOwner, title: string, subtitle: string, fields: SearchField[]): SearchDocument {
  const populated = fields.filter(f => f.text)
  return { key: `${category}:${owner.kind}:${owner.id}`, category, owner, title, subtitle,
    normalizedTitle: normalizeSearchText(title), fields: populated,
    haystack: normalizeSearchText([title, subtitle, ...populated.map(f => f.text)].join(' ')) }
}

/** Derived local index only. Never persists queries or sends source content over the network. */
export function buildSearchIndex(snapshot: SearchSnapshot): SearchDocument[] {
  const result: SearchDocument[] = []
  const courseMap = new Map(snapshot.courses.map(c => [c.id, c]))
  for (const course of snapshot.courses) {
    const owner: SearchOwner = { kind: 'course', id: course.id }
    const subtitle = [course.instructor, course.semester].filter(Boolean).join(' · ')
    const notes = [field('课程备注', course.note)]
    result.push(document('COURSE', owner, course.name, subtitle, notes))
    if (notes.some(f => f.text)) result.push(document('NOTE', owner, course.name, `课程备注 · ${subtitle || '课程'}`, notes))
  }
  for (const task of snapshot.tasks) {
    const owner: SearchOwner = { kind: 'task', id: task.id }
    const course = task.courseId === null ? undefined : courseMap.get(task.courseId)
    const deadline = task.deadline ? deadlineToShanghaiWallClock(task.deadline).replace('T', ' ') : '未设截止日期'
    const subtitle = [course?.name, taskStatusLabels[task.status], deadline].filter(Boolean).join(' · ')
    const notes = [field('任务说明', task.description), field('通知原文', snapshot.originalTexts.get(task.id))]
    const details = [...notes, field('提交要求', task.submitRequirement), field('提交方式', task.submitMethod), field('授课老师', course?.instructor)]
    result.push(document(task.type === 'EXAM' ? 'EXAM' : 'TASK', owner, task.title, subtitle, details))
    // One notes result per owner, even when description and original notification both match.
    if (notes.some(f => f.text)) result.push(document('NOTE', owner, task.title, `任务说明 / 通知原文 · ${course?.name ?? '未关联课程'}`, notes))
  }
  return result
}

function excerpt(text: string, tokens: string[]): string {
  const normalized = normalizeSearchText(text)
  const indices = tokens.map(t => normalized.indexOf(t)).filter(i => i >= 0)
  const index = indices.length ? Math.min(...indices) : 0
  const chars = Array.from(text)
  const start = Math.max(0, Array.from(text.slice(0, index)).length - 22)
  return `${start ? '…' : ''}${chars.slice(start, start + 120).join('')}${start + 120 < chars.length ? '…' : ''}`
}
function snippet(doc: SearchDocument, tokens: string[]): string {
  let best: SearchField | undefined, score = 0
  for (const f of doc.fields) {
    const count = tokens.filter(t => f.normalized.includes(t)).length
    if (count > score) { best = f; score = count }
  }
  best ??= doc.fields[0]
  return best ? `${best.label}：${excerpt(best.text, tokens)}` : ''
}

export function searchLocal(index: readonly SearchDocument[], query: string, filter: SearchFilter = 'ALL', requestedPage = 0): {
  items: SearchResult[]; counts: Record<SearchFilter, number>; total: number; page: number; pages: number; hasQuery: boolean
} {
  const normalized = normalizeSearchText(query)
  const counts: Record<SearchFilter, number> = { ALL: 0, TASK: 0, COURSE: 0, EXAM: 0, NOTE: 0 }
  if (!normalized) return { items: [], counts, total: 0, page: 0, pages: 0, hasQuery: false }
  const tokens = [...new Set(normalized.split(' '))]
  const matches = index.filter(doc => tokens.every(token => doc.haystack.includes(token)))
  for (const doc of matches) { counts.ALL++; counts[doc.category]++ }
  const rank = (doc: SearchDocument): number => doc.normalizedTitle === normalized ? 0
    : doc.normalizedTitle.startsWith(normalized) ? 1 : tokens.every(t => doc.normalizedTitle.includes(t)) ? 2 : 3
  const chosen = matches.filter(doc => filter === 'ALL' || doc.category === filter)
    .sort((a, b) => rank(a) - rank(b) || (a.normalizedTitle < b.normalizedTitle ? -1 : a.normalizedTitle > b.normalizedTitle ? 1 : 0) || a.key.localeCompare(b.key))
  const pages = Math.ceil(chosen.length / SEARCH_PAGE_SIZE)
  const page = Math.max(0, Math.min(Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0, pages - 1))
  const items = chosen.slice(page * SEARCH_PAGE_SIZE, (page + 1) * SEARCH_PAGE_SIZE).map(doc => ({
    key: doc.key, category: doc.category, owner: doc.owner, title: doc.title, subtitle: doc.subtitle, snippet: snippet(doc, tokens),
  }))
  return { items, counts, total: chosen.length, page, pages, hasQuery: true }
}
