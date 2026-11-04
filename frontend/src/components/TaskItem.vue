<script setup>
import { computed } from 'vue'
import CountdownBadge from '@/components/CountdownBadge.vue'
import { formatDateTime } from '@/utils/datetime'

const props = defineProps({
  task: { type: Object, required: true },
  showCourse: { type: Boolean, default: true },
})

defineEmits(['toggle-status'])

const closed = computed(() => props.task.status === 'DONE' || props.task.status === 'ARCHIVED')
const overdue = computed(() => {
  if (closed.value || !props.task.deadline) return false
  return new Date(props.task.deadline).getTime() < Date.now()
})

const statusTone = computed(() => {
  if (props.task.status === 'DONE') return 'success'
  if (props.task.status === 'DOING') return 'primary'
  if (props.task.status === 'ARCHIVED') return 'muted'
  return 'muted'
})
</script>

<template>
  <li
    class="task-item"
    :class="{ 'task-item--overdue': overdue, 'task-item--done': closed }"
  >
    <div class="task-item__main">
      <RouterLink class="task-item__title" :to="`/tasks/${task.id}`">
        <span v-if="task.course" class="dot" :style="{ background: task.course.color || '#65746b' }" />
        <span>{{ task.title }}</span>
      </RouterLink>
      <div class="task-item__meta">
        <span class="task-item__due">
          DDL：{{ formatDateTime(task.deadline) }}
        </span>
        <span v-if="showCourse && task.course" class="badge badge--muted">{{ task.course.name }}</span>
        <span class="badge badge--muted">{{ task.typeLabel }}</span>
        <span v-if="task.estimatedMinutes">预计 {{ task.estimatedMinutes }} 分钟</span>
        <span v-if="task.sourceCount">原通知 {{ task.sourceCount }} 条</span>
      </div>
    </div>
    <div class="task-item__side">
      <CountdownBadge :deadline="task.deadline" :status="task.status" />
      <span class="badge" :class="`badge--${statusTone}`">{{ task.statusLabel }}</span>
      <span v-if="task.priority >= 4" class="badge badge--warn">{{ task.priorityLabel }}</span>
      <RouterLink class="btn btn--sm btn--ghost" :to="`/tasks/${task.id}`">详情</RouterLink>
      <button
        v-if="!closed"
        class="btn btn--sm"
        type="button"
        @click="$emit('toggle-status', task)"
      >
        标记完成
      </button>
      <button v-else class="btn btn--sm btn--ghost" type="button" @click="$emit('toggle-status', task)">
        恢复未完成
      </button>
    </div>
  </li>
</template>

<style scoped>
/* 小屏：操作区换行到标题下方，仍保持横向可点 */
@media (max-width: 640px) {
  .task-item__side {
    margin-top: 8px;
  }
}
</style>
