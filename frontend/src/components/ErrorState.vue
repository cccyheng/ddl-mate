<script setup>
defineProps({
  message: { type: String, required: true },
  tone: { type: String, default: 'danger' },
  fieldErrors: { type: Array, default: () => [] },
})

defineEmits(['retry'])
</script>

<template>
  <div class="stack">
    <div class="alert" :class="`alert--${tone}`" role="alert">
      <strong>出错了：</strong>{{ message }}
      <ul v-if="fieldErrors.length" style="margin: 6px 0 0; padding-left: 18px">
        <li v-for="item in fieldErrors" :key="item.field + item.message">
          {{ item.field }}：{{ item.message }}
        </li>
      </ul>
    </div>
    <div v-if="$slots.default">
      <slot />
    </div>
    <div v-else>
      <button class="btn btn--sm" type="button" @click="$emit('retry')">重试</button>
    </div>
  </div>
</template>
