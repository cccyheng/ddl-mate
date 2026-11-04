<script setup>
/**
 * 任务批量操作：多选未完成任务 → 统一完成 / 改截止 / 清除截止。
 * 执行前逐条重新读取并比对指纹（手机端同一规则），选中后被别处改过的任务会跳过并说明。
 */
import { computed, reactive, ref } from 'vue'
import { batchDeadline, batchTarget, isBatchEligible, TASK_BATCH_LIMIT, taskFingerprint, validateBatch } from '@domain/taskBatch'
import AppIcon from '@/components/AppIcon.vue'
import { taskApi } from '@/api'
import { toDomainTask } from '@/domain/mappers'
import { deadlineForWeb } from '@/domain/taskTypes'

const props = defineProps({ tasks: { type: Array, required: true } })
const emit = defineEmits(['close', 'changed'])

const selected = reactive(new Map()) // id -> target
const action = ref('complete')
const deadlineValue = ref('')
const busy = ref(false)
const message = ref('')
const errorText = ref('')

const eligible = computed(() => props.tasks.filter((task) => isBatchEligible(toDomainTask(task))))
const allSelected = computed(() => eligible.value.length > 0 && eligible.value.every((t) => selected.has(t.id)))

function toggle(task) {
  if (selected.has(task.id)) selected.delete(task.id)
  else if (selected.size < TASK_BATCH_LIMIT) selected.set(task.id, batchTarget(toDomainTask(task)))
}

function toggleAll() {
  if (allSelected.value) selected.clear()
  else for (const task of eligible.value) if (!selected.has(task.id)) toggle(task)
}

async function run() {
  message.value = ''
  errorText.value = ''
  const request = {
    targets: [...selected.values()],
    action:
      action.value === 'deadline' ? { kind: 'deadline', value: deadlineValue.value } : { kind: action.value },
    generation: 0,
  }
  let deadline
  try {
    validateBatch(request)
    deadline = deadlineForWeb(batchDeadline(request.action))
  } catch (err) {
    errorText.value = err.message
    return
  }
  const label = { complete: '标记完成', deadline: '修改截止时间', clearDeadline: '清除截止时间' }[action.value]
  if (!window.confirm(`对选中的 ${request.targets.length} 个任务${label}？`)) return

  busy.value = true
  const updated = []
  const skipped = []
  try {
    for (const target of request.targets) {
      const fresh = await taskApi.get(target.id).catch(() => null)
      if (!fresh || taskFingerprint(toDomainTask(fresh)) !== target.fingerprint) {
        skipped.push(target.title)
        continue
      }
      if (action.value === 'complete') await taskApi.changeStatus(target.id, 'DONE')
      else if (action.value === 'deadline') await taskApi.patch(target.id, { deadline })
      else await taskApi.patch(target.id, { clearDeadline: true })
      updated.push(target.id)
    }
    message.value = `已处理 ${updated.length} 个任务。`
    if (skipped.length) errorText.value = `有 ${skipped.length} 个任务在选中后被修改或删除，已跳过：${skipped.join('、')}`
    selected.clear()
    emit('changed')
  } catch (err) {
    errorText.value = `已处理 ${updated.length} 个，之后出错：${err.message}`
    emit('changed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="card card--accent batch-panel">
    <div class="card__head">
      <div>
        <h2 class="card__title"><AppIcon name="check" :size="18" />批量操作</h2>
        <p class="card__hint">只能选本页未完成的任务，一次最多 {{ TASK_BATCH_LIMIT }} 个。</p>
      </div>
      <button type="button" class="btn btn--sm btn--ghost" @click="emit('close')">退出批量</button>
    </div>

    <div class="row" style="margin-bottom: 10px">
      <button type="button" class="btn btn--sm" :disabled="!eligible.length" @click="toggleAll">
        {{ allSelected ? '取消全选' : '全选本页' }}
      </button>
      <span class="muted small">已选 {{ selected.size }}</span>
    </div>

    <div class="list-rows" style="margin-bottom: 12px">
      <label v-for="task in eligible" :key="task.id" class="list-row batch-row">
        <input type="checkbox" :checked="selected.has(task.id)" @change="toggle(task)" />
        <span class="list-row__main">
          <span class="list-row__title">{{ task.title }}</span>
          <span class="list-row__meta">
            {{ task.course?.name || '未关联课程' }} ·
            {{ task.deadline ? `DDL ${task.deadline.slice(0, 16).replace('T', ' ')}` : '无截止时间' }}
          </span>
        </span>
      </label>
      <p v-if="!eligible.length" class="list-row muted small" style="margin: 0">本页没有可批量处理的未完成任务。</p>
    </div>

    <div class="row">
      <div class="seg">
        <button
          v-for="option in [
            { value: 'complete', label: '标记完成' },
            { value: 'deadline', label: '统一截止' },
            { value: 'clearDeadline', label: '清除截止' },
          ]"
          :key="option.value"
          type="button"
          class="seg__item"
          :class="{ 'seg__item--active': action === option.value }"
          @click="action = option.value"
        >
          {{ option.label }}
        </button>
      </div>
      <input v-if="action === 'deadline'" v-model="deadlineValue" type="datetime-local" aria-label="新的截止时间（北京时间）" />
      <button type="button" class="btn btn--primary" :disabled="!selected.size || busy" @click="run">
        {{ busy ? '处理中…' : '执行' }}
      </button>
    </div>
    <p v-if="message" class="muted small" style="margin: 10px 0 0">{{ message }}</p>
    <p v-if="errorText" class="field__error">{{ errorText }}</p>
  </section>
</template>

<style scoped>
.batch-panel {
  margin-bottom: 16px;
}

.batch-row {
  cursor: pointer;
}
</style>
