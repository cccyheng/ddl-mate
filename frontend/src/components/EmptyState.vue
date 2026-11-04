<script setup>
import { computed } from 'vue'
import AppIcon from '@/components/AppIcon.vue'

const props = defineProps({
  /**
   * 可以传本地 SVG 图标名（home / check / calendar …），
   * 也可以继续传原来的 emoji 字符；空态默认使用 inbox 图标。
   */
  icon: { type: String, default: 'inbox' },
  title: { type: String, default: '这里还没有内容' },
  description: { type: String, default: '' },
})

const ICON_NAMES = new Set([
  'home',
  'list',
  'calendar',
  'book',
  'inbox',
  'compass',
  'plus',
  'camera',
  'clock',
  'alert',
  'check',
  'search',
  'filter',
  'spark',
  'user',
])
const isSvgIcon = computed(() => ICON_NAMES.has(props.icon))
</script>

<template>
  <div class="state">
    <span class="state__icon">
      <AppIcon v-if="isSvgIcon" :name="icon" :size="20" />
      <template v-else>{{ icon }}</template>
    </span>
    <p class="state__title">{{ title }}</p>
    <p v-if="description" class="small muted" style="margin: 0">{{ description }}</p>
    <div v-if="$slots.default" class="state__actions">
      <slot />
    </div>
  </div>
</template>
