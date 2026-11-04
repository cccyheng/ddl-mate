<script setup>
/**
 * 可复用的「时间助手」：把**简短时间短语**解析成明确的北京时间，用户显式「采用」后才写入表单 / 候选。
 *
 * 诚实边界（与 docs/v1.2-time-assistant.md 一致）：
 *   - 只解析短句（今天 / 明天 / 后天 / 本周X / 下周X + 明确时刻、精确日期、下节课前这类课程说法），
 *     不解析整段通知；信息不足时只提示补全，绝不替用户补 23:59；
 *   - 固定按北京时间（+08:00）计算与展示，不看运行电脑的时区；
 *   - 解析接口是**只读**的，不会写库；只有点「采用此时间」才更新表单 / 候选；
 *   - 依赖（短语 / 参考时间 / 课程 / 当前 DDL）任一变化都会让在途结果作废，迟到的响应不能覆盖；
 *     保存期间（disabled）按钮全部禁用。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { taskApi } from '@/api'
import {
  isoToShanghaiWallClock,
  shanghaiDeadlineLabel,
  shanghaiNowWallClock,
  shanghaiWallClockToOffset,
} from '@/utils/datetime'
import {
  TIME_ASSISTANT_EXAMPLES,
  canAdoptSuggestion,
  createResolutionGate,
  panelToggleInvalidates,
  resolveStatusLabel,
  timeAssistantContext,
} from '@/utils/timeAssistantGuards'

const props = defineProps({
  /** 课程列表（用于显示当前选择的课程名，不会替用户选课）。 */
  courses: { type: Array, default: () => [] },
  /** 当前选择的课程 id（字符串 / 数字 / null）。课前说法必须由用户明确选择课程。 */
  courseId: { type: [String, Number], default: null },
  /** 当前表单 / 候选里的 DDL（上海墙上时间 `YYYY-MM-DDTHH:mm`），用于检测手工改动。 */
  deadline: { type: String, default: '' },
  /** 参考时间（带偏移量 ISO）。留空则默认「现在的北京时间」。 */
  referenceAt: { type: String, default: '' },
  /** 保存中 / 冻结时禁用助手。 */
  disabled: { type: Boolean, default: false },
  /** 紧凑模式（候选卡片里用）。 */
  compact: { type: Boolean, default: false },
  /** 折叠标题。 */
  summary: { type: String, default: '时间助手（可选）' },
})

const emit = defineEmits(['apply'])

const examples = TIME_ASSISTANT_EXAMPLES
const open = ref(false)
const phrase = ref('')
const referenceInput = ref(
  props.referenceAt ? isoToShanghaiWallClock(props.referenceAt) : shanghaiNowWallClock(),
)
const loading = ref(false)
const error = ref('')
const result = ref(null)
const resolvedKey = ref('')
const appliedNote = ref('')

const gate = createResolutionGate()
let requestSeq = 0
let unmounted = false

const selectedCourse = computed(
  () => props.courses.find((course) => String(course.id) === String(props.courseId)) ?? null,
)
const normalizedCourseId = computed(() => {
  if (props.courseId === null || props.courseId === undefined || props.courseId === '') return null
  const value = Number(props.courseId)
  return Number.isFinite(value) ? value : null
})
const contextKey = computed(() =>
  timeAssistantContext({
    text: phrase.value,
    referenceAt: referenceInput.value,
    courseId: props.courseId,
    deadline: props.deadline,
  }),
)
const busy = computed(() => loading.value || props.disabled)
const adoptable = computed(() =>
  canAdoptSuggestion({
    disabled: props.disabled,
    hasResult: Boolean(result.value),
    current: resolvedKey.value !== '' && resolvedKey.value === contextKey.value,
  }),
)

/** 短语 / 参考时间 / 课程变了：立刻作废旧建议并清掉上一次的提示。 */
watch(
  () => [phrase.value, referenceInput.value, props.courseId].join('\u0001'),
  () => invalidate({ clearApplied: true }),
)
/** 表单 / 候选里的 DDL 被手工改动：只作废建议，不抹掉「已采用」提示。 */
watch(
  () => props.deadline,
  () => invalidate({ clearApplied: false }),
)
/** 进入保存冻结：作废建议，禁止再采用。 */
watch(
  () => props.disabled,
  (value) => {
    if (value) invalidate({ clearApplied: false })
  },
)

