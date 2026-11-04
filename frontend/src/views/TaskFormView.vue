<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError, taskApi } from '@/api'
import ErrorState from '@/components/ErrorState.vue'
import LoadingState from '@/components/LoadingState.vue'
import TaskForm from '@/components/TaskForm.vue'
import { shanghaiWallClockToOffset } from '@/utils/datetime'

const route = useRoute()
const router = useRouter()

const taskId = computed(() => (route.params.id ? Number(route.params.id) : null))
const isEdit = computed(() => taskId.value !== null)

const loading = ref(isEdit.value)
const busy = ref(false)
const error = ref('')
const fieldErrors = ref({})
const task = ref(null)

async function load() {
  if (!isEdit.value) return
  loading.value = true
  error.value = ''
  try {
    task.value = await taskApi.get(taskId.value)
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function submit(payload) {
  // 表单里的 DDL 是**北京时间墙上时间**（TaskForm 统一过），提交时显式补 +08:00，
  // 不再经过本机时区，避免 UTC 浏览器保存时偏移 8 小时。
  const deadline = payload.deadline ? shanghaiWallClockToOffset(payload.deadline) : null
  if (payload.deadline && !deadline) {
    error.value = '截止时间不完整或不合法：请选到「日期 + 时刻」（按北京时间）。'
    return
  }
  busy.value = true
  error.value = ''
  fieldErrors.value = {}
  const body = { ...payload, deadline }
  try {
    const saved = isEdit.value ? await taskApi.update(taskId.value, body) : await taskApi.create(body)
    router.push(`/tasks/${saved.id}`)
  } catch (err) {
    if (err instanceof ApiError) {
      fieldErrors.value = err.fieldErrorMap()
      error.value = err.message
    } else {
      error.value = err.message
    }
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>{{ isEdit ? '编辑任务' : '新建任务' }}</h1>
        <p class="page-head__sub">
          {{ isEdit ? '修改后会立即保存到本地数据库' : '手动录入最可靠：标题 + 截止时间就是最小可用信息' }}
        </p>
      </div>
      <button class="btn" type="button" @click="router.back()">返回</button>
    </div>

    <LoadingState v-if="loading" title="正在加载任务…" />
    <ErrorState v-else-if="error && !task && isEdit" :message="error" @retry="load" />
    <section v-else class="card">
      <div v-if="error" class="alert alert--danger" style="margin-bottom: 16px">{{ error }}</div>
      <TaskForm
        :initial="task"
        :busy="busy"
        :field-errors="fieldErrors"
        :submit-label="isEdit ? '保存修改' : '创建任务'"
        @submit="submit"
        @cancel="router.push(isEdit ? `/tasks/${taskId}` : '/tasks')"
      />
    </section>
  </div>
</template>
