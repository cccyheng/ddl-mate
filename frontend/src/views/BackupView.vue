<script setup>
import { ref } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import { backupApi } from '@/api'
import { remindersChanged } from '@/composables/reminderScheduler'

const TABLE_LABELS = {
  courses: '课程',
  course_schedules: '课表',
  tasks: '任务',
  task_sources: '原通知',
  attachments: '附件图片',
  app_settings: '其他设置（专注、计划、模板…）',
}

const exporting = ref(false)
const exportMessage = ref('')
const fileName = ref('')
const backup = ref(null)
const preview = ref(null)
const busy = ref(false)
const error = ref('')
const restored = ref(null)

async function exportBackup() {
  exporting.value = true
  exportMessage.value = ''
  try {
    const data = await backupApi.export()
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `ddlmate-web-backup-${data.exportedAt.slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    const counts = data.counts
    exportMessage.value = `已导出：${counts.tasks} 个任务、${counts.courses} 门课程、${counts.attachments} 张图片。${
      data.missingFiles ? `（有 ${data.missingFiles} 张图片在磁盘上找不到，未包含）` : ''
    }`
  } catch (err) {
    exportMessage.value = `导出失败：${err.message}`
  } finally {
    exporting.value = false
  }
}

async function pickFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  error.value = ''
  preview.value = null
  restored.value = null
  fileName.value = file.name
  busy.value = true
  try {
    backup.value = JSON.parse(await file.text())
    preview.value = await backupApi.preview(backup.value)
  } catch (err) {
    backup.value = null
    error.value = err instanceof SyntaxError ? '文件不是有效的 JSON。' : err.message
  } finally {
    busy.value = false
  }
}

async function restore() {
  if (!window.confirm('确定用这个备份替换当前全部数据？替换前会自动保存一份当前数据的安全副本。')) return
  busy.value = true
  error.value = ''
  try {
    restored.value = await backupApi.restore(backup.value)
    preview.value = null
    backup.value = null
    remindersChanged()
  } catch (err) {
    error.value = `恢复失败，当前数据保持不变：${err.message}`
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <header class="page-head">
      <div>
        <span class="page-head__eyebrow"><AppIcon name="archive" :size="15" />工具</span>
        <h1>备份与恢复</h1>
        <p class="page-head__sub">把电脑版的全部数据（含通知截图）导出成一个文件；需要时再整体恢复。电脑版备份与手机备份格式不同，不能互导。</p>
      </div>
    </header>

    <div class="split">
      <section class="card">
        <h2 class="card__title" style="margin-bottom: 8px"><AppIcon name="download" :size="18" />导出备份</h2>
        <p class="card__hint" style="margin-bottom: 14px">导出课程、课表、任务、原通知、图片，以及专注记录、今日计划、模板、复习安排等全部设置。</p>
        <button type="button" class="btn btn--primary" :disabled="exporting" @click="exportBackup">
          {{ exporting ? '正在导出…' : '导出备份文件' }}
        </button>
        <p v-if="exportMessage" class="small" style="margin: 10px 0 0">{{ exportMessage }}</p>
      </section>

      <section class="card">
        <h2 class="card__title" style="margin-bottom: 8px"><AppIcon name="upload" :size="18" />从备份恢复</h2>
        <p class="card__hint" style="margin-bottom: 14px">先选文件预览内容，确认后才会替换；替换前自动保存当前数据的安全副本。</p>
        <label class="btn" :class="{ 'btn--disabled': busy }">
          选择备份文件
          <input type="file" accept="application/json,.json" class="visually-hidden" :disabled="busy" @change="pickFile" />
        </label>
        <p v-if="busy" class="muted small" style="margin-top: 10px">正在处理…</p>
        <p v-if="error" class="field__error">{{ error }}</p>
      </section>
    </div>

    <section v-if="preview" class="card card--accent">
      <h2 class="card__title" style="margin-bottom: 6px">备份内容预览</h2>
      <p class="card__hint" style="margin-bottom: 12px">文件：{{ fileName }} · 导出于 {{ String(preview.exportedAt).slice(0, 16).replace('T', ' ') }}</p>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>内容</th>
              <th>备份里</th>
              <th>当前</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(label, key) in TABLE_LABELS" :key="key">
              <td>{{ label }}</td>
              <td>{{ preview.counts[key] }}</td>
              <td class="muted">{{ preview.currentCounts[key] }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="alert alert--warn" style="margin: 14px 0">恢复会用左列替换当前的全部数据（当前数据会先存一份安全副本）。</div>
      <div class="row">
        <button type="button" class="btn btn--danger" :disabled="busy" @click="restore">确认替换并恢复</button>
        <button type="button" class="btn btn--ghost" @click="preview = null">取消</button>
      </div>
    </section>

    <section v-if="restored" class="card">
      <h2 class="card__title" style="margin-bottom: 8px"><AppIcon name="check" :size="18" />已恢复</h2>
      <p class="small" style="margin: 0 0 6px">
        {{ restored.counts.tasks }} 个任务、{{ restored.counts.courses }} 门课程、{{ restored.counts.attachments }} 张图片已写回。
      </p>
      <p class="small muted" style="margin: 0">恢复前的安全副本：<span class="mono">{{ restored.safetyCopy }}</span></p>
    </section>
  </div>
</template>
