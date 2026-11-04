<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import {
  buildRecurrencePreview,
  decodeRecurrenceStore,
  emptyRecurrenceStore,
  encodeRecurrenceStore,
  RECURRENCE_CADENCE_LABELS,
  RECURRENCE_LIMITS,
  ruleInputFromTemplate,
  taskDraftForOccurrence,
  weekdaysLabel,
} from '@domain/recurrence'
import { decodeTemplateStore } from '@domain/taskTemplate'
import { shanghaiToday } from '@domain/datetime'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import LoadingState from '@/components/LoadingState.vue'
import { courseApi, settingsApi, taskApi } from '@/api'
import { useSetting } from '@/composables/useSetting'
import { loadAllTasks } from '@/domain/adapters'
import { SETTING_KEYS } from '@/domain/settingKeys'
import { draftToTaskRequest, PRIORITY_OPTIONS, SHARED_TASK_TYPES } from '@/domain/taskTypes'
import { shiftDateKey } from '@/utils/dateKeys'

const setting = useSetting(SETTING_KEYS.TASK_RECURRENCE, {
  decode: (raw) => {
    const result = decodeRecurrenceStore(raw)
    if (!result.ok) throw new Error(result.reason || '重复规则无法读取。')
    return result.store
  },
  encode: encodeRecurrenceStore,
})

const courses = ref([])
const templates = ref([])
const taskIds = ref(new Set())
const loadError = ref('')
const store = computed(() => setting.data.value ?? emptyRecurrenceStore())

const WEEKDAYS = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 7, label: '日' },
]

function blankInput() {
  const today = shanghaiToday(new Date())
  return {
    name: '',
    templateId: null,
    title: '',
    description: '',
    type: 'HOMEWORK',
    priority: 3,
    estimatedMinutes: '',
    submitRequirement: '',
    submitMethod: '',
    courseId: null,
    cadence: 'WEEKLY',
    weekdays: [1],
    startDate: today,
    endDate: shiftDateKey(today, 27),
    time: '23:59',
  }
}

const editor = reactive({ open: false, ruleId: null, ruleRevision: 0, input: blankInput(), templatePick: '' })
const preview = ref(null)
const previewError = ref('')
const resultMessage = ref('')
const creating = ref(false)

function context() {
  const rule = editor.ruleId === null ? null : store.value.rules.find((r) => r.id === editor.ruleId)
  return {
    courseIds: new Set(courses.value.map((c) => c.id)),
    templates: new Map(templates.value.map((t) => [t.id, { updatedAt: t.updatedAt, revision: t.revision }])),
    ledger: store.value.ledger,
    existingTaskIds: taskIds.value,
    ruleId: editor.ruleId,
    ruleRevision: rule?.revision ?? 0,
    nextRuleId: store.value.nextRuleId,
  }
}

function openEditor(rule = null) {
  preview.value = null
  previewError.value = ''
  resultMessage.value = ''
  const input = rule
    ? {
        ...blankInput(),
        ...rule,
        description: rule.description ?? '',
        estimatedMinutes: rule.estimatedMinutes === null ? '' : String(rule.estimatedMinutes),
        submitRequirement: rule.submitRequirement ?? '',
        submitMethod: rule.submitMethod ?? '',
        time: rule.time ?? '',
        weekdays: [...rule.weekdays],
      }
    : blankInput()
  Object.assign(editor, { open: true, ruleId: rule?.id ?? null, ruleRevision: rule?.revision ?? 0, input, templatePick: '' })
}

function applyTemplatePick() {
  const template = templates.value.find((t) => t.id === Number(editor.templatePick))
  if (!template) return
  editor.input = { ...ruleInputFromTemplate(editor.input, template).input, weekdays: [...editor.input.weekdays] }
  if (!editor.input.name) editor.input.name = template.name
}

function toggleWeekday(value) {
  const set = new Set(editor.input.weekdays)
  if (set.has(value)) set.delete(value)
  else set.add(value)
  editor.input.weekdays = [...set].sort((a, b) => a - b)
}

