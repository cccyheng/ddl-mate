/**
 * V1.2 时间助手的并发与「过期建议」守卫（纯函数，不依赖 Vue / DOM / 网络）。
 *
 * 为什么单独一个模块：助手是**异步**解析，用户随时可能在结果返回前改短语、改参考时间、
 * 换课程、手工改表单里的 DDL，或者把组件关掉 / 卸载。任何迟到的响应都不能污染新的输入，
 * 也不能让「采用此时间」作用在已经不匹配的建议上。这些规则必须能单测，所以抽成纯函数。
 */

/** 快捷填词：都必须是后端确定性支持、且不需要课程选择的短语。 */
export const TIME_ASSISTANT_EXAMPLES = [
  { text: '今天 22:00', label: '今天 22:00' },
  { text: '明天 18:00', label: '明天 18:00' },
  { text: '后天 09:00', label: '后天 09:00' },
  { text: '本周五 18:00', label: '本周五 18:00' },
  { text: '下周五 12:00', label: '下周五 12:00' },
]

/** 需要先选课程的课前说法示例（只在说明里出现，不直接填进输入框）。 */
export const TIME_ASSISTANT_COURSE_EXAMPLES = ['下节课前', '下次上课前', '下周五上课前', '下周这门课前']

/**
 * 一次解析的「上下文指纹」：短语 + 参考时间 + 课程 + 当前 DDL 值。
 * 任何一项变化都代表旧建议已经过期。
 */
export function timeAssistantContext({ text, referenceAt, courseId, deadline } = {}) {
  const course = courseId === null || courseId === undefined || courseId === '' ? 'none' : String(courseId)
  return [String(text ?? '').trim(), String(referenceAt ?? ''), course, String(deadline ?? '')].join('\u0000')
}

/**
 * 解析请求闸门：`begin` 记下这次请求的上下文与序号，响应回来时用 `isCurrent` 判断是否还能采用。
 * `invalidate` 用于「依赖被改动 / 组件卸载」时立刻作废所有在途请求。
 */
export function createResolutionGate() {
  let seq = 0
  let activeContext = null
  return {
    begin(context) {
      seq += 1
      activeContext = context
      return seq
    },
    isCurrent(token, context) {
      return token === seq && context === activeContext
    },
    invalidate() {
      seq += 1
      activeContext = null
    },
    snapshot() {
      return { token: seq, context: activeContext }
    },
  }
}

/** 建议是否可以「采用」：开关未禁用、有结果、且上下文还没过期。 */
export function canAdoptSuggestion({ disabled = false, hasResult = false, current = false } = {}) {
  return Boolean(hasResult) && !disabled && Boolean(current)
}

/**
 * 折叠面板开合时，是否必须作废在途请求与已展示建议。
 * **关闭一律作废**：否则关闭期间回来的响应会在重新展开后显示成"当前建议"。
 */
export function panelToggleInvalidates(isOpen) {
  return isOpen !== true
}

/** 后端四态 → 界面文案。 */
export function resolveStatusLabel(status) {
  return (
    {
      RESOLVED: '已解析出候选时间',
      NEEDS_INFO: '还需要补充信息',
      UNSUPPORTED: '这种说法暂不支持',
      NO_COURSE_MATCH: '课表里没有匹配的课',
    }[status] || '解析结果'
  )
}
