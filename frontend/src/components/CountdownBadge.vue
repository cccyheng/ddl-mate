<script setup>
import { computed } from 'vue'
import { remainingLabel } from '@/utils/datetime'

const props = defineProps({
  deadline: { type: String, default: null },
  status: { type: String, default: 'TODO' },
})

const closed = computed(() => props.status === 'DONE' || props.status === 'ARCHIVED')
const info = computed(() => remainingLabel(props.deadline))
const tone = computed(() => {
  if (closed.value) return 'success'
  return info.value.tone === 'muted' ? 'muted' : info.value.tone
})
</script>

<template>
  <span class="badge" :class="`badge--${tone}`">
    {{ closed ? '已完成' : info.text }}
  </span>
</template>
