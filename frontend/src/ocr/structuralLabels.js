/**
 * 「结构性标签」守卫 —— **转发文件**。
 *
 * 真正的实现只有一份，在 `mobile/src/domain/headerLabels.ts`：
 *   - 手机端（Metro）必须在自己的项目根里才能打包，所以实现放在 mobile；
 *   - 前端（Vite）与伴侣服务（Node）通过本文件引用同一份实现，
 *     因此浏览器、离线校验、伴侣服务、手机导入校验**永远是同一套规则**。
 *
 * 这里不做任何行为复制：新增/修改规则只改 `headerLabels.ts`。
 * 跨端一致性由 `frontend/tests/structuralLabels.test.mjs` 的等价性测试钉住。
 */

export {
  HEADER_ONLY_MESSAGE,
  OcrLayoutError,
  classifyStructuralLabel,
  isHeaderCardText,
  isHeaderOnlyResult,
  isStructuralCandidate,
  isStructuralLabel,
  namePartOf,
} from '../../../mobile/src/domain/headerLabels.ts'
