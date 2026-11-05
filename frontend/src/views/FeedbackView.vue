<script setup>
/**
 * 问题反馈：所有登录用户都能提交、看自己的反馈和站长回复；
 * 站长（ADMIN）多一个「全部反馈」：看所有人的反馈、标记处理、回复。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { feedbackApi, resetRequestApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import { feedbackState, refreshFeedbackRole } from '@/composables/feedbackState'

const route = useRoute()
const CATEGORY = { BUG: '问题', SUGGESTION: '建议', OTHER: '其他' }
const STATUS = { NEW: '未读', READ: '已读', DONE: '已处理' }
const STATUS_TONE = { NEW: 'warn', READ: 'primary', DONE: 'success' }

const tab = ref('submit')
const form = reactive({ category: 'BUG', content: '', contact: '' })
const sending = ref(false)
const message = ref('')
const error = ref('')
const mine = ref([])

const all = ref([])
const filter = ref('')
const replies = reactive({})
const adminError = ref('')
const loadingAll = ref(false)

const isAdmin = computed(() => feedbackState.admin)

function time(value) {
  return value ? String(value).slice(0, 16).replace('T', ' ') : ''
}

/** 提交前所在的页面（从侧栏点进来时由 ?from= 带过来），方便定位问题。 */
const fromPage = computed(() => (typeof route.query.from === 'string' ? route.query.from.slice(0, 200) : ''))

async function loadMine() {
  try {
    mine.value = await feedbackApi.mine()
  } catch (err) {
    error.value = err.message
  }
}

async function submit() {
  error.value = ''
  message.value = ''
  if (!form.content.trim()) {
    error.value = '请写下遇到的问题或建议。'
    return
  }
  sending.value = true
  try {
    await feedbackApi.submit({ ...form, page: fromPage.value || null })
    message.value = '已提交，谢谢！站长回复后会显示在「我的反馈」里。'
    form.content = ''
    await loadMine()
    await refreshFeedbackRole()
  } catch (err) {
    error.value = err.message
  } finally {
    sending.value = false
  }
}

async function loadAll() {
  loadingAll.value = true
  adminError.value = ''
  try {
    all.value = await feedbackApi.all(filter.value || undefined)
    for (const item of all.value) if (!(item.id in replies)) replies[item.id] = item.reply || ''
  } catch (err) {
    adminError.value = err.message
  } finally {
    loadingAll.value = false
  }
}

async function update(item, payload) {
  adminError.value = ''
  try {
    const updated = await feedbackApi.update(item.id, payload)
    Object.assign(item, updated)
    replies[item.id] = updated.reply || ''
    await refreshFeedbackRole()
  } catch (err) {
    adminError.value = err.message
  }
}

/* ---------- 站长：找回密码申请 ---------- */
const RESET_STATUS = { PENDING: '待处理', ISSUED: '已发临时密码', DISMISSED: '已忽略' }
const resets = ref([])
const issued = reactive({})
const copied = ref('')

async function loadResets() {
  adminError.value = ''
  try {
    resets.value = await resetRequestApi.list()
  } catch (err) {
    adminError.value = err.message
  }
}

async function openResets() {
  tab.value = 'resets'
  await loadResets()
}

async function issue(item) {
  if (!window.confirm(`为「${item.username}」生成临时密码？他原来的密码会立即失效。`)) return
  adminError.value = ''
  try {
    const result = await resetRequestApi.issue(item.id)
    issued[item.id] = result.tempPassword
    await loadResets()
    await refreshFeedbackRole()
  } catch (err) {
    adminError.value = err.message
  }
}

async function dismiss(item) {
  adminError.value = ''
  try {
    await resetRequestApi.dismiss(item.id)
    await loadResets()
    await refreshFeedbackRole()
  } catch (err) {
    adminError.value = err.message
  }
}

async function copyTemp(id) {
  try {
    await navigator.clipboard.writeText(issued[id])
    copied.value = id
  } catch {
    copied.value = ''
  }
}

async function openAll() {
  tab.value = 'all'
  await loadAll()
}

onMounted(async () => {
  await Promise.all([loadMine(), refreshFeedbackRole()])
  if (feedbackState.admin && route.query.tab === 'all') await openAll()
  if (feedbackState.admin && route.query.tab === 'resets') await openResets()
})
</script>

