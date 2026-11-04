/**
 * 课表照片的**版式路由**（浏览器与伴侣服务共用）。
 *
 * 一张图先看两种几何证据，再决定跑哪条流水线：
 *   1. `tableGridLayout`：有没有成对的贯穿画面的横线/竖线（线框表格）；
 *   2. `weekGridLayout`：有没有成片的卡片底色（手机端周视图截图）。
 *
 * 两者都存在时**优先有线框表格**：真实手机拍的横版课表本来就是线框表格，
 * 而"哪种颜色占多数"的卡片判定在蓝底/白底混排时会把底色认错，是已知的假阳性来源。
 * 先跑的那条如果一条课程都没读出来（或抛结构失败），还有另一条兜底；
 * 两条都不行就交给调用方的整图回退（同样失败时由整图解析器给出"只读到表头"的明确失败）。
 *
 * 这里只做编排与合并诊断，不发起 OCR、不写文件、不猜任何课程内容。
 */

import { OcrLayoutError } from './structuralLabels.js'
import { analyzeTableGridGeometry, recognizeTableGrid } from './tableGridOcr.js'
import { analyzeWeekGridGeometry, recognizeWeekGrid } from './weekGridOcr.js'

/** 几何判定（不跑 OCR），用于测试与诊断。 */
export function chooseTimetableLayout(imageData, options = {}) {
  const card = analyzeWeekGridGeometry(imageData)
  const table = analyzeTableGridGeometry(imageData, options.geometryOptions)
  const choice = table.matched ? 'table-grid' : card.matched ? 'week-grid' : 'fallback'
  return {
    choice,
    card,
    table,
    reason: table.matched
      ? '找到了贯穿画面的横线/竖线，按线框表格切格'
      : card.matched
        ? '没有线框网格，但有成片卡片底色，按卡片周视图切块'
        : '既没有线框网格也没有卡片底色，交给整图识别',
  }
}

function isStructuralFailure(error) {
  return error instanceof OcrLayoutError || error?.code === 'STRUCTURE_NOT_FOUND'
}

/**
 * 统一入口：返回与 `recognizeWeekGrid` 同形状的结果。
 * `matched=false`（含取消）表示这张图没读出一门课，调用方应走整图回退。
 */
export async function recognizeTimetableLayout(imageData, options = {}) {
  const { recognize, createCanvas, isCancelled = () => false, onStage = () => {} } = options || {}
  const card = analyzeWeekGridGeometry(imageData)
  const table = analyzeTableGridGeometry(imageData, options.geometryOptions)
  const baseDiagnostics = {
    cardMatched: Boolean(card.matched),
    tableMatched: Boolean(table.matched),
    cardReason: card.reason ?? '',
    tableReason: table.reason ?? '',
  }

  const attempts = []
  if (table.matched) {
    attempts.push({
      kind: 'table-grid',
      stage: '正在按表格网格逐格识别…',
      run: () => recognizeTableGrid(imageData, { recognize, createCanvas, isCancelled, onStage, geometry: table, recognizeCellDetails: options.recognizeCellDetails }),
    })
  }
  if (card.matched) {
    attempts.push({
      kind: 'week-grid',
      stage: '正在按卡片周视图识别…',
      run: () => recognizeWeekGrid(imageData, { recognize, createCanvas, isCancelled, onStage }),
    })
  }

  if (!attempts.length) {
    return {
      matched: false,
      cancelled: false,
      candidates: [],
      warnings: [],
      diagnostics: { ...baseDiagnostics, choice: 'fallback', layoutReason: '没有找到任何课表版式特征' },
    }
  }

  const failures = []
  for (const attempt of attempts) {
    if (isCancelled()) {
      return { matched: false, cancelled: true, layout: attempt.kind, candidates: [], warnings: [], diagnostics: baseDiagnostics }
    }
    onStage(attempt.stage, 0.03)
    try {
      const result = await attempt.run()
      if (result?.cancelled) {
        return { matched: false, cancelled: true, layout: attempt.kind, candidates: [], warnings: [], diagnostics: baseDiagnostics }
      }
      if (result?.matched && (result.candidates?.length ?? 0) > 0) {
        return {
          matched: true,
          cancelled: false,
          layout: result.layout ?? attempt.kind,
          week: result.week ?? null,
          candidates: result.candidates,
          warnings: result.warnings ?? [],
          diagnostics: {
            ...(result.diagnostics ?? {}),
            choice: attempt.kind,
            ...baseDiagnostics,
            attempts: [...failures.map((failure) => failure.kind), attempt.kind],
          },
        }
      }
      failures.push({ kind: attempt.kind, reason: result?.reason ?? '没有产出课程候选' })
    } catch (error) {
      if (isStructuralFailure(error)) {
        failures.push({ kind: attempt.kind, reason: error.message, code: error.code ?? 'STRUCTURE_NOT_FOUND' })
        continue
      }
      // 几何/OCR 的其它异常也不能把整次识别打死：记录原因，让另一条分支继续试。
      failures.push({ kind: attempt.kind, reason: error?.message ?? String(error) })
    }
  }

  return {
    matched: false,
    cancelled: false,
    candidates: [],
    warnings: failures.map(
      (failure) => `${failure.kind === 'table-grid' ? '表格网格' : '卡片周视图'}没有读出课程：${failure.reason}`,
    ),
    diagnostics: { ...baseDiagnostics, choice: 'fallback', layoutReason: '两种版式都试过，但没有产出课程候选', attempts: failures },
  }
}
