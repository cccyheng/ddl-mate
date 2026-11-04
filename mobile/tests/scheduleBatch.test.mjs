// 多天课表批量保存的仓库测试（跑在**真实内存 SQLite** 上）。
//
// 这里要证明的四件事，都是「不破坏用户数据」的硬约束：
// 1. 同一天一条：一次保存几天就写几条，各自的时间与地点互相独立；
// 2. **单事务原子性**：一批里任何一条写入失败，整批回滚，不留半套课表；
// 3. 不覆盖：已经存在的其它天课表不会被静默改写，冲突要显式报错；
// 4. 旧字段保留：界面上移除的 period_start / period_end 在编辑时原样写回。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createTestDatabase,
  courseDraft,
  failingRunDatabase,
  scheduleDraft,
} from './helpers/sqliteHarness.mjs'

/** 捕获一次拒绝并返回错误对象（校验失败的具体原因在 `error.fields` 里）。 */
async function captureRejection(action) {
  try {
    await action()
  } catch (cause) {
    return cause
  }
  throw new Error('预期这次调用会失败，但它成功了。')
}

test('批量新建：几天就是几条独立记录，时间与地点互不干扰', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    const created = await ctx.courses.applyScheduleBatch(course.id, {
      creates: [
        scheduleDraft({ weekday: 1, startTime: '08:00', endTime: '09:40', location: '教二 101' }),
        scheduleDraft({ weekday: 3, startTime: '10:00', endTime: '11:40', location: '教三 305' }),
        scheduleDraft({ weekday: 5, startTime: '14:00', endTime: '15:40', location: '实验楼 2-3' }),
      ],
    })

    assert.equal(created.schedules.length, 3)
    assert.equal(created.committed, true)
    assert.equal(created.readbackError, null)
    const rows = await ctx.courses.listSchedulesByCourse(course.id)
    assert.deepEqual(
      rows.map((row) => [row.weekday, row.startTime, row.location]),
      [
        [1, '08:00', '教二 101'],
        [3, '10:00', '教三 305'],
        [5, '14:00', '实验楼 2-3'],
      ],
      '每天一条，按星期升序读回',
    )
  } finally {
    ctx.close()
  }
})

test('批量新建是单事务：中途写入失败时整批回滚', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    // 第 2 次写入（第 2 条 INSERT）失败，第 1 条必须一起回滚。
    const flaky = failingRunDatabase(ctx.db, (count) => count === 2)
    const { CourseRepository } = await import('../src/domain/courseRepository.ts')
    const repo = new CourseRepository(flaky, () => new Date('2026-10-08T04:00:00.000Z'))

    await assert.rejects(
      () =>
        repo.applyScheduleBatch(course.id, {
          creates: [
            scheduleDraft({ weekday: 1 }),
            scheduleDraft({ weekday: 2 }),
            scheduleDraft({ weekday: 3 }),
          ],
        }),
      /测试注入的写入失败/,
    )

    assert.equal(await ctx.courses.countSchedules(), 0, '一条都不能留下（整批回滚）')
  } finally {
    ctx.close()
  }
})

test('批量保存：某一天校验失败时什么都写不进去', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    const error = await captureRejection(() =>
      ctx.courses.applyScheduleBatch(course.id, {
        creates: [
          scheduleDraft({ weekday: 1 }),
          scheduleDraft({ weekday: 2, startTime: '10:00', endTime: '09:00' }),
        ],
      }),
    )
    assert.match(error.fields.endTime, /结束时间必须晚于开始时间/)
    assert.equal(await ctx.courses.countSchedules(), 0, '校验失败整批不写')
  } finally {
    ctx.close()
  }
})

test('批量保存：同一天的另一段时间是合法第二段课，两条都要留下', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    const existing = await ctx.courses.createSchedule(
      course.id,
      scheduleDraft({ weekday: 3, startTime: '10:00', endTime: '11:40', location: '原来的教室' }),
    )

    const written = await ctx.courses.applyScheduleBatch(course.id, {
      creates: [scheduleDraft({ weekday: 3, startTime: '18:00', endTime: '19:40', location: '新教室' })],
    })

    assert.equal(written.committed, true)
    assert.equal(written.readbackError, null)
    assert.equal(written.schedules.length, 1)
    const rows = await ctx.courses.listSchedulesByCourse(course.id)
    assert.equal(rows.length, 2, '同一天允许存在两段不同的课')
    const original = rows.find((row) => row.id === existing.id)
    assert.equal(original.startTime, '10:00', '原来那一条完全没被改动')
    assert.equal(original.location, '原来的教室')
    const added = rows.find((row) => row.id !== existing.id)
    assert.equal(added.weekday, 3)
    assert.equal(added.startTime, '18:00')
    assert.equal(added.location, '新教室')
  } finally {
    ctx.close()
  }
})

