<script setup>
/** 账号与安全：修改密码、注销账号。用临时密码登录时会被带到这里，先设新密码才能用别的功能。 */
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { authApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import { authState } from '@/utils/authState'
import { feedbackState, refreshFeedbackRole } from '@/composables/feedbackState'

const route = useRoute()
const forced = computed(() => authState.mustChangePassword || route.query.force === '1')

const pw = reactive({ oldPassword: '', newPassword: '', confirm: '', show: false, busy: false, error: '', done: '' })
const del = reactive({ password: '', confirmUsername: '', understood: false, busy: false, error: '' })

async function changePassword() {
  pw.error = ''
  pw.done = ''
  if (pw.newPassword.length < 10) {
    pw.error = '新密码至少 10 位。'
    return
  }
  if (pw.newPassword !== pw.confirm) {
    pw.error = '两次输入的新密码不一样。'
    return
  }
  pw.busy = true
  try {
    await authApi.changePassword(pw.oldPassword, pw.newPassword)
    const wasForced = forced.value
    authState.mustChangePassword = false
    Object.assign(pw, { oldPassword: '', newPassword: '', confirm: '' })
    pw.done = '密码已修改。下次登录请用新密码。'
    // 用临时密码登录的：改完整页刷新，回到正常使用
    if (wasForced) window.setTimeout(() => window.location.assign('/'), 900)
  } catch (err) {
    pw.error = err.message
  } finally {
    pw.busy = false
  }
}

async function deleteAccount() {
  del.error = ''
  if (!window.confirm('最后确认：注销后你的账号和全部数据都会被永久删除，无法恢复。继续吗？')) return
  del.busy = true
  try {
    await authApi.deleteAccount(del.password, del.confirmUsername.trim())
    window.location.assign('/login')
  } catch (err) {
    del.error = err.message
  } finally {
    del.busy = false
  }
}

onMounted(refreshFeedbackRole)
</script>

<template>
  <div>
    <header class="page-head">
      <div>
        <span class="page-head__eyebrow"><AppIcon name="user" :size="15" />账号</span>
        <h1>账号与安全</h1>
        <p class="page-head__sub">当前登录：<b>{{ authState.username }}</b></p>
      </div>
    </header>

    <div v-if="forced" class="alert alert--warn" style="margin-bottom: 16px">
      你正在使用站长发的<b>临时密码</b>。请先设置一个新密码，设置好之后才能使用其他功能。
    </div>

    <section class="card">
      <h2 class="card__title" style="margin-bottom: 12px"><AppIcon name="check" :size="18" />修改密码</h2>
      <div class="stack" style="max-width: 420px">
        <label class="field">
          <span class="field__label">{{ forced ? '临时密码' : '当前密码' }}</span>
          <input v-model="pw.oldPassword" :type="pw.show ? 'text' : 'password'" autocomplete="current-password" maxlength="256" />
        </label>
        <label class="field">
          <span class="field__label">新密码（至少 10 位）</span>
          <input v-model="pw.newPassword" :type="pw.show ? 'text' : 'password'" autocomplete="new-password" maxlength="256" />
        </label>
        <label class="field">
          <span class="field__label">再输一次新密码</span>
          <input v-model="pw.confirm" :type="pw.show ? 'text' : 'password'" autocomplete="new-password" maxlength="256" />
        </label>
        <label class="checkbox-row small">
          <input v-model="pw.show" type="checkbox" />
          显示密码
        </label>
        <p v-if="pw.error" class="field__error">{{ pw.error }}</p>
        <div v-if="pw.done" class="alert alert--success">{{ pw.done }}</div>
        <button
          type="button"
          class="btn btn--primary"
          style="align-self: flex-start"
          :disabled="pw.busy || !pw.oldPassword || !pw.newPassword"
          @click="changePassword"
        >
          {{ pw.busy ? '正在保存…' : '保存新密码' }}
        </button>
      </div>
    </section>

    <section v-if="!forced" class="card danger-zone">
      <h2 class="card__title" style="margin-bottom: 8px"><AppIcon name="trash" :size="18" />注销账号</h2>
      <template v-if="feedbackState.admin">
        <p class="small muted" style="margin: 0">你是站长，站长账号不能注销（否则网站就没有管理员了）。</p>
      </template>
      <template v-else>
        <p class="small" style="margin: 0 0 10px">
          注销会<b>永久删除</b>你的账号和全部数据：课程、课表、DDL、考试、专注记录、上传的图片、各项设置和反馈，<b>无法恢复</b>。
          建议先到 <RouterLink to="/tools/backup">备份与恢复</RouterLink> 导出一份备份。
        </p>
        <div class="stack" style="max-width: 420px">
          <label class="field">
            <span class="field__label">输入你的用户名「{{ authState.username }}」确认</span>
            <input v-model="del.confirmUsername" type="text" autocomplete="off" maxlength="64" />
          </label>
          <label class="field">
            <span class="field__label">密码</span>
            <input v-model="del.password" type="password" autocomplete="current-password" maxlength="256" />
          </label>
          <label class="checkbox-row small">
            <input v-model="del.understood" type="checkbox" />
            我已知晓：数据会被永久删除，无法恢复
          </label>
          <p v-if="del.error" class="field__error">{{ del.error }}</p>
          <button
            type="button"
            class="btn btn--danger"
            style="align-self: flex-start"
            :disabled="del.busy || !del.understood || !del.password || del.confirmUsername.trim().toLowerCase() !== authState.username.toLowerCase()"
            @click="deleteAccount"
          >
            {{ del.busy ? '正在注销…' : '永久注销账号' }}
          </button>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.danger-zone {
  border-color: var(--danger-line);
}
</style>
