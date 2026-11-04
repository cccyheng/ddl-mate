<script setup>
import { computed, onMounted, ref } from 'vue'
import { createCalibration, describeCalibration, todayInBeijing } from '@domain/teachingWeek'
import AppIcon from '@/components/AppIcon.vue'
import ErrorState from '@/components/ErrorState.vue'
import LoadingState from '@/components/LoadingState.vue'
import { settingsApi } from '@/api'
import { SETTING_KEYS } from '@/domain/settingKeys'

/** 校准用 4 个键（与手机端同名同格式）；读取时任一不一致都视为没有校准，绝不拼出半套数据。 */
const KEYS = [
  SETTING_KEYS.SEMESTER_START_MONDAY,
  SETTING_KEYS.CALIBRATED_WEEK,
  SETTING_KEYS.CALIBRATED_TODAY,
  SETTING_KEYS.CALIBRATED_AT,
]

const loading = ref(true)
const error = ref('')
const rows = ref({})
const draft = ref('')
const saving = ref(false)
const message = ref('')

const today = todayInBeijing()

const calibration = computed(() => {
  const [monday, week, calibratedToday, setAt] = KEYS.map((key) => rows.value[key]?.value ?? null)
  if (!monday || !week || !calibratedToday) return null
  const recomputed = createCalibration(calibratedToday, Number(week), setAt ?? '')
  if (!recomputed.ok || recomputed.calibration.semesterStartMonday !== monday) return null
  return recomputed.calibration
})
const summary = computed(() => describeCalibration(calibration.value, today))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const results = await Promise.all(KEYS.map((key) => settingsApi.get(key)))
    rows.value = Object.fromEntries(results.map((r) => [r.key, r]))
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function save() {
  message.value = ''
  const result = createCalibration(today, draft.value, new Date().toISOString())
  if (!result.ok) {
    message.value = result.reason
    return
  }
  const values = {
    [SETTING_KEYS.SEMESTER_START_MONDAY]: result.calibration.semesterStartMonday,
    [SETTING_KEYS.CALIBRATED_WEEK]: String(result.calibration.currentWeek),
    [SETTING_KEYS.CALIBRATED_TODAY]: result.calibration.today,
    [SETTING_KEYS.CALIBRATED_AT]: result.calibration.setAt,
  }
  saving.value = true
  try {
    for (const key of KEYS) {
      rows.value[key] = await settingsApi.put(key, values[key], rows.value[key]?.revision ?? 0)
    }
    draft.value = ''
    message.value = '已保存。'
  } catch (err) {
    message.value = `保存失败：${err.message}（请刷新后重试）`
    await load()
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <header class="page-head">
      <div>
        <span class="page-head__eyebrow"><AppIcon name="week" :size="15" />课程</span>
        <h1>教学周</h1>
        <p class="page-head__sub">告诉 DDL Mate「这周是第几教学周」，之后会按日期自动往后推算，一个学期只需设置一次。</p>
      </div>
    </header>

    <ErrorState v-if="error" :message="error" @retry="load" />
    <LoadingState v-else-if="loading" title="正在读取…" />

    <div v-else class="split">
      <section class="card card--accent week-hero">
        <span class="muted small">{{ summary.todayLine }}</span>
        <span class="week-hero__value">
          <template v-if="summary.currentWeek !== null">第 <strong>{{ summary.currentWeek }}</strong> 教学周</template>
          <template v-else>尚未校准</template>
        </span>
        <span v-if="summary.semesterStartLine" class="muted small">{{ summary.semesterStartLine }}</span>
        <p v-if="summary.warning" class="alert alert--warn" style="margin: 12px 0 0">{{ summary.warning }}</p>
      </section>

      <section class="card">
        <h2 class="card__title" style="margin-bottom: 10px"><AppIcon name="edit" :size="18" />{{ calibration ? '重新校准' : '设置本周' }}</h2>
        <div class="row">
          <span>本周是第</span>
          <input v-model="draft" type="number" min="1" max="53" style="width: 90px" aria-label="本周教学周" />
          <span>教学周</span>
          <button type="button" class="btn btn--primary btn--sm" :disabled="!draft || saving" @click="save">保存</button>
        </div>
        <p v-if="message" class="small" :class="message === '已保存。' ? 'muted' : 'field__error'">{{ message }}</p>
        <p class="muted small" style="margin-top: 12px">
          只影响以后新填写的课表；已有课表如果自带学期起点，会继续用它自己的，不会被改动。
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.week-hero {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.week-hero__value {
  font-size: 1.8rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.week-hero__value strong {
  font-size: 3rem;
  color: var(--primary);
  font-variant-numeric: tabular-nums;
}
</style>