test('批量保存：同一天同一时段、但单双周不同 → 两条都保留（不是重复）', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    await ctx.courses.applyScheduleBatch(course.id, {
      creates: [scheduleDraft({ weekday: 7, weekPattern: 'ODD' })],
    })
    await ctx.courses.applyScheduleBatch(course.id, {
      creates: [scheduleDraft({ weekday: 7, weekPattern: 'EVEN' })],
    })
    const rows = await ctx.courses.listSchedulesByCourse(course.id)
    assert.equal(rows.length, 2, '单周与双周各一条必须并存')
    assert.deepEqual(
      rows.map((row) => row.weekPattern).sort(),
      ['EVEN', 'ODD'],
    )
  } finally {
    ctx.close()
  }
})

test('批量保存：同一天同一时段、但教学周范围不同 → 两条都保留（不是重复）', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    await ctx.courses.applyScheduleBatch(course.id, {
      creates: [scheduleDraft({ weekday: 7, startWeek: '1', endWeek: '8' })],
    })
    await ctx.courses.applyScheduleBatch(course.id, {
      creates: [scheduleDraft({ weekday: 7, startWeek: '9', endWeek: '16' })],
    })
    const rows = await ctx.courses.listSchedulesByCourse(course.id)
    assert.equal(rows.length, 2, '第 1–8 周与第 9–16 周必须并存')
  } finally {
    ctx.close()
  }
})

test('批量保存：起止周与单双周原样落库，编辑后的新范围也保留，并真实过滤日历', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    const created = await ctx.courses.applyScheduleBatch(course.id, {
      creates: [
        scheduleDraft({
          weekday: 4,
          startWeek: '9',
          endWeek: '16',
          weekPattern: 'ODD',
        }),
      ],
    })
    assert.equal(created.committed, true)
    assert.equal(created.readbackError, null)
    const first = created.schedules[0]
    assert.deepEqual(
      [first.startWeek, first.endWeek, first.weekRange, first.weekPattern],
      [9, 16, '9-16', 'ODD'],
      '新建时用户选的第 9–16 周 + 单周必须原样写进库',
    )

    const updated = await ctx.courses.applyScheduleBatch(course.id, {
      updates: [
        {
          scheduleId: first.id,
          draft: scheduleDraft({
            weekday: 4,
            startWeek: '2',
            endWeek: '12',
            weekPattern: 'EVEN',
          }),
        },
      ],
    })
    assert.equal(updated.committed, true)
    assert.equal(updated.readbackError, null)
    const saved = await ctx.courses.getSchedule(first.id)
    assert.deepEqual(
      [saved.startWeek, saved.endWeek, saved.weekRange, saved.weekPattern],
      [2, 12, '2-12', 'EVEN'],
      '编辑后的第 2–12 周 + 双周不能被旧范围或 ALL 覆盖',
    )

    // 日历展开走既有的 occursOn / listMeetingsInRange：范围外与单双周不匹配的日期都不能出现。
    const { listMeetingsInRange } = await import('../src/domain/calendar.ts')
    const meetings = listMeetingsInRange([saved], [course], '2026-09-07', '2026-11-30')
    assert.deepEqual(
      meetings.map((meeting) => meeting.dateKey),
      ['2026-09-17', '2026-10-01', '2026-10-15', '2026-10-29', '2026-11-12', '2026-11-26'],
      '第 2、4、6、8、10、12 周的周四；第 1 周与第 13 周以后都不在范围里',
    )
  } finally {
    ctx.close()
  }
})

test('批量保存：同一天同一时段、但学期起点不同 → 两条都保留（不是重复）', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    await ctx.courses.applyScheduleBatch(course.id, {
      creates: [scheduleDraft({ weekday: 2, semesterStartDate: '2026-09-07' })],
    })
    await ctx.courses.applyScheduleBatch(course.id, {
      creates: [scheduleDraft({ weekday: 2, semesterStartDate: '2027-02-22' })],
    })
    const rows = await ctx.courses.listSchedulesByCourse(course.id)
    assert.equal(rows.length, 2, '不同学期的同一时段必须并存')
  } finally {
    ctx.close()
  }
})

