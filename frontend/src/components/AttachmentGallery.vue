<script setup>
import { attachmentUrl } from '@/api'

defineProps({
  attachment: { type: Object, required: true },
  removable: { type: Boolean, default: false },
})

defineEmits(['remove'])
</script>

<template>
  <figure class="attachment" style="margin: 0">
    <a :href="attachmentUrl(attachment.id)" target="_blank" rel="noopener">
      <img class="attachment__img" :src="attachmentUrl(attachment.id)" :alt="attachment.originalName" />
    </a>
    <figcaption class="attachment__meta">
      <span class="attachment__name" :title="attachment.originalName">{{ attachment.originalName }}</span>
      <span>{{ Math.round(attachment.sizeBytes / 1024) }} KB</span>
    </figcaption>
    <div class="attachment__meta" style="border-top: 1px solid var(--border)">
      <a :href="attachmentUrl(attachment.id, true)">下载</a>
      <button v-if="removable" class="btn btn--sm btn--ghost" type="button" @click="$emit('remove', attachment)">
        删除
      </button>
    </div>
  </figure>
</template>
