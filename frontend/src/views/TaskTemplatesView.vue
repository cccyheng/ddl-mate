<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  decodeTemplateStore,
  emptyTemplateInput,
  encodeTemplateStore,
  normalizeTemplateInput,
  TEMPLATE_FIELD_LABELS,
  TEMPLATE_FIELDS,
  TEMPLATE_LIMITS,
  templateFieldsOf,
  templateToInput,
} from '@domain/taskTemplate'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import LoadingState from '@/components/LoadingState.vue'
import { courseApi, taskApi } from '@/api'
import { useSetting } from '@/composables/useSetting'
import { SETTING_KEYS } from '@/domain/settingKeys'
import { PRIORITY_OPTIONS, SHARED_TASK_TYPES } from '@/domain/taskTypes'

const route = useRoute()
const router = useRouter()

const setting = useSetting(SETTING_KEYS.TASK_TEMPLATES, {
  decode: (raw) => {
    const result = decodeTemplateStore(raw)
    if (!result.ok) throw new Error(result.reason || '模板数据无法读取。')
    return result.store
  },
  encode: encodeTemplateStore,
})

const courses = ref([])
const loadError = ref('')
const templates = computed(() => setting.data.value?.templates ?? [])
const courseName = (id) => courses.value.find((c) => c.id === id)?.name

const editor = reactive({ open: false, id: null, input: emptyTemplateInput(), errors: {}, message: '' })
const sharedTypeValues = new Set(SHARED_TASK_TYPES.map((t) => t.value))

function openEditor(template = null, seed = null) {
  const input = template ? templateToInput(template) : { ...emptyTemplateInput(), ...seed }
  Object.assign(editor, { open: true, id: template?.id ?? null, input: { ...input, fields: [...input.fields] }, errors: {}, message: '' })
}

function toggleField(field) {
  const set = new Set(editor.input.fields)
  if (set.has(field)) set.delete(field)
  else set.add(field)
  editor.input.fields = TEMPLATE_FIELDS.filter((f) => set.has(f))
}

async function saveEditor() {
  editor.errors = {}
  editor.message = ''
  let content
  try {
    content = normalizeTemplateInput({ ...editor.input, courseId: editor.input.courseId || null })
  } catch (err) {
    editor.errors = err.fields || {}
    editor.message = err.message
    return
  }
  const store = setting.data.value
  const nowIso = new Date().toISOString()
  let next
  if (editor.id === null) {
    if (store.templates.length >= TEMPLATE_LIMITS.maxTemplates) {
      editor.message = `模板最多 ${TEMPLATE_LIMITS.maxTemplates} 个。`
      return
    }
    const template = { ...content, id: store.nextId, revision: 1, createdAt: nowIso, updatedAt: nowIso }
    next = { ...store, nextId: store.nextId + 1, templates: [...store.templates, template] }
  } else {
    next = {
      ...store,
      templates: store.templates.map((t) =>
        t.id === editor.id ? { ...t, ...content, revision: t.revision + 1, updatedAt: nowIso } : t,
      ),
    }
  }
  if (await setting.save(next)) editor.open = false
  else editor.message = setting.error.value
}

async function removeTemplate(template) {
  if (!window.confirm(`删除模板「${template.name}」？已用它创建的任务不受影响。`)) return
  const store = setting.data.value
  await setting.save({ ...store, templates: store.templates.filter((t) => t.id !== template.id) })
}

function useTemplate(template) {
  router.push({ name: 'task-new', query: { template: String(template.id) } })
}

onMounted(async () => {
  try {
    const [, list] = await Promise.all([setting.load(), courseApi.list()])
    courses.value = list
    // 从任务详情「存为模板」进入：用那条任务预填
    if (route.query.fromTask) {
      const task = await taskApi.get(Number(route.query.fromTask))
      openEditor(null, {
        name: task.title.slice(0, TEMPLATE_LIMITS.maxNameLength),
        fields: ['title', 'type', 'priority', 'estimatedMinutes', 'submitRequirement', 'submitMethod', 'courseId'],
        title: task.title,
        description: task.description ?? '',
        type: sharedTypeValues.has(task.type) ? task.type : 'OTHER',
        priority: task.priority,
        estimatedMinutes: task.estimatedMinutes ? String(task.estimatedMinutes) : '',
        submitRequirement: task.submitRequirement ?? '',
        submitMethod: task.submitMethod ?? '',
        courseId: task.course?.id ?? null,
      })
    }
  } catch (err) {
    loadError.value = err.message
  }
})
</script>

