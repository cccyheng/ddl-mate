<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ApiError, sourceApi, taskApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import AttachmentGallery from '@/components/AttachmentGallery.vue'
import ErrorState from '@/components/ErrorState.vue'
import LoadingState from '@/components/LoadingState.vue'
import { formatDateTime, remainingLabel } from '@/utils/datetime'

const route = useRoute()
const router = useRouter()
const taskId = Number(route.params.id)

const loading = ref(true)
const error = ref('')
const task = ref(null)
const sources = ref([])
const busy = ref(false)

const sourceForm = reactive({ sourceName: '', rawText: '', sourceType: 'WECHAT_GROUP' })
const uploadFiles = ref([])

const statusOptions = [
  { value: 'TODO', label: '未开始' },
  { value: 'DOING', label: '进行中' },
  { value: 'DONE', label: '已完成' },
  { value: 'ARCHIVED', label: '已归档' },
]

const remaining = computed(() => remainingLabel(task.value?.deadline))

async function load() {
  loading.value = true
  error.value = ''
  try {
    task.value = await taskApi.get(taskId)
    sources.value = await sourceApi.listByTask(taskId)
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function changeStatus(status) {
  busy.value = true
  try {
    task.value = await taskApi.changeStatus(taskId, status)
  } catch (err) {
    error.value = err.message
  } finally {
    busy.value = false
  }
}

async function addSource() {
  if (!sourceForm.sourceName.trim()) {
    error.value = '请填写来源名称，例如「数据结构课程群」'
    return
  }
  busy.value = true
  error.value = ''
  try {
    const created = await sourceApi.create(taskId, {
      sourceName: sourceForm.sourceName.trim(),
      sourceType: sourceForm.sourceType,
      rawText: sourceForm.rawText.trim() || null,
      capturedAt: new Date().toISOString(),
    })
    if (uploadFiles.value.length) {
      await sourceApi.upload(created.id, uploadFiles.value)
      uploadFiles.value = []
    }
    sourceForm.sourceName = ''
    sourceForm.rawText = ''
    await load()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : err.message
  } finally {
    busy.value = false
  }
}

async function uploadToSource(source, event) {
  const files = Array.from(event.target.files || [])
  if (!files.length) return
  busy.value = true
  error.value = ''
  try {
    await sourceApi.upload(source.id, files)
    await load()
  } catch (err) {
    error.value = err.message
  } finally {
    busy.value = false
    event.target.value = ''
  }
}

async function removeAttachment(attachment) {
  if (!window.confirm(`确定删除附件「${attachment.originalName}」？`)) return
  try {
    await sourceApi.removeAttachment(attachment.id)
    await load()
  } catch (err) {
    error.value = err.message
  }
}

async function removeSource(source) {
  if (!window.confirm('确定删除这条原通知？附件也会一起删除。')) return
  try {
    await sourceApi.remove(source.id)
    await load()
  } catch (err) {
    error.value = err.message
  }
}

async function removeTask() {
  if (!window.confirm('确定删除这个任务？相关的原通知与附件会一起删除，且不可恢复。')) return
  try {
    await taskApi.remove(taskId)
    router.push('/tasks')
  } catch (err) {
    error.value = err.message
  }
}

function onFilesPicked(event) {
  uploadFiles.value = Array.from(event.target.files || [])
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>{{ task ? task.title : '任务详情' }}</h1>
        <p class="page-head__sub" v-if="task">
          {{ task.course ? task.course.code + ' ' + task.course.name : '未关联课程' }} · {{ task.typeLabel }}
        </p>
      </div>
      <div class="row">
        <button class="btn" type="button" @click="router.back()">返回</button>
        <RouterLink v-if="task" class="btn" :to="`/tasks/${taskId}/edit`">编辑</RouterLink>
        <button v-if="task" class="btn btn--danger" type="button" @click="removeTask">删除</button>
      </div>
    </div>

    <LoadingState v-if="loading" title="正在加载任务详情…" />
    <ErrorState v-else-if="!task" :message="error" @retry="load" />

    <template v-else>
      <div v-if="error" class="alert alert--danger" style="margin-bottom: 16px">{{ error }}</div>

      <section class="card">
        <div class="card__head">
          <div class="row">
            <span class="badge" :class="task.status === 'DONE' ? 'badge--success' : 'badge--primary'">
              {{ task.statusLabel }}
            </span>
            <span class="badge" :class="remaining.tone === 'danger' ? 'badge--danger' : 'badge--muted'">
              {{ remaining.text }}
            </span>
            <span class="badge badge--muted">{{ task.priorityLabel }}优先级</span>
          </div>
        </div>

        <div class="status-bar">
          <span class="field__label">切换状态</span>
          <div class="row">
            <button
              v-for="option in statusOptions"
              :key="option.value"
              class="btn btn--sm"
              :class="{ 'btn--primary': task.status === option.value }"
              type="button"
              :disabled="busy || task.status === option.value"
              @click="changeStatus(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>

        <dl class="definition">
          <dt>截止时间</dt>
          <dd>{{ formatDateTime(task.deadline) }}</dd>
          <dt>预计耗时</dt>
          <dd>{{ task.estimatedMinutes ? task.estimatedMinutes + ' 分钟' : '未填写' }}</dd>
          <dt>提交方式</dt>
          <dd>{{ task.submitMethod || '未填写' }}</dd>
          <dt>提交要求</dt>
          <dd>{{ task.submitRequirement || '未填写' }}</dd>
          <dt>说明</dt>
          <dd>{{ task.description || '无' }}</dd>
          <dt>创建 / 更新</dt>
          <dd>{{ formatDateTime(task.createdAt) }} / {{ formatDateTime(task.updatedAt) }}</dd>
          <dt>完成时间</dt>
          <dd>{{ task.completedAt ? formatDateTime(task.completedAt) : '尚未完成' }}</dd>
        </dl>
      </section>

      <section class="card">
        <div class="card__head">
          <div>
            <div class="card__title">
              <AppIcon name="inbox" :size="18" />
              原通知（{{ sources.length }}）
            </div>
            <p class="card__hint">保存老师原话和群消息截图，以后不用翻聊天记录</p>
          </div>
        </div>

        <ul v-if="sources.length" class="timeline">
          <li v-for="source in sources" :key="source.id" class="timeline__item">
            <div class="timeline__head">
              <span>{{ source.sourceName }}</span>
              <span class="badge badge--muted">{{ source.sourceType || '未标注来源类型' }}</span>
              <span class="small muted">记录于 {{ formatDateTime(source.capturedAt || source.createdAt) }}</span>
              <span class="spacer" />
              <button class="btn btn--sm btn--danger" type="button" @click="removeSource(source)">删除</button>
            </div>
            <p v-if="source.rawText" class="timeline__body">{{ source.rawText }}</p>
            <p v-else class="small muted">这条原通知只有图片，没有文字。</p>

            <div v-if="source.attachments.length" class="attachment-grid" style="margin: 8px 0">
              <AttachmentGallery
                v-for="attachment in source.attachments"
                :key="attachment.id"
                :attachment="attachment"
                removable
                @remove="removeAttachment"
              />
            </div>

            <label class="btn btn--sm" style="margin-top: 6px">
              上传图片
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden @change="uploadToSource(source, $event)" />
            </label>
          </li>
        </ul>
        <p v-else class="muted small">还没有记录原通知。粘贴老师原话、上传群消息截图，之后就能随时追溯。</p>

        <hr class="divider" />

        <h3 style="margin-bottom: 12px">新增原通知</h3>
        <div class="form-grid">
          <label class="field">
            <span class="field__label">来源名称<span class="field__required">*</span></span>
            <input v-model="sourceForm.sourceName" type="text" maxlength="128" placeholder="例如：数据结构课程群" />
          </label>
          <label class="field">
            <span class="field__label">来源类型</span>
            <select v-model="sourceForm.sourceType">
              <option value="WECHAT_GROUP">微信群</option>
              <option value="QQ_GROUP">QQ 群</option>
              <option value="LMS">学习平台（学习通等）</option>
              <option value="EMAIL">邮件</option>
              <option value="CLASS">课堂口头通知</option>
              <option value="MANUAL">其他</option>
            </select>
          </label>
          <label class="field form-grid--full">
            <span class="field__label">原通知文字</span>
            <textarea v-model="sourceForm.rawText" maxlength="4000" placeholder="把老师原话原样粘贴进来，便于以后核对" />
          </label>
          <div class="field form-grid--full">
            <span class="field__label">图片附件（可选，png/jpeg/webp/gif，单张 ≤ 5MB）</span>
            <label class="dropzone">
              点击选择截图
              <div class="dropzone__hint">
                {{ uploadFiles.length ? `已选择 ${uploadFiles.length} 张` : '支持一次选择多张；这里是通知原图留存，不做自动识别（课表照片识别在「课程与课表 → 照片导入课表」）' }}
              </div>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden @change="onFilesPicked" />
            </label>
          </div>
        </div>
        <div class="row" style="margin-top: 12px">
          <button class="btn btn--primary" type="button" :disabled="busy" @click="addSource">
            {{ busy ? '保存中…' : '保存原通知' }}
          </button>
        </div>
      </section>
    </template>
  </div>
</template>
