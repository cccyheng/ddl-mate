<script setup>
/** 任务详情里的「步骤清单」：把任务手动拆成几步；勾选只是清单，不会改动任务本身。 */
import { computed, onMounted, ref } from 'vue'
import {
  clampStepTitleInput,
  decodeTaskSteps,
  encodeTaskSteps,
  MAX_TASK_STEPS,
  normalizeStepTitle,
  progressLabel,
  progressOf,
} from '@domain/taskSteps'
import AppIcon from '@/components/AppIcon.vue'
import { useSetting } from '@/composables/useSetting'

const props = defineProps({ taskId: { type: Number, required: true } })

/** data = { revision, steps }；从未保存过时 revision = 0。 */
const setting = useSetting(() => `task_steps.${props.taskId}`, {
  decode: (raw) => {
    if (raw === null) return { revision: 0, steps: [] }
    const result = decodeTaskSteps(raw)
    if (!result.ok) throw new Error(result.reason)
    return { revision: result.revision, steps: result.steps }
  },
  encode: ({ revision, steps }) => encodeTaskSteps(props.taskId, revision, steps),
})

const draft = ref('')
const message = ref('')
const steps = computed(() => setting.data.value?.steps ?? [])
const progress = computed(() => progressOf(steps.value))

const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

async function commit(nextSteps) {
  message.value = ''
  const ok = await setting.save({ revision: (setting.data.value?.revision ?? 0) + 1, steps: nextSteps })
  if (!ok) {
    message.value = setting.error.value
    if (setting.conflict.value) await setting.load().catch(() => {})
  }
  return ok
}

async function addStep() {
  const title = normalizeStepTitle(draft.value)
  if (!title) return
  if (steps.value.length >= MAX_TASK_STEPS) {
    message.value = `最多 ${MAX_TASK_STEPS} 步。`
    return
  }
  if (await commit([...steps.value, { id: newId(), title, done: false }])) draft.value = ''
}

const toggle = (step) => commit(steps.value.map((s) => (s.id === step.id ? { ...s, done: !s.done } : s)))
const remove = (step) => commit(steps.value.filter((s) => s.id !== step.id))

function move(index, delta) {
  const next = [...steps.value]
  const [item] = next.splice(index, 1)
  next.splice(index + delta, 0, item)
  commit(next)
}

onMounted(() => setting.load().catch(() => {}))
</script>

<template>
  <section class="card">
    <div class="card__head">
      <div>
        <h2 class="card__title"><AppIcon name="steps" :size="18" />步骤清单</h2>
        <p class="card__hint">把任务拆成几步；勾完所有步骤也不会自动完成任务。</p>
      </div>
      <span v-if="steps.length" class="badge badge--primary">{{ progressLabel(steps) }}</span>
    </div>

    <p v-if="setting.loading.value" class="muted small">正在读取…</p>
    <p v-else-if="setting.error.value && !setting.data.value" class="field__error">{{ setting.error.value }}</p>
    <template v-else>
      <div v-if="steps.length" class="progress" style="margin-bottom: 12px">
        <span class="progress__bar" :style="{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }" />
      </div>
      <div v-if="steps.length" class="list-rows" style="margin-bottom: 12px">
        <div v-for="(step, index) in steps" :key="step.id" class="list-row step-row">
          <input
            type="checkbox"
            :checked="step.done"
            :aria-label="`完成：${step.title}`"
            :disabled="setting.saving.value"
            @change="toggle(step)"
          />
          <span class="list-row__main" :class="{ 'step-row--done': step.done }">{{ step.title }}</span>
          <button type="button" class="btn btn--sm btn--ghost" :disabled="index === 0" aria-label="上移" @click="move(index, -1)">↑</button>
          <button
            type="button"
            class="btn btn--sm btn--ghost"
            :disabled="index === steps.length - 1"
            aria-label="下移"
            @click="move(index, 1)"
          >
            ↓
          </button>
          <button type="button" class="btn btn--sm btn--ghost" @click="remove(step)">删除</button>
        </div>
      </div>
      <form class="row" @submit.prevent="addStep">
        <input
          :value="draft"
          type="text"
          placeholder="添加一步，例如：查资料 / 写初稿"
          aria-label="新步骤"
          style="flex: 1 1 220px"
          @input="draft = clampStepTitleInput($event.target.value)"
        />
        <button type="submit" class="btn btn--sm" :disabled="!draft.trim() || setting.saving.value">
          <AppIcon name="plus" :size="15" />添加
        </button>
      </form>
      <p v-if="message" class="field__error">{{ message }}</p>
    </template>
  </section>
</template>

<style scoped>
.step-row--done {
  color: var(--text-muted);
  text-decoration: line-through;
}
</style>
