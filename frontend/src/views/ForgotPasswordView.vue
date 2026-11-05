<script setup>
/** 忘记密码：账号没有绑定邮箱 / 手机，提交申请后由站长核对身份，通过你留的联系方式发临时密码。 */
import { reactive } from 'vue'
import { RouterLink } from 'vue-router'
import { authApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'

const form = reactive({ username: '', contact: '', note: '' })
const state = reactive({ busy: false, error: '', done: '' })

async function submit() {
  state.error = ''
  state.busy = true
  try {
    const result = await authApi.resetRequest({ ...form, username: form.username.trim() })
    state.done = result.message
  } catch (err) {
    state.error = err.message
  } finally {
    state.busy = false
  }
}
</script>

<template>
  <div class="login">
    <form class="login__card card" @submit.prevent="submit">
      <span class="login__mark" aria-hidden="true"><AppIcon name="check" :size="24" /></span>
      <h1 class="login__title">忘记密码</h1>
      <template v-if="!state.done">
        <p class="muted small" style="margin: 0 0 18px">
          账号没有绑定邮箱或手机，所以由站长帮你重置：留下用户名和联系方式，站长核对后会把<b>临时密码</b>发给你（24 小时内有效），登录后再设新密码。
        </p>
        <label class="field">
          <span class="field__label">用户名</span>
          <input v-model="form.username" type="text" autocomplete="username" required maxlength="64" autofocus />
        </label>
        <label class="field">
          <span class="field__label">联系方式</span>
          <input v-model="form.contact" type="text" required maxlength="100" placeholder="QQ / 微信 / 邮箱" />
        </label>
        <label class="field">
          <span class="field__label">补充说明（可选）</span>
          <textarea v-model="form.note" rows="3" maxlength="500" placeholder="方便站长确认是你本人，例如注册时间、有哪些课程" />
        </label>
        <p v-if="state.error" class="field__error" role="alert">{{ state.error }}</p>
        <button type="submit" class="btn btn--primary btn--block btn--lg" :disabled="state.busy || !form.username || !form.contact">
          {{ state.busy ? '正在提交…' : '提交申请' }}
        </button>
      </template>
      <div v-else class="alert alert--success">{{ state.done }}</div>
      <RouterLink class="small" to="/login" style="text-align: center">返回登录</RouterLink>
    </form>
  </div>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px 16px;
  background: var(--bg);
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
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  background: linear-gradient(145deg, var(--primary), var(--primary-dark));
  color: var(--brand-ink);
}
.login__title {
  margin: 4px 0 0;
  font-size: 1.4rem;
}
</style>
