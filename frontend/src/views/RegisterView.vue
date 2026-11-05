<script setup>
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { authApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'

const USERNAME = /^[a-z0-9][a-z0-9_-]{2,31}$/

const username = ref('')
const displayName = ref('')
const password = ref('')
const confirm = ref('')
const show = ref(false)
const busy = ref(false)
const error = ref('')

const normalized = computed(() => username.value.trim().toLowerCase())
const problem = computed(() => {
  if (username.value && !USERNAME.test(normalized.value)) {
    return '用户名需为 3–32 位小写字母、数字、下划线或短横线，并以字母或数字开头'
  }
  if (password.value && password.value.length < 10) return '密码至少 10 位'
  if (confirm.value && confirm.value !== password.value) return '两次输入的密码不一致'
  return ''
})
const ready = computed(
  () => USERNAME.test(normalized.value) && password.value.length >= 10 && confirm.value === password.value,
)

async function submit() {
  error.value = ''
  busy.value = true
  try {
    await authApi.register(normalized.value, password.value, displayName.value.trim() || null)
    password.value = ''
    confirm.value = ''
    window.location.assign('/')
  } catch (err) {
    error.value = err.message || '注册失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login">
    <form class="login__card card" @submit.prevent="submit">
      <span class="login__mark" aria-hidden="true"><AppIcon name="check" :size="24" /></span>
      <h1 class="login__title">注册 DDL Mate</h1>
      <p class="muted small" style="margin: 0 0 18px">每个账号的数据相互独立，别人看不到你的任务和课程。</p>
      <label class="field">
        <span class="field__label">用户名（登录用）</span>
        <input v-model="username" type="text" autocomplete="username" spellcheck="false" required maxlength="32" />
      </label>
      <label class="field">
        <span class="field__label">昵称（可选，显示用）</span>
        <input v-model="displayName" type="text" autocomplete="nickname" maxlength="64" />
      </label>
      <label class="field">
        <span class="field__label">密码（至少 10 位）</span>
        <input v-model="password" :type="show ? 'text' : 'password'" autocomplete="new-password" required maxlength="256" />
      </label>
      <label class="field">
        <span class="field__label">再输入一次</span>
        <input v-model="confirm" :type="show ? 'text' : 'password'" autocomplete="new-password" required maxlength="256" />
      </label>
      <label class="checkbox-row small">
        <input v-model="show" type="checkbox" />
        显示密码
      </label>
      <p v-if="problem" class="field__error">{{ problem }}</p>
      <p v-if="error" class="field__error" role="alert">{{ error }}</p>
      <button type="submit" class="btn btn--primary btn--block btn--lg" :disabled="busy || !ready">
        {{ busy ? '正在注册…' : '注册并登录' }}
      </button>
      <RouterLink class="small" to="/login" style="text-align: center">已有账号？去登录</RouterLink>
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
