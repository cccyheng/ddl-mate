/**
 * 课表「学期第一周周一」的解析规则 —— 纯函数，可测试。
 *
 * 用户的硬要求（复核对第 11 条把它抓成了一个 CRITICAL）：
 * **改已有课表时绝不能因为全局教学周重新校准就被改写学期起点。**
 *
 * 规则（只有三条，按顺序）：
 * 1. 这条课表自己已经有合法的学期起点 → **原样保留**，
 *    全局校准怎么变都不动它（包括用户没有做任何校准的情况）；
 * 2. 自己没有起点、但做了全局校准 → 用全局校准算出来的那个周一；
 * 3. 两者都没有 → `null`（不猜、不编造）；
 *    调用方（表单/导入）此时应当要求用户先去设置教学周，而不是静默按「每周都上」提交。
 *
 * 这样「新增课表用全局设置」与「已有记录保留自己的锚点」两条要求不会互相冲突。
 */

import { isMonday, isValidDateKey } from './datetime'

export interface AnchorResolutionInput {
  /** 这条课表草稿/记录里已有的学期第一周周一（可能为空）。 */
  existingAnchor?: string | null
  /** 全局教学周校准算出来的学期第一周周一（可能为空）。 */
  calibrationMonday?: string | null
}

export type AnchorSource = 'existing' | 'calibration' | 'none'

export interface AnchorResolution {
  /** 最终应该写进记录的学期第一周周一；没有就是 `null`。 */
  anchor: string | null
  source: AnchorSource
  /** 给用户看的说明（界面可以据此解释为什么这个日期是这样来的）。 */
  note: string
}

/** 一个「可以用」的学期起点：真实日期且真的是周一。 */
export function usableSemesterAnchor(value: string | null | undefined): string | null {
  const text = String(value ?? '').trim()
  if (!text || !isValidDateKey(text) || !isMonday(text)) return null
  return text
}

/** 按上面的三条规则解析出最终锚点。 */
export function resolveSemesterAnchor(input: AnchorResolutionInput): AnchorResolution {
  const existing = usableSemesterAnchor(input.existingAnchor)
  if (existing) {
    return {
      anchor: existing,
      source: 'existing',
      note: `沿用这条课表自己的学期第一周周一（${existing}），不受全局教学周重新校准影响。`,
    }
  }
  const calibration = usableSemesterAnchor(input.calibrationMonday)
  if (calibration) {
    return {
      anchor: calibration,
      source: 'calibration',
      note: `使用全局教学周设置里的学期第一周周一（${calibration}）。`,
    }
  }
  return {
    anchor: null,
    source: 'none',
    note: '还没有学期起点：需要先到「教学周设置」里校准一次，才能保存带教学周的课表。',
  }
}

/** 是否允许在没有全局校准的情况下保存（只有「每周都上」或已有锚点才行）。 */
export function anchorAllowsSavingWithoutCalibration(input: AnchorResolutionInput): boolean {
  return usableSemesterAnchor(input.existingAnchor) !== null
}
