<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { CLASS_REMINDER_LEADS, decodeClassReminderSettings, defaultClassReminderSettings } from '@domain/classReminder'
import {
  decodeTaskReminder,
  encodeTaskReminder,
  evaluateTaskReminderEligibility,
  formatReminderMoment,
  MAX_ENABLED_TASK_REMINDERS,
  REMINDER_LEAD_OPTIONS,
  TASK_REMINDER_VERSION,
} from '@domain/taskReminder'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import LoadingState from '@/components/LoadingState.vue'
import { settingsApi } from '@/api'
import { notify, reminderState, remindersChanged } from '@/composables/reminderScheduler'
import { useSetting } from '@/composables/useSetting'
import { loadAllTasks, toDomainTask } from '@/domain/adapters'
import { SETTING_KEYS } from '@/domain/settingKeys'

const classSetting = useSetting(SETTING_KEYS.CLASS_REMINDER, {
  decode: decodeClassReminderSettings,
  encode: (s) => JSON.stringify(s),
})

const tasks = ref([])
const rows = ref(new Map()) // taskId -> { revision, intent }
const loading = ref(true)
const error = ref('')
const rowError = ref({})
const permission = ref(reminderState.supported ? Notification.permission : 'unsupported')

const activeTasks = computed(() =>
  tasks.value
    .filter((t) => t.status === 'TODO' || t.status === 'DOING')
    .sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999')),
)
const enabledCount = computed(() => [...rows.value.values()].filter((r) => r.intent?.enabled).length)
const classSettings = computed(() => classSetting.data.value ?? defaultClassReminderSettings())

const PERMISSION_TEXT = {
  granted: '已允许：到点会弹出系统通知。',
  denied: '浏览器已拒绝通知：到点只会在页面右下角提示。可在浏览器地址栏的站点设置里重新允许。',
  default: '还没授权：到点会在页面右下角提示；授权后可弹出系统通知。',
  unsupported: '这个浏览器不支持系统通知：到点会在页面右下角提示。',
}

function leadOf(task) {
  const intent = rows.value.get(task.id)?.intent
  return intent?.enabled ? intent.leadMinutes : 0
}

function statusOf(task) {
  const lead = leadOf(task)
  if (!lead) return null
  const check = evaluateTaskReminderEligibility(task, lead, Date.now())
  return check.eligible ? `将在 ${formatReminderMoment(check.triggerAtMs)} 提醒` : check.reason
}