<template>
  <div>
    <header class="page-head">
      <div>
        <span class="page-head__eyebrow"><AppIcon name="layers" :size="15" />工具</span>
        <h1>任务模板</h1>
        <p class="page-head__sub">把常见任务（每周作业、实验报告……）存成模板，新建时一键带出；不保存截止时间与状态。</p>
      </div>
      <button type="button" class="btn btn--primary" :disabled="!setting.data.value" @click="openEditor()">
        <AppIcon name="plus" :size="16" />新建模板
      </button>
    </header>

    <ErrorState v-if="loadError" :message="loadError" @retry="$router.go(0)" />
    <LoadingState v-else-if="!setting.data.value" title="正在读取模板…" />
    <section v-else-if="templates.length === 0" class="card card--soft">
      <p class="muted" style="margin: 0">还没有模板。也可以在任务详情里点「存为模板」。</p>
    </section>
    <div v-else class="grid grid--3">
      <article v-for="template in templates" :key="template.id" class="card card--interactive template-card">
        <h2 class="card__title">{{ template.name }}</h2>
        <p class="muted small" style="margin: 4px 0 10px">
          {{ templateFieldsOf(template).map((f) => TEMPLATE_FIELD_LABELS[f]).join('、') }}
        </p>
        <ul class="template-card__facts small">
          <li v-if="template.title">标题：{{ template.title }}</li>
          <li v-if="template.courseId">课程：{{ courseName(template.courseId) || '（课程已删除）' }}</li>
          <li v-if="template.estimatedMinutes !== null">预计：{{ template.estimatedMinutes }} 分钟</li>
          <li v-if="template.submitMethod">提交：{{ template.submitMethod }}</li>
        </ul>
        <div class="row" style="margin-top: auto">
          <button type="button" class="btn btn--sm btn--primary" @click="useTemplate(template)">用它新建任务</button>
          <button type="button" class="btn btn--sm btn--ghost" @click="openEditor(template)">编辑</button>
          <button type="button" class="btn btn--sm btn--ghost" @click="removeTemplate(template)">删除</button>
        </div>
      </article>
    </div>

    <p class="muted small" style="margin-top: 16px">
      想按日期批量生成？去 <RouterLink to="/tools/recurrence">重复任务</RouterLink>。
    </p>

    <div v-if="editor.open" class="modal-backdrop" @click.self="editor.open = false">
      <div class="modal modal--wide" role="dialog" aria-modal="true" aria-label="编辑模板">
        <h2 class="card__title" style="margin-bottom: 14px">{{ editor.id === null ? '新建模板' : '编辑模板' }}</h2>
        <div class="stack">
          <label class="field" :class="{ 'field--invalid': editor.errors.name }">
            <span class="field__label">模板名称</span>
            <input v-model="editor.input.name" type="text" :maxlength="TEMPLATE_LIMITS.maxNameLength" />
            <span v-if="editor.errors.name" class="field__error">{{ editor.errors.name }}</span>
          </label>
          <div>
            <span class="field__label">保存哪些内容</span>
            <div class="row" style="margin-top: 6px">
              <button
                v-for="field in TEMPLATE_FIELDS"
                :key="field"
                type="button"
                class="chip"
                :class="{ 'chip--active': editor.input.fields.includes(field) }"
                @click="toggleField(field)"
              >
                {{ TEMPLATE_FIELD_LABELS[field] }}
              </button>
            </div>
            <span v-if="editor.errors.fields" class="field__error">{{ editor.errors.fields }}</span>
          </div>
          <div class="form-grid">
            <label v-if="editor.input.fields.includes('title')" class="field">
              <span class="field__label">标题</span>
              <input v-model="editor.input.title" type="text" maxlength="200" />
            </label>
            <label v-if="editor.input.fields.includes('courseId')" class="field">
              <span class="field__label">所属课程</span>
              <select v-model="editor.input.courseId">
                <option :value="null">不关联课程</option>
                <option v-for="course in courses" :key="course.id" :value="course.id">{{ course.name }}</option>
              </select>
            </label>
            <label v-if="editor.input.fields.includes('type')" class="field">
              <span class="field__label">任务类型</span>
              <select v-model="editor.input.type">
                <option v-for="t in SHARED_TASK_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
              </select>
            </label>
            <label v-if="editor.input.fields.includes('priority')" class="field">
              <span class="field__label">优先级</span>
              <select v-model.number="editor.input.priority">
                <option v-for="p in PRIORITY_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
              </select>
            </label>
            <label v-if="editor.input.fields.includes('estimatedMinutes')" class="field" :class="{ 'field--invalid': editor.errors.estimatedMinutes }">
              <span class="field__label">预计用时（分钟）</span>
              <input v-model="editor.input.estimatedMinutes" type="text" inputmode="numeric" />
              <span v-if="editor.errors.estimatedMinutes" class="field__error">{{ editor.errors.estimatedMinutes }}</span>
            </label>
            <label v-if="editor.input.fields.includes('submitMethod')" class="field">
              <span class="field__label">提交方式</span>
              <input v-model="editor.input.submitMethod" type="text" maxlength="128" />
            </label>
            <label v-if="editor.input.fields.includes('submitRequirement')" class="field form-grid--full">
              <span class="field__label">提交要求</span>
              <input v-model="editor.input.submitRequirement" type="text" maxlength="500" />
            </label>
            <label v-if="editor.input.fields.includes('description')" class="field form-grid--full">
              <span class="field__label">说明</span>
              <textarea v-model="editor.input.description" rows="3" maxlength="1000" />
            </label>
          </div>
          <p v-if="editor.message" class="field__error">{{ editor.message }}</p>
          <div class="row" style="justify-content: flex-end">
            <button type="button" class="btn btn--ghost" @click="editor.open = false">取消</button>
            <button type="button" class="btn btn--primary" :disabled="setting.saving.value" @click="saveEditor">保存模板</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.template-card {
  display: flex;
  flex-direction: column;
  margin-top: 0;
}

.template-card + .template-card {
  margin-top: 0;
}

.template-card__facts {
  margin: 0 0 14px;
  padding-left: 16px;
  color: var(--text-soft);
}

.modal--wide {
  width: min(720px, calc(100vw - 32px));
}
</style>
