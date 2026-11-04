<script setup>
/**
 * 本地 SVG 图标（stroke 线性图标，24×24）。
 * 只内置界面真正用到的少量图标；颜色继承 currentColor，尺寸用 size 控制。
 * 不引入图标库、不加载网络资源，保证离线可用。
 */
import { computed } from 'vue'

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 20 },
  /** 纯装饰图标默认 aria-hidden；作为唯一可见标签时传 title 提供可访问名称。 */
  title: { type: String, default: '' },
})

const PATHS = {
  home: ['M3.5 10.6 12 3.8l8.5 6.8', 'M5.6 9.7V19a1.3 1.3 0 0 0 1.3 1.3h10.2A1.3 1.3 0 0 0 18.4 19V9.7', 'M9.8 20.2v-5.4h4.4v5.4'],
  list: ['M9 6.5h11', 'M9 12h11', 'M9 17.5h11', 'M4.6 6.5h.9', 'M4.6 12h.9', 'M4.6 17.5h.9'],
  calendar: ['M4.2 6.4a1.9 1.9 0 0 1 1.9-1.9h11.8a1.9 1.9 0 0 1 1.9 1.9v11.7a1.9 1.9 0 0 1-1.9 1.9H6.1a1.9 1.9 0 0 1-1.9-1.9z', 'M4.2 10h15.6', 'M8.6 3.4v3.2', 'M15.4 3.4v3.2'],
  book: ['M5 4.4h9.7a2.3 2.3 0 0 1 2.3 2.3v12.4H7.3A2.3 2.3 0 0 0 5 21.4z', 'M5 19.1a2.3 2.3 0 0 1 2.3-2.3h9.7', 'M9.4 9.2h4.2'],
  inbox: ['M3.6 13.2h4.2l1.2 2.2h6l1.2-2.2h4.2', 'M6.6 4.6h10.8l3 8.6v4.3a1.9 1.9 0 0 1-1.9 1.9H5.5a1.9 1.9 0 0 1-1.9-1.9v-4.3z'],
  compass: ['M12 3.6a8.4 8.4 0 1 1 0 16.8 8.4 8.4 0 0 1 0-16.8z', 'M14.8 9.2l-1.6 4-4 1.6 1.6-4z'],
  plus: ['M12 5.4v13.2', 'M5.4 12h13.2'],
  camera: ['M3.6 9.1h3.1l1.5-2.7h7.6l1.5 2.7h3.1v9a1.9 1.9 0 0 1-1.9 1.9H5.5a1.9 1.9 0 0 1-1.9-1.9z', 'M12 10.1a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8z'],
  clock: ['M12 3.6a8.4 8.4 0 1 1 0 16.8 8.4 8.4 0 0 1 0-16.8z', 'M12 7.8V12l3.2 1.9'],
  alert: ['M12 4.6 3 19.8h18z', 'M12 10.4v4.3', 'M12 17.1h.01'],
  check: ['M4.6 12.6 9.8 17.8 19.4 7'],
  chevronRight: ['M10 5.6 16.4 12 10 18.4'],
  menu: ['M4 7.4h16', 'M4 12h16', 'M4 16.6h16'],
  close: ['M6.2 6.2 17.8 17.8', 'M17.8 6.2 6.2 17.8'],
  search: ['M11 4.6a6.4 6.4 0 1 1 0 12.8 6.4 6.4 0 0 1 0-12.8z', 'M15.7 15.7 20 20'],
  filter: ['M4 6.2h16', 'M7 12h10', 'M10 17.8h4'],
  spark: ['M12 4.4v4.2', 'M4.4 12h4.2', 'M15.4 12h4.2', 'M12 15.4v4.2', 'M12 9.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6z'],
  user: ['M12 4.8a3.7 3.7 0 1 1 0 7.4 3.7 3.7 0 0 1 0-7.4z', 'M5.2 19.9a6.8 6.8 0 0 1 13.6 0'],
}

const paths = computed(() => PATHS[props.name] || [])
const label = computed(() => props.title || undefined)
</script>

<template>
  <svg
    class="app-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    :role="label ? 'img' : undefined"
    :aria-hidden="label ? undefined : 'true'"
    :aria-label="label"
    focusable="false"
  >
    <title v-if="label">{{ label }}</title>
    <path v-for="(d, index) in paths" :key="index" :d="d" />
  </svg>
</template>

<style scoped>
.app-icon {
  display: block;
  flex: none;
}
</style>