<template>
  <div>
    <header class="page-head">
      <div>
        <span class="page-head__eyebrow"><AppIcon name="inbox" :size="15" />帮助</span>
        <h1>问题反馈</h1>
        <p class="page-head__sub">遇到问题、有想要的功能，都可以写在这里。站长会看到，处理后回复会显示在「我的反馈」里。</p>
      </div>
    </header>

    <div class="seg" role="tablist" style="margin-bottom: 16px">
      <button type="button" class="seg__item" :class="{ 'seg__item--active': tab === 'submit' }" @click="tab = 'submit'">
        提交反馈
      </button>
      <button type="button" class="seg__item" :class="{ 'seg__item--active': tab === 'mine' }" @click="tab = 'mine'">
        我的反馈（{{ mine.length }}）
      </button>
      <button v-if="isAdmin" type="button" class="seg__item" :class="{ 'seg__item--active': tab === 'all' }" @click="openAll">
        全部反馈<span v-if="feedbackState.unread" class="feedback-badge">{{ feedbackState.unread }}</span>
      </button>
      <button v-if="isAdmin" type="button" class="seg__item" :class="{ 'seg__item--active': tab === 'resets' }" @click="openResets">
        找回密码<span v-if="feedbackState.resetPending" class="feedback-badge">{{ feedbackState.resetPending }}</span>
      </button>
    </div>

    <section v-if="tab === 'submit'" class="card">
      <div class="stack">
        <div class="row" style="gap: 6px">
          <span class="muted small">类型</span>
          <button
            v-for="(label, key) in CATEGORY"
            :key="key"
            type="button"
            class="chip"
            :class="{ 'chip--active': form.category === key }"
            @click="form.category = key"
          >
            {{ label }}
          </button>
        </div>
        <label class="field">
          <span class="field__label">内容<span class="field__required">*</span></span>
          <textarea
            v-model="form.content"
            rows="6"
            maxlength="2000"
            placeholder="遇到了什么问题？在哪个页面、做了什么操作、看到了什么提示？有想要的功能也可以写。"
          />
          <span class="field__hint">{{ form.content.length }} / 2000</span>
        </label>
        <label class="field">
          <span class="field__label">联系方式（可选）</span>
          <input v-model="form.contact" type="text" maxlength="100" placeholder="QQ / 微信 / 邮箱，方便站长联系你" />
        </label>
        <p v-if="fromPage" class="small muted" style="margin: 0">会一并记下你是从「{{ fromPage }}」页面点过来的。</p>
        <p v-if="error" class="field__error">{{ error }}</p>
        <div v-if="message" class="alert alert--success">{{ message }}</div>
        <button type="button" class="btn btn--primary" style="align-self: flex-start" :disabled="sending" @click="submit">
          {{ sending ? '正在提交…' : '提交反馈' }}
        </button>
      </div>
    </section>

    <section v-else-if="tab === 'mine'" class="card">
      <p v-if="!mine.length" class="muted" style="margin: 0">你还没有提交过反馈。</p>
      <div v-else class="feedback-list">
        <article v-for="item in mine" :key="item.id" class="feedback-item">
          <div class="row row--between">
            <span class="small">
              <span class="badge">{{ CATEGORY[item.category] }}</span>
              <span class="muted"> {{ time(item.createdAt) }}</span>
            </span>
            <span class="badge" :class="`badge--${STATUS_TONE[item.status]}`">{{ STATUS[item.status] }}</span>
          </div>
          <p class="feedback-item__content">{{ item.content }}</p>
          <div v-if="item.reply" class="feedback-reply">
            <strong>站长回复</strong><span class="muted small"> {{ time(item.repliedAt) }}</span>
            <p>{{ item.reply }}</p>
          </div>
        </article>
      </div>
    </section>

    <section v-else-if="tab === 'resets' && isAdmin" class="card">
      <p class="card__hint" style="margin-bottom: 12px">
        用户在登录页点「忘记密码」提交的申请。请先通过对方留的联系方式确认是本人，再生成临时密码发给他。
        临时密码 24 小时内有效、<b>只在这里显示一次</b>；对方登录后必须马上设新密码。
      </p>
      <p v-if="adminError" class="field__error">{{ adminError }}</p>
      <p v-if="!resets.length" class="muted" style="margin: 0">没有找回密码申请。</p>
      <div class="feedback-list">
        <article v-for="item in resets" :key="item.id" class="feedback-item" :class="{ 'feedback-item--new': item.status === 'PENDING' }">
          <div class="row row--between" style="flex-wrap: wrap; gap: 6px">
            <span class="small">
              <strong>{{ item.username }}</strong>
              <span v-if="!item.accountExists" class="badge badge--danger" style="margin-left: 6px">没有这个用户名</span>
              <span class="muted"> · {{ time(item.createdAt) }}</span>
            </span>
            <span class="badge" :class="item.status === 'PENDING' ? 'badge--warn' : 'badge--muted'">{{ RESET_STATUS[item.status] }}</span>
          </div>
          <p class="small" style="margin: 8px 0 0">联系方式：<b>{{ item.contact }}</b></p>
          <p v-if="item.note" class="feedback-item__content small">{{ item.note }}</p>
          <div v-if="issued[item.id]" class="temp-password">
            <span class="small">临时密码（只显示这一次，请发给 {{ item.username }}）：</span>
            <code class="temp-password__value">{{ issued[item.id] }}</code>
            <button type="button" class="btn btn--sm" @click="copyTemp(item.id)">{{ copied === item.id ? '已复制' : '复制' }}</button>
          </div>
          <div v-if="item.status === 'PENDING'" class="row" style="gap: 8px; margin-top: 8px; flex-wrap: wrap">
            <button type="button" class="btn btn--sm btn--primary" :disabled="!item.accountExists" @click="issue(item)">生成临时密码</button>
            <button type="button" class="btn btn--sm btn--ghost" @click="dismiss(item)">忽略</button>
          </div>
        </article>
      </div>
    </section>

    <section v-else-if="tab === 'all' && isAdmin" class="card">
      <div class="row row--between" style="margin-bottom: 12px; flex-wrap: wrap; gap: 8px">
        <div class="row" style="gap: 6px">
          <button
            v-for="option in [{ v: '', l: '全部' }, { v: 'NEW', l: '未读' }, { v: 'READ', l: '已读' }, { v: 'DONE', l: '已处理' }]"
            :key="option.v"
            type="button"
            class="chip"
            :class="{ 'chip--active': filter === option.v }"
            @click="filter = option.v; loadAll()"
          >
            {{ option.l }}
          </button>
        </div>
        <button type="button" class="btn btn--sm" :disabled="loadingAll" @click="loadAll">刷新</button>
      </div>
      <p v-if="adminError" class="field__error">{{ adminError }}</p>
      <p v-if="!loadingAll && !all.length" class="muted" style="margin: 0">没有反馈。</p>
      <div class="feedback-list">
        <article v-for="item in all" :key="item.id" class="feedback-item" :class="{ 'feedback-item--new': item.status === 'NEW' }">
          <div class="row row--between" style="flex-wrap: wrap; gap: 6px">
            <span class="small">
              <span class="badge">{{ CATEGORY[item.category] }}</span>
              <strong> {{ item.username }}</strong>
              <span class="muted"> · {{ time(item.createdAt) }}</span>
              <span v-if="item.page" class="muted"> · 来自 {{ item.page }}</span>
            </span>
            <span class="badge" :class="`badge--${STATUS_TONE[item.status]}`">{{ STATUS[item.status] }}</span>
          </div>
          <p class="feedback-item__content">{{ item.content }}</p>
          <p v-if="item.contact" class="small" style="margin: 0">联系方式：{{ item.contact }}</p>
          <p v-if="item.userAgent" class="small muted feedback-ua" :title="item.userAgent">{{ item.userAgent }}</p>
          <label class="field" style="margin-top: 8px">
            <span class="field__label">回复（用户能看到）</span>
            <textarea v-model="replies[item.id]" rows="2" maxlength="1000" placeholder="写给这位用户的回复" />
          </label>
          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <button type="button" class="btn btn--sm btn--primary" @click="update(item, { reply: replies[item.id] })">保存回复</button>
            <button v-if="item.status === 'NEW'" type="button" class="btn btn--sm" @click="update(item, { status: 'READ' })">标为已读</button>
            <button v-if="item.status !== 'DONE'" type="button" class="btn btn--sm" @click="update(item, { status: 'DONE' })">标为已处理</button>
            <button v-else type="button" class="btn btn--sm btn--ghost" @click="update(item, { status: 'READ' })">重新打开</button>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.feedback-list {
  display: grid;
  gap: 12px;
}
.feedback-item {
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-soft);
}
.feedback-item--new {
  border-color: var(--warn-line);
  background: var(--warn-soft);
}
.feedback-item__content {
  margin: 8px 0 6px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.feedback-reply {
  margin-top: 8px;
  padding: 10px 12px;
  border-left: 3px solid var(--primary);
  border-radius: var(--radius-sm);
  background: var(--primary-tint);
  font-size: 14px;
}
.feedback-reply p {
  margin: 4px 0 0;
  white-space: pre-wrap;
}
.feedback-ua {
  margin: 2px 0 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.temp-password {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--primary-tint);
  border: 1px dashed var(--primary-line);
}
.temp-password__value {
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  user-select: all;
}
.feedback-badge {
  display: inline-block;
  min-width: 18px;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--clay);
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}
</style>