function generatePreview() {
  previewError.value = ''
  resultMessage.value = ''
  const result = buildRecurrencePreview({ ...editor.input, courseId: editor.input.courseId || null }, context())
  if (!result.ok) {
    preview.value = null
    previewError.value = [result.reason, ...Object.values(result.fields || {})].join(' ')
    return
  }
  preview.value = result
}

/**
 * 创建：
 * 1) 先把规则写进规则库（带 revision，别处同时改过会 409），占住规则 id；
 * 2) 逐条通过任务接口创建；
 * 3) 把成功创建的日期记入账本，之后同一天不会再重复生成，删掉的也不会被补回来。
 */
async function createTasks() {
  if (!preview.value) return
  creating.value = true
  previewError.value = ''
  try {
    await refreshContext()
    const fresh = buildRecurrencePreview({ ...editor.input, courseId: editor.input.courseId || null }, context())
    if (!fresh.ok || fresh.fingerprint !== preview.value.fingerprint) {
      previewError.value = '预览之后规则、模板或课程有变化，请重新预览后再创建。'
      return
    }
    if (fresh.blockedReason) {
      previewError.value = fresh.blockedReason
      return
    }
    const current = store.value
    if (editor.ruleId === null && current.rules.length >= RECURRENCE_LIMITS.maxRules) {
      previewError.value = `重复规则最多 ${RECURRENCE_LIMITS.maxRules} 条。`
      return
    }
    if (current.ledger.length + fresh.availableCount > RECURRENCE_LIMITS.maxLedgerEntries) {
      previewError.value = '生成账本已满，请先删除不用的规则。'
      return
    }
    const nowIso = new Date().toISOString()
    const existing = current.rules.find((r) => r.id === editor.ruleId)
    const ruleId = existing ? existing.id : current.nextRuleId
    const rule = {
      ...fresh.rule,
      id: ruleId,
      revision: existing ? existing.revision + 1 : 1,
      createdAt: existing ? existing.createdAt : nowIso,
      updatedAt: nowIso,
    }
    const withRule = {
      ...current,
      nextRuleId: existing ? current.nextRuleId : ruleId + 1,
      rules: existing ? current.rules.map((r) => (r.id === ruleId ? rule : r)) : [...current.rules, rule],
    }
    if (!(await setting.save(withRule))) {
      previewError.value = setting.error.value
      return
    }
    editor.ruleId = ruleId

    const entries = []
    let failure = ''
    for (const occurrence of fresh.occurrences) {
      if (occurrence.status !== 'AVAILABLE') continue
      try {
        const created = await taskApi.create(draftToTaskRequest(taskDraftForOccurrence(fresh.rule, occurrence)))
        entries.push({ ruleId, date: occurrence.date, taskId: created.id, status: 'CREATED', createdAt: nowIso })
      } catch (err) {
        failure = `${occurrence.date} 创建失败：${err.message}`
        break
      }
    }
    if (entries.length) {
      const latest = setting.data.value
      const ok = await setting.save({ ...latest, ledger: [...latest.ledger, ...entries] })
      if (!ok) failure = `任务已创建，但账本没能保存（${setting.error.value}），请不要重复生成同一时段。`
    }
    resultMessage.value = `已创建 ${entries.length} 个任务${fresh.createdCount ? `，跳过已生成 ${fresh.createdCount} 个` : ''}${
      fresh.deletedCount ? `，跳过已删除 ${fresh.deletedCount} 个` : ''
    }。`
    previewError.value = failure
    preview.value = null
    await refreshContext()
  } finally {
    creating.value = false
  }
}

async function removeRule(rule) {
  if (!window.confirm(`删除规则「${rule.name}」？已经创建的任务会保留。`)) return
  const current = store.value
  await setting.save({
    ...current,
    rules: current.rules.filter((r) => r.id !== rule.id),
    ledger: current.ledger.filter((entry) => entry.ruleId !== rule.id),
  })
}

const createdCount = (rule) => store.value.ledger.filter((e) => e.ruleId === rule.id && e.status === 'CREATED').length
const courseName = (id) => courses.value.find((c) => c.id === id)?.name

