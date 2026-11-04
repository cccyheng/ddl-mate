<script setup>
import { RouterLink } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
</script>

<template>
  <div class="card" style="text-align: center; padding: 48px 24px">
    <span class="state__icon" style="margin: 0 auto 12px">
      <AppIcon name="compass" :size="20" />
    </span>
    <h1>404 · 页面不存在</h1>
    <p class="muted">你访问的地址没有对应的页面。</p>
    <div class="row" style="justify-content: center">
      <RouterLink class="btn btn--primary" to="/">回到首页</RouterLink>
      <RouterLink class="btn" to="/tasks">任务列表</RouterLink>
    </div>
  </div>
</template>
