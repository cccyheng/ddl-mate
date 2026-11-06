<script setup>
/**
 * 站长的用户管理：所有账号的注册时间、最近登录、登录次数、数据量；展开看每次登录记录；一键封号 / 解封。
 * 只显示数量，不显示别人的课程、任务等具体内容。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { userAdminApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import { feedbackState, refreshFeedbackRole } from '@/composables/feedbackState'

const users = ref([])
const loading = ref(true)
const error = ref('')
const query = ref('')
const statusFilter = ref('all')
const sortKey = ref('createdAt')
const expanded = ref(null)
const logins = reactive({})
const busyId = ref(null)

function time(value) {
  return value ? String(value).slice(0, 16).replace('T', ' ') : '—'
}

function browser(ua) {
  if (!ua) return '未知'
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  const app = /MicroMessenger/.test(ua) ? '微信' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ua.slice(0, 24)
  return [os, app].filter(Boolean).join(' · ')
}

const KIND = { LOGIN: '登录', REGISTER: '注册', SETUP: '设置密码' }

const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = users.value.filter((u) => {
    if (statusFilter.value === 'active' && u.disabled) return false
    if (statusFilter.value === 'disabled' && !u.disabled) return false
    return !q || u.username.toLowerCase().includes(q) || (u.displayName || '').toLowerCase().includes(q)
  })
  const key = sortKey.value
  return [...list].sort((a, b) => {
    if (key === 'loginCount' || key === 'tasks') return b[key] - a[key]
    return String(b[key] || '').localeCompare(String(a[key] || ''))
  })
})

const stats = computed(() => ({
  total: users.value.length,
  disabled: users.value.filter((u) => u.disabled).length,
  activeWeek: users.value.filter((u) => u.lastLoginAt && Date.now() - new Date(u.lastLoginAt).getTime() < 7 * 86400000).length,
}))

async function load() {
  loading.value = true
  error.value = ''
  try {
    users.value = await userAdminApi.list()
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function toggle(user) {
  if (expanded.value === user.id) {
    expanded.value = null
    return
  }
  expanded.value = user.id
  if (!logins[user.id]) {
    try {
      logins[user.id] = await userAdminApi.logins(user.id)
    } catch (err) {
      error.value = err.message
    }
  }
}

function replace(updated) {
  users.value = users.value.map((u) => (u.id === updated.id ? updated : u))
}

async function ban(user) {
  const reason = window.prompt(`封禁「${user.username}」？\n封禁后他不能登录，已登录的设备会立即退出；数据保留，可以随时解封。\n\n可以填写原因（会显示给对方，可留空）：`, '')
  if (reason === null) return
  busyId.value = user.id
  error.value = ''
  try {
    replace(await userAdminApi.ban(user.id, reason.trim()))
  } catch (err) {
    error.value = err.message
  } finally {
    busyId.value = null
  }
}

async function unban(user) {
  if (!window.confirm(`解封「${user.username}」？解封后他可以正常登录。`)) return
  busyId.value = user.id
  error.value = ''
  try {
    replace(await userAdminApi.unban(user.id))
  } catch (err) {
    error.value = err.message
  } finally {
    busyId.value = null
  }
}

onMounted(async () => {
  await refreshFeedbackRole()
  if (feedbackState.admin) await load()
  else loading.value = false
})
</script>

<template>
  <div>
    <header class="page-head">
      <div>
        <span class="page-head__eyebrow"><AppIcon name="user" :size="15" />站长</span>
        <h1>用户管理</h1>
        <p class="page-head__sub">所有注册账号的注册时间和登录记录；可以一键封号（数据保留，可解封）。只显示数量，不显示别人的具体内容。</p>
      </div>
      <div class="row">
        <button type="button" class="btn" :disabled="loading" @click="load">刷新</button>
      </div>
    </header>

    <section v-if="!loading && !feedbackState.admin" class="card">
      <p class="muted" style="margin: 0">只有站长可以查看用户管理。</p>
    </section>

    <template v-else>
      <div class="grid grid--3" style="margin-bottom: 16px">
        <div class="card stat"><span class="stat__value">{{ stats.total }}</span><span class="stat__label">账号总数</span></div>
        <div class="card stat"><span class="stat__value">{{ stats.activeWeek }}</span><span class="stat__label">7 天内登录过</span></div>
        <div class="card stat"><span class="stat__value">{{ stats.disabled }}</span><span class="stat__label">已封禁</span></div>
      </div>

      <section class="card">
        <div class="row" style="gap: 10px; flex-wrap: wrap; margin-bottom: 12px; align-items: center">
          <input v-model="query" type="search" placeholder="搜索用户名 / 显示名" style="max-width: 240px" />
          <select v-model="statusFilter" style="max-width: 140px">
            <option value="all">全部状态</option>
            <option value="active">正常</option>
            <option value="disabled">已封禁</option>
          </select>
          <select v-model="sortKey" style="max-width: 160px">
            <option value="createdAt">按注册时间</option>
            <option value="lastLoginAt">按最近登录</option>
            <option value="loginCount">按登录次数</option>
            <option value="tasks">按 DDL 数量</option>
          </select>
          <span class="small muted">共 {{ shown.length }} 个</span>
        </div>
        <p v-if="error" class="field__error">{{ error }}</p>
        <p v-if="loading" class="muted small">正在读取…</p>

        <div v-else class="table-wrap">
          <table class="table users-table">
            <thead>
              <tr>
                <th>用户名</th>
                <th>注册时间</th>
                <th>最近登录</th>
                <th>登录次数</th>
                <th>课程 / DDL</th>
                <th>状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="user in shown" :key="user.id">
                <tr class="users-row" :class="{ 'users-row--disabled': user.disabled }" @click="toggle(user)">
                  <td>
                    <strong>{{ user.username }}</strong>
                    <span v-if="user.role === 'ADMIN'" class="badge badge--primary" style="margin-left: 6px">站长</span>
                    <div v-if="user.displayName && user.displayName !== user.username" class="small muted">{{ user.displayName }}</div>
                  </td>
                  <td class="small">{{ time(user.createdAt) }}</td>
                  <td class="small">{{ time(user.lastLoginAt) }}</td>
                  <td>{{ user.loginCount }}</td>
                  <td class="small">{{ user.courses }} / {{ user.tasks }}</td>
                  <td>
                    <span v-if="user.disabled" class="badge badge--danger" :title="user.disabledReason || ''">已封禁</span>
                    <span v-else class="badge badge--success">正常</span>
                  </td>
                  <td @click.stop>
                    <template v-if="user.role !== 'ADMIN'">
                      <button v-if="!user.disabled" type="button" class="btn btn--sm btn--danger" :disabled="busyId === user.id" @click="ban(user)">封号</button>
                      <button v-else type="button" class="btn btn--sm" :disabled="busyId === user.id" @click="unban(user)">解封</button>
                    </template>
                  </td>
                </tr>
                <tr v-if="expanded === user.id" class="users-detail">
                  <td colspan="7">
                    <p v-if="user.disabled" class="small" style="margin: 0 0 8px">
                      封禁于 {{ time(user.disabledAt) }}<template v-if="user.disabledReason">，原因：{{ user.disabledReason }}</template>
                    </p>
                    <p v-if="!logins[user.id]" class="small muted" style="margin: 0">正在读取登录记录…</p>
                    <p v-else-if="!logins[user.id].length" class="small muted" style="margin: 0">没有登录记录（这个功能上线前的登录没有记录）。</p>
                    <table v-else class="login-table">
                      <thead>
                        <tr><th>时间</th><th>方式</th><th>IP</th><th>设备 / 浏览器</th></tr>
                      </thead>
                      <tbody>
                        <tr v-for="(entry, i) in logins[user.id]" :key="i">
                          <td class="mono small">{{ time(entry.createdAt) }}</td>
                          <td class="small">{{ KIND[entry.kind] || entry.kind }}</td>
                          <td class="mono small">{{ entry.ip || '—' }}</td>
                          <td class="small" :title="entry.userAgent || ''">{{ browser(entry.userAgent) }}</td>
                        </tr>
                      </tbody>
                    </table>
                    <p v-if="logins[user.id]?.length === 100" class="small muted" style="margin: 6px 0 0">只显示最近 100 次。</p>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <p class="small muted" style="margin: 10px 0 0">点一行展开这个账号的登录记录。</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 0;
}
.stat__value {
  font-size: 1.8rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.stat__label {
  color: var(--text-muted);
  font-size: 13px;
}
.users-row {
  cursor: pointer;
}
.users-row:hover td {
  background: var(--surface-soft);
}
.users-row--disabled td {
  opacity: 0.75;
}
.users-detail td {
  background: var(--surface-soft);
}
.login-table {
  width: 100%;
  border-collapse: collapse;
}
.login-table th,
.login-table td {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}
.login-table th {
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 600;
}
</style>