onBeforeUnmount(() => {
  unmounted = true
  invalidate({ clearApplied: false })
})

function invalidate({ clearApplied = false } = {}) {
  gate.invalidate()
  requestSeq += 1
  loading.value = false
  result.value = null
  resolvedKey.value = ''
  error.value = ''
  if (clearApplied) appliedNote.value = ''
}

function setNow() {
  referenceInput.value = shanghaiNowWallClock()
}

function clearResult() {
  invalidate({ clearApplied: true })
}

/**
 * 折叠面板开合。**关闭时必须在途请求与已展示建议立刻失效**：
 * 否则关闭期间回来的响应会在重新展开后显示成"当前建议"，违反「关闭后异步响应不污染」。
 */
function onToggle(event) {
  const isOpen = event.target.open === true
  open.value = isOpen
  if (panelToggleInvalidates(isOpen)) invalidate({ clearApplied: false })
}

async function resolve() {
  if (props.disabled) return
  const text = phrase.value.trim()
  if (!text) {
    error.value = '请先写一个时间短语，例如「明天 18:00」。'
    return
  }
  const referenceAt = shanghaiWallClockToOffset(referenceInput.value)
  if (!referenceAt) {
    error.value = '参考时间需要完整的「日期 + 时刻」，助手固定按北京时间（+08:00）计算。'
    return
  }
  const context = contextKey.value
  const token = gate.begin(context)
  const mySeq = ++requestSeq
  loading.value = true
  error.value = ''
  result.value = null
  resolvedKey.value = ''
  appliedNote.value = ''
  try {
    const response = await taskApi.resolveTime({ text, referenceAt, courseId: normalizedCourseId.value })
    if (!isStillCurrent(mySeq, token, context)) return
    result.value = response
    resolvedKey.value = context
  } catch (err) {
    if (!isStillCurrent(mySeq, token, context)) return
    error.value = err.message
  } finally {
    if (mySeq === requestSeq) loading.value = false
  }
}

/** 迟到的响应只要「序号被换掉 / 上下文变了 / 组件卸载」就不写回任何状态。 */
function isStillCurrent(mySeq, token, context) {
  return !unmounted && mySeq === requestSeq && gate.isCurrent(token, context) && context === contextKey.value
}

function adopt(candidate) {
  if (!candidate || props.disabled) return
  if (!adoptable.value) {
    error.value = '这条建议已经过期（短语 / 参考时间 / 课程 / 表单 DDL 改过了）：请重新点「解析」。'
    return
  }
  const wallClock = isoToShanghaiWallClock(candidate.deadline)
  if (!wallClock) {
    error.value = '候选时间无法转换，请重新解析。'
    return
  }
  appliedNote.value = `已采用：${shanghaiDeadlineLabel(candidate.deadline)}（北京时间 +08:00）`
  result.value = null
  resolvedKey.value = ''
  emit('apply', { deadline: wallClock, reason: candidate.reason ?? '', candidate })
}

function candidateLabel(candidate) {
  return shanghaiDeadlineLabel(candidate.deadline)
}

const statusLabel = computed(() => (result.value ? resolveStatusLabel(result.value.status) : ''))
</script>

