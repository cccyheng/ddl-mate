<script setup>
import { ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { authApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import { authState } from '@/utils/authState'

const route = useRoute()
const router = useRouter()
const username = ref('')
const password = ref('')
const show = ref(false)
const busy = ref(false)
const error = ref('')

/** 只允许跳回站内路径，防止 ?redirect= 被用来跳到别的网站。 */
function safeRedirect() {
  const target = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
  return target.startsWith('/') && !target.startsWith('//') ? target : '/'
}

async function submit() {
  error.value = ''
  busy.value = true
  try {
    await authApi.login(username.value.trim(), password.value)
    password.value = ''
    // 整页刷新：让顶栏、提醒等按已登录状态重新初始化
    window.location.assign(router.resolve(safeRedirect()).href)
  } catch (err) {
    error.value = err.message || '登录失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login">
    <form class="login__card card" @submit.prevent="submit">
      <span class="login__mark" aria-hidden="true"><AppIcon name="check" :size="24" /></span>
      <h1 class="login__title">DDL Mate</h1>
      <p class="muted small" style="margin: 0 0 18px">请登录后使用</p>
      <label class="field">
        <span class="field__label">用户名</span>
        <input v-model="username" type="text" autocomplete="username" required maxlength="64" autofocus />
      </label>
      <label class="field">
        <span class="field__label">密码</span>
        <input v-model="password" :type="show ? 'text' : 'password'" autocomplete="current-password" required maxlength="256" />
      </label>
      <label class="checkbox-row small">
        <input v-model="show" type="checkbox" />
        显示密码
      </label>
      <p v-if="error" class="field__error" role="alert">{{ error }}</p>
      <button type="submit" class="btn btn--primary btn--block btn--lg" :disabled="busy || !username || !password">
        {{ busy ? '正在登录…' : '登录' }}
      </button>
      <RouterLink v-if="authState.setupAvailable" class="small" to="/setup" style="text-align: center">
        有一次性设置码？去设置密码
      </RouterLink>
    </form>
  </div>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px 16px;
}

.login__card {
  width: min(380px, 100%);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 32px 28px;
  box-shadow: var(--shadow-lg);
}

.login__mark {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 14px;
  background: linear-gradient(145deg, var(--primary), var(--primary-dark));
  color: var(--brand-ink);
}

.login__title {
  margin: 4px 0 0;
  font-size: 1.5rem;
  letter-spacing: -0.02em;
}
</style>
