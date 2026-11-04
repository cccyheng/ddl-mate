<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { courseApi } from '@/api'
import TimeAssistant from '@/components/TimeAssistant.vue'
import { isoToShanghaiWallClock } from '@/utils/datetime'

const props = defineProps({
  initial: { type: Object, default: null },
  submitLabel: { type: String, default: '保存任务' },
  busy: { type: Boolean, default: false },
  fieldErrors: { type: Object, default: () => ({}) },
})

const emit = defineEmits(['submit', 'cancel'])

const courses = ref([])
const coursesError = ref('')

const typeOptions = [
  { value: 'HOMEWORK', label: '作业' },
  { value: 'LAB', label: '实验' },
  { value: 'REPORT', label: '报告' },
  { value: 'PROJECT', label: '课程设计' },
  { value: 'EXAM', label: '考试' },
  { value: 'PRESENTATION', label: '展示/答辩' },
  { value: 'READING', label: '阅读' },
  { value: 'OTHER', label: '其他' },
]

const statusOptions = [
  { value: 'TODO', label: '未开始' },
  { value: 'DOING', label: '进行中' },
  { value: 'DONE', label: '已完成' },
  { value: 'ARCHIVED', label: '已归档' },
]

const priorityOptions = [
  { value: 1, label: '1 · 最低' },
  { value: 2, label: '2 · 较低' },
  { value: 3, label: '3 · 普通' },
  { value: 4, label: '4 · 较高' },
  { value: 5, label: '5 · 紧急' },
]

const isEdit = computed(() => Boolean(props.initial?.id))

const form = reactive({
  title: props.initial?.title || '',
  courseId: props.initial?.course?.id || '',
  type: props.initial?.type || 'HOMEWORK',
  status: props.initial?.status || 'TODO',
  priority: props.initial?.priority || 3,
  // DDL 统一按**北京时间墙上时间**填写与提交（后端也按 +08:00 解释），
  // 这样在 UTC 浏览器里打开编辑页不会少 8 小时。
  deadline: isoToShanghaiWallClock(props.initial?.deadline),
  estimatedMinutes: props.initial?.estimatedMinutes || '',
  submitRequirement: props.initial?.submitRequirement || '',
  submitMethod: props.initial?.submitMethod || '',
  description: props.initial?.description || '',
})

function localError(field) {
  return props.fieldErrors[field] || ''
}

/** 时间助手显式「采用」后才更新表单里的 DDL；采用之后仍然可以手工改。 */
function applyAssistantTime(payload) {
  if (!payload?.deadline) return
  form.deadline = payload.deadline
}

function submit() {
  emit('submit', {
    title: form.title.trim(),
    courseId: form.courseId ? Number(form.courseId) : null,
    type: form.type,
    status: form.status,
    priority: Number(form.priority),
    deadline: form.deadline ? form.deadline : null,
    estimatedMinutes: form.estimatedMinutes === '' ? null : Number(form.estimatedMinutes),
    submitRequirement: form.submitRequirement.trim() || null,
    submitMethod: form.submitMethod.trim() || null,
    description: form.description.trim() || null,
  })
}

onMounted(async () => {
  try {
    courses.value = await courseApi.list()
  } catch (error) {
    coursesError.value = error.message
  }
})
</script>

<template>
  <form class="stack" @submit.prevent="submit">
    <div v-if="coursesError" class="alert alert--warn">课程列表加载失败：{{ coursesError }}</div>

    <div class="form-grid">
      <label class="field form-grid--full" :class="{ 'field--invalid': localError('title') }">
        <span class="field__label">任务标题<span class="field__required">*</span></span>
        <input v-model="form.title" type="text" maxlength="200" placeholder="例如：数据结构实验二" required />
        <span v-if="localError('title')" class="field__error">{{ localError('title') }}</span>
      </label>

      <label class="field" :class="{ 'field--invalid': localError('courseId') }">
        <span class="field__label">所属课程</span>
        <select v-model="form.courseId">
          <option value="">（不关联课程）</option>
          <option v-for="course in courses" :key="course.id" :value="course.id">
            {{ course.code }} {{ course.name }}
          </option>
        </select>
        <span class="field__hint">课程可以为空，例如选课、缴费这类任务</span>
      </label>

      <label class="field" :class="{ 'field--invalid': localError('type') }">
        <span class="field__label">任务类型</span>
        <select v-model="form.type">
          <option v-for="option in typeOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>

      <label class="field" :class="{ 'field--invalid': localError('deadline') }">
        <span class="field__label">截止时间（DDL）</span>
        <input v-model="form.deadline" type="datetime-local" />
        <span class="field__hint">按<strong>北京时间（+08:00）</strong>填写；留空表示暂不设置 DDL，也可以直接用下面的时间助手</span>
        <span v-if="localError('deadline')" class="field__error">{{ localError('deadline') }}</span>
      </label>

      <div class="form-grid--full">
        <TimeAssistant
          :courses="courses"
          :course-id="form.courseId"
          :deadline="form.deadline"
          :disabled="busy"
          summary="时间助手：用一句话填截止时间（可选）"
          @apply="applyAssistantTime"
        />
      </div>

      <label class="field" :class="{ 'field--invalid': localError('priority') }">
        <span class="field__label">优先级</span>
        <select v-model="form.priority">
          <option v-for="option in priorityOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>

      <label class="field" :class="{ 'field--invalid': localError('status') }">
        <span class="field__label">状态</span>
        <select v-model="form.status">
          <option v-for="option in statusOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>

      <label class="field" :class="{ 'field--invalid': localError('estimatedMinutes') }">
        <span class="field__label">预计耗时（分钟）</span>
        <input v-model="form.estimatedMinutes" type="number" min="1" max="10000" placeholder="例如：180" />
        <span v-if="localError('estimatedMinutes')" class="field__error">{{ localError('estimatedMinutes') }}</span>
      </label>

      <label class="field" :class="{ 'field--invalid': localError('submitMethod') }">
        <span class="field__label">提交方式</span>
        <input v-model="form.submitMethod" type="text" maxlength="128" placeholder="学习通 / 邮箱 / 课堂提交" />
      </label>

      <label class="field form-grid--full" :class="{ 'field--invalid': localError('submitRequirement') }">
        <span class="field__label">提交要求</span>
        <input
          v-model="form.submitRequirement"
          type="text"
          maxlength="500"
          placeholder="例如：源代码 + 实验报告，打包成 zip"
        />
      </label>

      <label class="field form-grid--full" :class="{ 'field--invalid': localError('description') }">
        <span class="field__label">说明</span>
        <textarea v-model="form.description" maxlength="1000" placeholder="补充细节、注意事项…" />
      </label>
    </div>

    <div class="row">
      <button class="btn btn--primary" type="submit" :disabled="busy">
        {{ busy ? '保存中…' : submitLabel }}
      </button>
      <button class="btn btn--ghost" type="button" :disabled="busy" @click="$emit('cancel')">取消</button>
      <span v-if="isEdit" class="small muted">修改会立即写入本地数据库</span>
    </div>
  </form>
</template>