<template>
  <div class="time-assistant" :class="{ 'time-assistant--compact': compact }">
    <details class="filters-more" :open="open" @toggle="onToggle">
      <summary>{{ summary }}</summary>

      <div class="stack time-assistant__body">
        <p class="small muted" style="margin: 0">
          写一句时间短语 → 解析 → 点「采用此时间」才会填入。助手固定按<strong>北京时间</strong>算，信息不足时只提示补全。
        </p>

        <label class="field">
          <span class="field__label">时间短语</span>
          <input
            :value="phrase"
            type="text"
            maxlength="500"
            :disabled="disabled"
            placeholder="例如：明天 18:00 / 本周五 22:00 / 下周五上课前"
            @input="phrase = $event.target.value"
          />
        </label>

        <div class="row time-assistant__examples">
          <span class="small muted">快捷填词：</span>
          <button
            v-for="example in examples"
            :key="example.text"
            class="btn btn--sm btn--ghost"
            type="button"
            :disabled="disabled"
            @click="phrase = example.text"
          >
            {{ example.label }}
          </button>
        </div>

        <label class="field">
          <span class="field__label">参考时间（北京时间 +08:00）</span>
          <input
            :value="referenceInput"
            type="datetime-local"
            :disabled="disabled"
            @input="referenceInput = $event.target.value"
          />
          <span class="field__hint">默认是<strong>现在的北京时间</strong>；通知是几天前发的，就改成通知发布时间。</span>
        </label>

        <p class="small" style="margin: 0">
          当前课程：
          <strong v-if="selectedCourse">{{ selectedCourse.code }} {{ selectedCourse.name }}</strong>
          <template v-else>未选择（「下节课前」这类说法需要先选课程）</template>
        </p>

        <div class="row">
          <button class="btn btn--sm btn--primary" type="button" :disabled="busy || !phrase.trim()" @click="resolve">
            {{ loading ? '解析中…' : '解析' }}
          </button>
          <button class="btn btn--sm" type="button" :disabled="disabled" @click="setNow">设为现在</button>
          <button
            v-if="result || error || appliedNote"
            class="btn btn--sm btn--ghost"
            type="button"
            :disabled="disabled"
            @click="clearResult"
          >
            清空结果
          </button>
        </div>

        <details class="time-assistant__help">
          <summary class="small">支持哪些写法</summary>
          <ul class="candidate-hints">
            <li>今天 / 明天 / 后天 + 时刻：<span class="mono">明天 18:00</span>、<span class="mono">后天下午3点</span></li>
            <li>星期：<span class="mono">本周五 22:00</span>、<span class="mono">下周一 08:00</span>；不写「本周 / 下周」按本周算，已经过去不会自动跳周</li>
            <li>精确日期：<span class="mono">2026-10-20 23:00</span></li>
            <li>课前（需要先选课程）：<span class="mono">下节课前</span>、<span class="mono">下周五上课前</span>，且课表里有这门课</li>
            <li>只有日期 / 今晚 / 尽快 / 周末 / 多个时间：会提示补充，不会替你猜 23:59</li>
            <li>「取消 / 延期 / 改到 / 几天以前」和「下下周五」这类写法不支持</li>
          </ul>
        </details>

        <div v-if="loading" class="small muted">正在解析…</div>
        <div v-if="error" class="alert alert--danger small" role="alert">{{ error }}</div>
        <div v-if="appliedNote" class="alert alert--success small">{{ appliedNote }}</div>

        <div v-if="result" class="time-assistant__result">
          <div class="small"><strong>{{ statusLabel }}</strong>：{{ result.message }}</div>

          <ul v-if="result.candidates?.length" class="time-assistant__candidates">
            <li v-for="(candidate, index) in result.candidates" :key="`${candidate.deadline}-${index}`" class="time-assistant__candidate">
              <div class="time-assistant__deadline">
                {{ candidateLabel(candidate) }}
                <span class="badge badge--primary">北京时间 +08:00</span>
                <span v-if="candidate.past" class="badge badge--danger">已过去</span>
              </div>
              <div class="small muted">{{ candidate.reason }}</div>
              <div v-if="candidate.courseBoundary" class="small">
                课表匹配：{{ candidate.courseName }} · {{ candidate.scheduleDate }} {{ candidate.scheduleStartTime }}
                <span v-if="candidate.scheduleWeekday">（{{ candidate.scheduleWeekday }}）</span>
                <span v-if="candidate.scheduleLocation"> · {{ candidate.scheduleLocation }}</span>
              </div>
              <div v-if="candidate.note" class="small muted">{{ candidate.note }}</div>
              <button class="btn btn--sm btn--primary" type="button" :disabled="disabled || !adoptable" @click="adopt(candidate)">
                采用此时间
              </button>
            </li>
          </ul>

          <ul v-if="result.hints?.length" class="candidate-hints">
            <li v-for="(hint, index) in result.hints" :key="index">{{ hint }}</li>
          </ul>

          <p class="small muted" style="margin: 0">点「采用此时间」才会填入，之后仍可手工修改。</p>
        </div>
      </div>
    </details>
  </div>
</template>
