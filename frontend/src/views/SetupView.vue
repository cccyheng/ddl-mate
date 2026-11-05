<script setup>
import { computed, ref } from 'vue'
import { authApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'

const token = ref('')
const password = ref('')
const confirm = ref('')
const show = ref(false)
const busy = ref(false)
const error = ref('')

const problem = computed(() => {
  if (password.value && password.value.length < 10) return '密码至少 10 位'
  if (confirm.value && confirm.value !== password.value) return '两次输入不一致'
  return ''
})
const ready = computed(() => token.value.trim() && password.value.length >= 10 && confirm.value === password.value)

async function submit() {
  error.value = ''
  busy.value = true
  try {
    await authApi.setup(token.value.trim(), password.value)
    password.value = ''
    confirm.value = ''
    window.location.assign('/')
  } catch (err) {
    error.value = err.message || '设置失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login">
    <form class="login__card card" @submit.prevent="submit">
      <span class="login__mark" aria-hidden="true"><AppIcon name="check" :size="24" /></span>
      <h1 class="login__title">设置登录密码</h1>
      <p class="muted small" style="margin: 0 0 18px">输入管理员给你的一次性设置码，再设置新密码。设置码用一次就失效。</p>
      <label class="field">
        <span class="field__label">设置码</span>
        <input v-model="token" type="text" autocomplete="one-time-code" spellcheck="false" required maxlength="256" />
      </label>
      <label class="field">
        <span class="field__label">新密码（至少 10 位）</span>
        <input v-model="password" :type="show ? 'text' : 'password'" autocomplete="new-password" required maxlength="256" />
      </label>
      <label class="field">
        <span class="field__label">再输入一次</span>
        <input v-model="confirm" :type="show ? 'text' : 'password'" autocomplete="new-password" required maxlength="256" />
      </label>
      <label class="checkbox-row small">
        <input v-model="show" type="checkbox" />
        显示密码（确认没有输错，例如输入法没切到英文）
      </label>
      <p v-if="problem" class="field__error">{{ problem }}</p>
      <p v-if="error" class="field__error" role="alert">{{ error }}</p>
      <button type="submit" class="btn btn--primary btn--block btn--lg" :disabled="busy || !ready">
        {{ busy ? '正在设置…' : '设置并登录' }}
      </button>
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
  width: min(400px, 100%);
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
  font-size: 1.45rem;
  letter-spacing: -0.02em;
}
</style>
