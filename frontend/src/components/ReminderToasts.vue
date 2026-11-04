<script setup>
import { RouterLink } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
import { dismissToast, reminderState } from '@/composables/reminderScheduler'
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <div v-for="toast in reminderState.toasts" :key="toast.id" class="toast">
      <span class="toast__icon"><AppIcon name="bell" :size="18" /></span>
      <div class="toast__body">
        <strong>{{ toast.title }}</strong>
        <span class="small muted">{{ toast.body }}</span>
        <RouterLink v-if="toast.link" class="small" :to="toast.link" @click="dismissToast(toast.id)">查看</RouterLink>
      </div>
      <button type="button" class="icon-btn" aria-label="关闭提醒" @click="dismissToast(toast.id)">
        <AppIcon name="close" :size="16" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 70;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(360px, calc(100vw - 32px));
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--primary-line);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  box-shadow: var(--shadow-lg);
  animation: toast-in 0.28s var(--ease);
}

.toast__icon {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 10px;
  background: var(--primary-soft);
  color: var(--primary);
}

.toast__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
}
</style>