test('批量保存：真正完全相同的一条（同天同时段同周次范围）才被拒绝，绝不覆盖', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    const existing = await ctx.courses.createSchedule(
      course.id,
      scheduleDraft({ weekday: 3, startTime: '10:00', endTime: '11:40', location: '原来的教室' }),
    )

    const error = await captureRejection(() =>
      ctx.courses.applyScheduleBatch(course.id, {
        creates: [scheduleDraft({ weekday: 3, startTime: '10:00', endTime: '11:40', location: '新教室' })],
      }),
    )
    assert.match(error.fields['weekday:3'], /完全相同的课表/)

    const rows = await ctx.courses.listSchedulesByCourse(course.id)
    assert.equal(rows.length, 1, '不能插入完全重复的一条')
    assert.equal(rows[0].id, existing.id)
    assert.equal(rows[0].location, '原来的教室', '原记录完全没被改动')
  } finally {
    ctx.close()
  }
})

test('批量保存：同一批里「同天同时段同周次范围」出现两次会被拒绝，不同时段则允许', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    const conflict = await captureRejection(() =>
      ctx.courses.applyScheduleBatch(course.id, {
        creates: [scheduleDraft({ weekday: 4 }), scheduleDraft({ weekday: 4 })],
      }),
    )
    assert.match(conflict.fields['weekday:4'], /出现了两次/)
    assert.equal(await ctx.courses.countSchedules(), 0)

    // 同一天两段不同的时间 → 合法，同一批里也能一次写入。
    const written = await ctx.courses.applyScheduleBatch(course.id, {
      creates: [
        scheduleDraft({ weekday: 4, startTime: '08:00', endTime: '09:40' }),
        scheduleDraft({ weekday: 4, startTime: '14:00', endTime: '15:40' }),
      ],
    })
    assert.equal(written.schedules.length, 2)
    assert.equal(await ctx.courses.countSchedules(), 2)
  } finally {
    ctx.close()
  }
})

test('回归：编辑同一天的第一段时，第二段必须原样保留', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    const first = await ctx.courses.createSchedule(
      course.id,
      scheduleDraft({ weekday: 7, startTime: '08:00', endTime: '09:35', location: '百川楼-103' }),
    )
    const second = await ctx.courses.createSchedule(
      course.id,
      scheduleDraft({ weekday: 7, startTime: '10:00', endTime: '11:35', location: '百川楼-103' }),
    )
    assert.equal(await ctx.courses.countSchedules(), 2)

    const outcome = await ctx.courses.applyScheduleBatch(course.id, {
      updates: [
        {
          scheduleId: first.id,
          draft: scheduleDraft({ weekday: 7, startTime: '08:00', endTime: '09:35', location: '改过的教室' }),
        },
      ],
    })
    assert.equal(outcome.readbackError, null)
    assert.equal(outcome.schedules.length, 1)
    assert.equal(outcome.schedules[0].id, first.id)

    const rows = await ctx.courses.listSchedulesByCourse(course.id)
    assert.equal(rows.length, 2, '编辑第一段不能吃掉第二段')
    assert.equal(rows.find((row) => row.id === first.id).location, '改过的教室')
    const untouched = rows.find((row) => row.id === second.id)
    assert.equal(untouched.startTime, '10:00')
    assert.equal(untouched.endTime, '11:35')
    assert.equal(untouched.location, '百川楼-103')
  } finally {
    ctx.close()
  }
})

test('提交后读回失败：committed 仍为 true 且带 readbackError，数据已经落库（不能再重试保存）', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    let committed = false
    const flaky = {
      ...ctx.db,
      async execAsync(sql) {
        await ctx.db.execAsync(sql)
        if (/^COMMIT/i.test(String(sql).trim())) committed = true
      },
      async getAllAsync(sql, params) {
        if (committed && /FROM schedules/i.test(sql)) throw new Error('测试注入的读回失败')
        return ctx.db.getAllAsync(sql, params)
      },
    }
    const { CourseRepository } = await import('../src/domain/courseRepository.ts')
    const repo = new CourseRepository(flaky, () => new Date('2026-10-08T04:00:00.000Z'))

    const outcome = await repo.applyScheduleBatch(course.id, {
      creates: [scheduleDraft({ weekday: 1 }), scheduleDraft({ weekday: 2 })],
    })

    assert.equal(outcome.committed, true, '事务已经提交')
    assert.ok(outcome.readbackError, '读回失败必须被报告')
    assert.deepEqual(outcome.schedules, [], '读不回来时返回空数组，而不是假装成功')
    assert.equal(await ctx.courses.countSchedules(), 2, '数据确实已经写进去了')
  } finally {
    ctx.close()
  }
})

