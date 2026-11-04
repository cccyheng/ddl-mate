<script setup>
defineProps({
  title: { type: String, default: '加载中…' },
  rows: { type: Number, default: 3 },
})
</script>

<template>
  <div class="stack" role="status" :aria-label="title">
    <div v-for="index in rows" :key="index" class="skeleton" />
    <p class="muted small">{{ title }}</p>
  </div>
</template>