async function refreshContext() {
  const [tasks, courseList, templateSetting] = await Promise.all([
    loadAllTasks(),
    courseApi.list(),
    settingsApi.get(SETTING_KEYS.TASK_TEMPLATES),
    setting.load(),
  ])
  taskIds.value = new Set(tasks.map((t) => t.id))
  courses.value = courseList
  const decoded = decodeTemplateStore(templateSetting.value ?? null)
  templates.value = decoded.ok ? decoded.store.templates : []
}

onMounted(() => refreshContext().catch((err) => (loadError.value = err.message)))
</script>

<template>
  <div>
    <header class="page-head">
      <div>
        <span class="page-head__eyebrow"><AppIcon name="repeat" :size="15" />工具</span>
        <h1>重复任务</h1>
        <p class="page-head__sub">
          每周作业、每日打卡这类任务：设定规则 → 预览实际日期 → 确认后一次创建。同一天不会重复生成，删掉的也不会被补回。
        </p>
      </div>
      <button type="button" class="btn btn--primary" :disabled="!setting.data.value" @click="openEditor()">
        <AppIcon name="plus" :size="16" />新建规则
      </button>
    </header>

    <ErrorState v-if="loadError" :message="loadError" @retry="$router.go(0)" />
    <LoadingState v-else-if="!setting.data.value" title="正在读取规则…" />

    <template v-else>
      <div v-if="resultMessage && !editor.open" class="alert alert--success" style="margin-bottom: 16px">{{ resultMessage }}</div>
      <section v-if="store.rules.length === 0" class="card card--soft">
        <p class="muted" style="margin: 0">还没有规则。</p>
      </section>
      <div v-else class="list-rows">
        <div v-for="rule in store.rules" :key="rule.id" class="list-row">
          <div class="list-row__main">
            <div class="list-row__title">{{ rule.name }}</div>
            <div class="list-row__meta">
              {{ RECURRENCE_CADENCE_LABELS[rule.cadence] }}
              <template v-if="rule.cadence === 'WEEKLY'">（{{ weekdaysLabel(rule.weekdays) }}）</template>
              · {{ rule.startDate }} 至 {{ rule.endDate }} {{ rule.time || '当天' }}
              <template v-if="rule.courseId"> · {{ courseName(rule.courseId) || '课程已删除' }}</template>
              · 已生成 {{ createdCount(rule) }} 个
            </div>
          </div>
          <button type="button" class="btn btn--sm" @click="openEditor(rule)">编辑 / 继续生成</button>
          <button type="button" class="btn btn--sm btn--ghost" @click="removeRule(rule)">删除</button>
        </div>
      </div>
    </template>

    <div v-if="editor.open" class="modal-backdrop" @click.self="editor.open = false">
      <div class="modal modal--wide" role="dialog" aria-modal="true" aria-label="重复规则">
        <h2 class="card__title" style="margin-bottom: 14px">{{ editor.ruleId === null ? '新建重复规则' : '编辑重复规则' }}</h2>
        <div class="stack">
          <div v-if="templates.length" class="row">
            <select v-model="editor.templatePick" aria-label="从模板带入" style="max-width: 260px">
              <option value="">从模板带入内容…</option>
              <option v-for="t in templates" :key="t.id" :value="String(t.id)">{{ t.name }}</option>
            </select>
            <button type="button" class="btn btn--sm" :disabled="!editor.templatePick" @click="applyTemplatePick">带入</button>
            <RouterLink class="small" to="/tools/templates">管理模板</RouterLink>
          </div>
          <div class="form-grid">
            <label class="field">
              <span class="field__label">规则名称</span>
              <input v-model="editor.input.name" type="text" :maxlength="RECURRENCE_LIMITS.maxNameLength" placeholder="例如：数据结构周作业" />
            </label>
            <label class="field">
              <span class="field__label">任务标题</span>
              <input v-model="editor.input.title" type="text" maxlength="200" />
            </label>
            <label class="field">
              <span class="field__label">所属课程</span>
              <select v-model="editor.input.courseId">
                <option :value="null">不关联课程</option>
                <option v-for="course in courses" :key="course.id" :value="course.id">{{ course.name }}</option>
              </select>
            </label>
            <label class="field">
              <span class="field__label">类型 / 优先级</span>
              <span class="row">
                <select v-model="editor.input.type" style="flex: 1">
                  <option v-for="t in SHARED_TASK_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
                </select>
                <select v-model.number="editor.input.priority" style="flex: 1">
                  <option v-for="p in PRIORITY_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
                </select>
              </span>
            </label>
            <label class="field">
              <span class="field__label">预计用时（分钟，可空）</span>
              <input v-model="editor.input.estimatedMinutes" type="text" inputmode="numeric" />
            </label>
            <label class="field">
              <span class="field__label">截止时刻（留空 = 当天结束前）</span>
              <input v-model="editor.input.time" type="time" />
            </label>
            <label class="field">
              <span class="field__label">开始日期</span>
              <input v-model="editor.input.startDate" type="date" />
            </label>
            <label class="field">
              <span class="field__label">结束日期（最长 {{ RECURRENCE_LIMITS.maxRangeDays }} 天）</span>
              <input v-model="editor.input.endDate" type="date" />
            </label>
          </div>
          <div class="row">
            <div class="seg">
              <button
                v-for="(label, value) in RECURRENCE_CADENCE_LABELS"
                :key="value"
                type="button"
                class="seg__item"
                :class="{ 'seg__item--active': editor.input.cadence === value }"
                @click="editor.input.cadence = value"
              >
                {{ label }}
              </button>
            </div>
            <template v-if="editor.input.cadence === 'WEEKLY'">
              <button
                v-for="day in WEEKDAYS"
                :key="day.value"
                type="button"
                class="chip"
                :class="{ 'chip--active': editor.input.weekdays.includes(day.value) }"
                @click="toggleWeekday(day.value)"
              >
                周{{ day.label }}
              </button>
            </template>
          </div>

          <button type="button" class="btn" style="align-self: flex-start" @click="generatePreview">预览实际日期</button>
          <p v-if="previewError" class="field__error">{{ previewError }}</p>
          <p v-if="resultMessage" class="alert alert--success" style="margin: 0">{{ resultMessage }}</p>

          <div v-if="preview" class="card card--soft" style="margin: 0">
            <p class="small" style="margin: 0 0 10px">
              共 {{ preview.occurrences.length }} 天：可创建 <strong>{{ preview.availableCount }}</strong>
              <template v-if="preview.createdCount"> · 已生成 {{ preview.createdCount }}</template>
              <template v-if="preview.deletedCount"> · 已删除不补 {{ preview.deletedCount }}</template>
            </p>
            <div class="row recur-dates">
              <span
                v-for="o in preview.occurrences"
                :key="o.date"
                class="chip"
                :class="{ 'chip--active': o.status === 'AVAILABLE' }"
                :title="o.status"
              >
                {{ o.date.slice(5) }}{{ o.status === 'CREATED' ? ' ✓' : o.status === 'DELETED' ? ' ✕' : '' }}
              </span>
            </div>
            <p v-for="w in preview.warnings" :key="w" class="small muted">{{ w }}</p>
            <p v-if="preview.blockedReason" class="field__error">{{ preview.blockedReason }}</p>
          </div>

          <div class="row" style="justify-content: flex-end">
            <button type="button" class="btn btn--ghost" @click="editor.open = false">关闭</button>
            <button
              type="button"
              class="btn btn--primary"
              :disabled="!preview || !preview.availableCount || !!preview.blockedReason || creating"
              @click="createTasks"
            >
              {{ creating ? '正在创建…' : `确认创建 ${preview?.availableCount ?? 0} 个任务` }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal--wide {
  width: min(760px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  overflow-y: auto;
}

.recur-dates .chip {
  cursor: default;
  font-variant-numeric: tabular-nums;
}
</style>