test('编辑既有课表：只更新原记录 + 新增勾选的天，其它天的记录原样保留', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    const original = await ctx.courses.createSchedule(
      course.id,
      scheduleDraft({ weekday: 3, startTime: '10:00', endTime: '11:40', location: '教三 305' }),
    )
    const unrelated = await ctx.courses.createSchedule(
      course.id,
      scheduleDraft({ weekday: 5, startTime: '14:00', endTime: '15:40', location: '实验楼 2-3' }),
    )

    const written = await ctx.courses.applyScheduleBatch(course.id, {
      updates: [{ scheduleId: original.id, draft: scheduleDraft({ weekday: 3, startTime: '10:00', endTime: '12:20', location: '教三 401' }) }],
      creates: [scheduleDraft({ weekday: 1, startTime: '08:00', endTime: '09:40', location: '教二 101' })],
    })

    assert.equal(written.schedules.length, 2, '只返回本次真正写入的两条')
    assert.deepEqual(
      written.schedules.map((row) => row.weekday).sort((left, right) => left - right),
      [1, 3],
    )
    assert.ok(
      written.schedules.some((row) => row.id === original.id),
      '原记录是被更新的那一条',
    )
    assert.ok(
      !written.schedules.some((row) => row.id === unrelated.id),
      '无关的那一天不在本次写入结果里',
    )

    const rows = await ctx.courses.listSchedulesByCourse(course.id)
    assert.equal(rows.length, 3, '新增一天，不是替换整门课的课表')
    const updated = rows.find((row) => row.id === original.id)
    assert.equal(updated.endTime, '12:20')
    assert.equal(updated.location, '教三 401')

    const untouched = rows.find((row) => row.id === unrelated.id)
    assert.deepEqual(
      [untouched.weekday, untouched.startTime, untouched.endTime, untouched.location],
      [5, '14:00', '15:40', '实验楼 2-3'],
      '无关的那一天一个字都不能变',
    )
  } finally {
    ctx.close()
  }
})

test('编辑既有课表：界面上已移除的节次字段会被原样保留', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    const original = await ctx.courses.createSchedule(
      course.id,
      scheduleDraft({ weekday: 2, periodStart: '3', periodEnd: '4' }),
    )
    assert.equal(original.periodStart, 3)
    assert.equal(original.periodEnd, 4)

    // 模拟表单：从既有行生成多天草稿（节次随草稿带回），只改时间后保存。
    const { multidayDraftFromSchedule, updateActiveEntry, scheduleDraftForWeekday } = await import(
      '../src/domain/scheduleMultidayDraft.ts'
    )
    const draft = updateActiveEntry(multidayDraftFromSchedule(original), { startTime: '09:00', endTime: '10:40' })

    await ctx.courses.applyScheduleBatch(course.id, {
      updates: [{ scheduleId: original.id, draft: scheduleDraftForWeekday(draft, 2) }],
    })

    const saved = await ctx.courses.getSchedule(original.id)
    assert.equal(saved.startTime, '09:00', '时间按新草稿更新')
    assert.equal(saved.periodStart, 3, '节次输入框移除后旧数据仍在')
    assert.equal(saved.periodEnd, 4)
  } finally {
    ctx.close()
  }
})

test('批量保存：更新目标不属于这门课程时拒绝，且不写入任何东西', async () => {
  const ctx = await createTestDatabase()
  try {
    const courseA = await ctx.courses.create(courseDraft({ code: 'CS101', name: '甲课' }))
    const courseB = await ctx.courses.create(courseDraft({ code: 'CS102', name: '乙课' }))
    const foreign = await ctx.courses.createSchedule(courseB.id, scheduleDraft({ weekday: 3 }))

    const error = await captureRejection(() =>
      ctx.courses.applyScheduleBatch(courseA.id, {
        updates: [{ scheduleId: foreign.id, draft: scheduleDraft({ weekday: 3, location: '不该写进去' }) }],
        creates: [scheduleDraft({ weekday: 1 })],
      }),
    )
    assert.match(error.message, /不属于这门课程/)

    assert.equal(await ctx.courses.countSchedules(), 1, '新增的那一天也不能落库')
    const stillForeign = await ctx.courses.getSchedule(foreign.id)
    assert.equal(stillForeign.courseId, courseB.id)
    assert.equal(stillForeign.location, '教三 305', '别的课程的课表不能被改')
  } finally {
    ctx.close()
  }
})

test('批量保存：空计划被拒绝（不会悄悄什么都不做）', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    const error = await captureRejection(() => ctx.courses.applyScheduleBatch(course.id, {}))
    assert.match(error.fields.weekdays, /至少选择一天/)
  } finally {
    ctx.close()
  }
})
