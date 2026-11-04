<script setup>
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { sourceApi } from '@/api'
import AttachmentGallery from '@/components/AttachmentGallery.vue'
import ErrorState from '@/components/ErrorState.vue'
import EmptyState from '@/components/EmptyState.vue'
import LoadingState from '@/components/LoadingState.vue'
import { formatDateTime } from '@/utils/datetime'

const loading = ref(true)
const error = ref('')
const sources = ref([])

async function load() {
  loading.value = true
  error.value = ''
  try {
    sources.value = await sourceApi.list()
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>原通知</h1>
        <p class="page-head__sub">所有保存过的老师原话与群消息截图，按记录时间倒序</p>
      </div>
      <div class="row">
        <RouterLink class="btn btn--primary" to="/tasks/import-notices">从通知创建任务</RouterLink>
        <RouterLink class="btn" to="/tasks">去任务列表</RouterLink>
      </div>
    </div>

    <div class="alert alert--warn" style="margin-bottom: 16px">
      从 V1.1 起，<strong>通知截图可以在浏览器里本地识别</strong>：
      <RouterLink to="/tasks/import-notices">从通知创建任务</RouterLink>
      支持粘贴文字、一次最多 8 张 PNG/JPEG/WebP 截图，通过<strong>浏览器本地 OCR</strong> +
      <strong>本地保守规则</strong>生成可编辑的任务候选，勾选确认后才写入任务与原通知。
      这里仍是「原样留存 + 随时回看」的列表；本页不修改、不删除你的原通知。
      <br />
      <strong>诚实说明：</strong>本轮没有接入大模型 AI 语义抽取；完整自然语言时间（如「下节课前」）仍在
      <RouterLink to="/about">路线图</RouterLink> 的 V1.2。课表照片的 OCR 入口在「课程与课表 → 照片导入课表」。
    </div>

    <ErrorState v-if="error" :message="error" @retry="load" />
    <LoadingState v-else-if="loading" title="正在加载原通知…" />
    <template v-else>
      <section v-if="sources.length" class="card">
        <ul class="timeline">
          <li v-for="source in sources" :key="source.id" class="timeline__item">
            <div class="timeline__head">
              <span>{{ source.sourceName }}</span>
              <span class="badge badge--muted">{{ source.sourceType || '未标注' }}</span>
              <span class="small muted">{{ formatDateTime(source.capturedAt || source.createdAt) }}</span>
              <span class="spacer" />
              <RouterLink v-if="source.taskId" class="btn btn--sm" :to="`/tasks/${source.taskId}`">
                查看任务：{{ source.taskTitle }}
              </RouterLink>
              <span v-else class="badge badge--warn">暂未绑定任务</span>
            </div>
            <p v-if="source.rawText" class="timeline__body">{{ source.rawText }}</p>
            <p v-else class="small muted">（无文字，仅图片）</p>
            <div v-if="source.attachments.length" class="attachment-grid" style="margin-top: 8px">
              <AttachmentGallery
                v-for="attachment in source.attachments"
                :key="attachment.id"
                :attachment="attachment"
              />
            </div>
          </li>
        </ul>
      </section>
      <EmptyState
        v-else
        icon="inbox"
        title="还没有保存任何原通知"
        description="打开任意任务详情，在「原通知」里粘贴老师原话并上传截图即可。"
      >
        <RouterLink class="btn btn--sm" to="/tasks">去任务列表</RouterLink>
      </EmptyState>
    </template>
  </div>
</template>