async function setLead(task, value) {
  rowError.value = { ...rowError.value, [task.id]: '' }
  const lead = Number(value)
  const current = rows.value.get(task.id)
  if (lead && !current?.intent?.enabled && enabledCount.value >= MAX_ENABLED_TASK_REMINDERS) {
    rowError.value = { ...rowError.value, [task.id]: `最多同时开启 ${MAX_ENABLED_TASK_REMINDERS} 条截止提醒。` }
    return
  }
  if (lead) {
    const check = evaluateTaskReminderEligibility(task, lead, Date.now())
    if (!check.eligible) {
      rowError.value = { ...rowError.value, [task.id]: check.reason }
      return
    }
  }
  const intent = {
    version: TASK_REMINDER_VERSION,
    taskId: task.id,
    enabled: lead > 0,
    leadMinutes: lead || current?.intent?.leadMinutes || 30,
    revision: (current?.intent?.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  }
  try {
    const saved = await settingsApi.put(SETTING_KEYS.taskReminder(task.id), encodeTaskReminder(intent), current?.revision ?? 0)
    rows.value = new Map(rows.value).set(task.id, { revision: saved.revision, intent })
    remindersChanged()
  } catch (err) {
    rowError.value = { ...rowError.value, [task.id]: err.message }
    await load()
  }
}

async function saveClass(patch) {
  if (await classSetting.save({ ...classSettings.value, ...patch })) remindersChanged()
}

async function requestPermission() {
  if (!reminderState.supported) return
  permission.value = await Notification.requestPermission()
}

function testNotification() {
  window.setTimeout(
    () => notify({ id: `test.${Date.now()}`, title: 'DDL Mate 测试提醒', body: '提醒能正常弹出。', link: '/tools/reminders' }),
    3000,
  )
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [all, reminderRows] = await Promise.all([
      loadAllTasks(),
      settingsApi.listByPrefix('task_reminder.'),
      classSetting.load(),
    ])
    tasks.value = all.map(toDomainTask)
    const map = new Map()
    for (const row of reminderRows) {
      const decoded = decodeTaskReminder(row.value)
      if (decoded.ok) map.set(decoded.intent.taskId, { revision: row.revision, intent: decoded.intent })
    }
    rows.value = map
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <header class="page-head">
      <div>
        <span class="page-head__eyebrow"><AppIcon name="bell" :size="15" />工具</span>
        <h1>提醒</h1>
        <p class="page-head__sub">截止前提醒与上课前提醒。网页版<strong>只在 DDL Mate 页面开着时</strong>提醒，关掉浏览器就不会响。</p>
      </div>
    </header>

    <ErrorState v-if="error" :message="error" @retry="load" />
    <LoadingState v-else-if="loading" title="正在读取提醒设置…" />

    <template v-else>
      <div class="split" style="margin-bottom: 16px">
        <section class="card">
          <h2 class="card__title" style="margin-bottom: 8px"><AppIcon name="bell" :size="18" />通知方式</h2>
          <p class="small" style="margin: 0 0 12px">{{ PERMISSION_TEXT[permission] || PERMISSION_TEXT.default }}</p>
          <div class="row">
            <button v-if="permission === 'default'" type="button" class="btn btn--sm btn--primary" @click="requestPermission">
              允许系统通知
            </button>
            <button type="button" class="btn btn--sm" @click="testNotification">3 秒后测试一次</button>
          </div>
          <p v-if="reminderState.lastError" class="field__error">提醒读取失败：{{ reminderState.lastError }}</p>
        </section>

        <section class="card">
          <h2 class="card__title" style="margin-bottom: 8px"><AppIcon name="book" :size="18" />上课前提醒</h2>
          <p class="card__hint" style="margin-bottom: 12px">按课表（含单双周与教学周）在每节课开始前提醒。</p>
          <div class="row">
            <label class="checkbox-row">
              <input type="checkbox" :checked="classSettings.enabled" @change="saveClass({ enabled: $event.target.checked })" />
              开启
            </label>
            <select
              :value="classSettings.leadMinutes"
              aria-label="提前多久"
              :disabled="classSetting.saving.value"
              @change="saveClass({ leadMinutes: Number($event.target.value) })"
            >
              <option v-for="m in CLASS_REMINDER_LEADS" :key="m" :value="m">提前 {{ m }} 分钟</option>
            </select>
          </div>
          <p v-if="classSetting.error.value" class="field__error">{{ classSetting.error.value }}</p>
        </section>
      </div>

      <section class="card">
        <div class="card__head">
          <div>
            <h2 class="card__title"><AppIcon name="clock" :size="18" />截止前提醒</h2>
            <p class="card__hint">每条任务单独设置；已开启 {{ enabledCount }} / {{ MAX_ENABLED_TASK_REMINDERS }}。只记到日期的截止没有具体时刻，不能提醒。</p>
          </div>
        </div>
        <p v-if="activeTasks.length === 0" class="muted">没有未完成的任务。</p>
        <div v-else class="list-rows">
          <div v-for="task in activeTasks" :key="task.id" class="list-row">
            <div class="list-row__main">
              <RouterLink :to="`/tasks/${task.id}`" class="list-row__title">{{ task.title }}</RouterLink>
              <div class="list-row__meta">
                {{ task.deadline ? `截止 ${task.deadline.slice(0, 16).replace('T', ' ')}` : '无截止时间' }}
                <template v-if="statusOf(task)"> · {{ statusOf(task) }}</template>
              </div>
              <p v-if="rowError[task.id]" class="field__error" style="margin: 4px 0 0">{{ rowError[task.id] }}</p>
            </div>
            <select :value="leadOf(task)" aria-label="提醒提前量" :disabled="!task.deadline" @change="setLead(task, $event.target.value)">
              <option :value="0">不提醒</option>
              <option v-for="option in REMINDER_LEAD_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </div>
        </div>
      </section>

      <section v-if="reminderState.upcoming.length" class="card">
        <h2 class="section-title">接下来的提醒</h2>
        <div class="list-rows">
          <div v-for="item in reminderState.upcoming" :key="item.id" class="list-row">
            <span class="mono small">{{ formatReminderMoment(item.at) }}</span>
            <span class="list-row__main">{{ item.title }}</span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
