<script setup>
import { formatClock, weekdayName } from '@/utils/datetime'

defineProps({
  schedule: { type: Object, required: true },
})
</script>

<template>
  <li class="task-item">
    <div class="task-item__main">
      <div class="task-item__title">
        <span class="dot" :style="{ background: schedule.courseColor || '#65746b' }" />
        <span>{{ schedule.courseName }}</span>
        <span class="badge badge--primary">{{ schedule.weekdayLabel || weekdayName(schedule.weekday) }}</span>
      </div>
      <div class="task-item__meta">
        <span>{{ formatClock(schedule.startTime) }} – {{ formatClock(schedule.endTime) }}</span>
        <span v-if="schedule.location">{{ schedule.location }}</span>
        <span v-if="schedule.periodStart">第 {{ schedule.periodStart }}–{{ schedule.periodEnd }} 节</span>
        <span v-if="schedule.weekRange">第 {{ schedule.weekRange }} 周</span>
      </div>
    </div>
  </li>
</template>
