/**
 * 任务模板 / 重复任务 —— 接线（wiring）验证。
 *
 * 只读真实源码，锁定产品契约的关键接线，不照抄实现：
 * 1. 任务栈与今天栈都注册了三个新屏；
 * 2. 任务列表 / 任务详情 / TaskForm 的入口存在；
 * 3. 应用模板只产生草稿，必须由用户再点「创建任务」；
 * 4. 模板 / 规则读取写入只经 store，界面没有 SQL / 网络 / 后台定时任务；
 * 5. 重复任务必须先预览、再显式确认生成，且把预览指纹交给事务校验。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'src')

function read(relative) {
  return readFileSync(join(src, relative), 'utf8')
}

test('路由类型与原生栈：任务栈 / 今天栈都注册了模板列表、模板表单与重复任务', () => {
  const types = read('navigation/types.ts')
  const taskStack = types.slice(types.indexOf('TaskStackParamList'), types.indexOf('TodayStackParamList'))
  const todayStack = types.slice(types.indexOf('TodayStackParamList'), types.indexOf('CourseStackParamList'))
  for (const block of [taskStack, todayStack]) {
    assert.match(block, /TaskTemplateList: undefined/)
    assert.match(block, /TaskTemplateForm: \{ id\?: number; sourceTaskId\?: number \} \| undefined/)
    assert.match(block, /Recurrence: undefined/)
    assert.match(block, /TaskForm: \{ id\?: number; templateId\?: number \} \| undefined/)
  }

  const navigator = read('navigation/RootNavigator.tsx')
  assert.equal([...navigator.matchAll(/<TaskStack\.Screen\s+name="TaskTemplateList"/g)].length, 1)
  assert.equal([...navigator.matchAll(/<TaskStack\.Screen\s+name="TaskTemplateForm"/g)].length, 1)
  assert.equal([...navigator.matchAll(/<TaskStack\.Screen\s+name="Recurrence"/g)].length, 1)
  assert.equal([...navigator.matchAll(/<TodayStack\.Screen\s+name="TaskTemplateList"/g)].length, 1)
  assert.equal([...navigator.matchAll(/<TodayStack\.Screen\s+name="TaskTemplateForm"/g)].length, 1)
  assert.equal([...navigator.matchAll(/<TodayStack\.Screen\s+name="Recurrence"/g)].length, 1)
})

test('入口：任务列表 / 任务详情 / 今天都能到达模板；详情能把现有任务存为模板', () => {
  const taskList = read('screens/TaskListScreen.tsx')
  assert.match(taskList, /navigate\('TaskTemplateList'\)/)

  const detail = read('screens/TaskDetailScreen.tsx')
  assert.match(detail, /navigate\('TaskTemplateForm', \{ sourceTaskId: task\.id \}\)/)
  assert.match(detail, /navigate\('TaskTemplateList'\)/)

  const today = read('screens/TodayScreen.tsx')
  assert.match(today, /navigate\('TaskTemplateList'\)/)
})

test('应用模板：只读填入草稿一次；必须再点创建任务；晚到结果不覆盖别的草稿', () => {
  const form = read('screens/TaskFormScreen.tsx')
  assert.match(form, /const templateId = route\.params\?\.templateId/)
  assert.match(form, /templateHydratedFor\.current === templateId/)
  assert.match(form, /templateRequestRef\.current/)
  assert.match(form, /requestId !== templateRequestRef\.current/)
  assert.match(form, /store\.taskTemplates\.apply\(templateId\)/)
  assert.match(form, /setDraft\(result\.draft\)/)
  assert.match(form, /appliedDraftRef/)
  assert.match(form, /usePreventRemove\(dirtyTemplateDraft/)
  assert.match(form, /模板只填入可复用内容/)
  assert.match(form, /只有点「创建任务」才会真的写入本机/)
  assert.doesNotMatch(form, /taskTemplates\.generate/, '应用模板不能直接生成任务 / 重复系列')
})

test('模板列表 / 表单：只经 store 读写，没有 SQL / 网络 / 后台任务', () => {
  const list = read('screens/TaskTemplateListScreen.tsx')
  const form = read('screens/TaskTemplateFormScreen.tsx')
  assert.match(list, /store\.taskTemplates\.remove\(target\.id\)/)
  assert.match(list, /navigate\('TaskForm', \{ templateId: template\.id \}\)/)
  assert.match(form, /store\.taskTemplates\.create\(input\)/)
  assert.match(form, /store\.taskTemplates\.update\(editingId, input\)/)
  assert.match(form, /store\.taskTemplates\.saveFromTask\(sourceTaskId, input\)/)
  assert.match(form, /saved\.refreshError/)
  for (const screen of [list, form]) {
    assert.doesNotMatch(screen, /SELECT |INSERT INTO|UPDATE app_settings|new TaskTemplateRepository/)
    assert.doesNotMatch(screen, /fetch\(|axios|expo-notifications|setInterval|setTimeout\(/)
  }
})

test('重复任务：先预览、再确认生成；生成只传用户确认过的指纹；没有后台定时 / 通知任务', () => {
  const screen = read('screens/RecurrenceScreen.tsx')
  assert.match(screen, /store\.taskTemplates\.preview\(input, editingRuleId\)/)
  assert.match(screen, /setPreview\(result\)/)
  assert.match(screen, /expectedFingerprint: preview\.fingerprint/)
  assert.match(screen, /ruleId: editingRuleId/)
  assert.match(screen, /setConfirmGenerate\(true\)/)
  assert.match(screen, /按规则批量创建/)
  assert.match(screen, /先预览/)
  assert.match(screen, /应用关闭后不会自动生成任务/)
  assert.match(screen, /StalePreviewError/)
  assert.match(screen, /已删除（不会重建）/)
  assert.match(screen, /store\.taskTemplates\.removeRule/)
  assert.match(screen, /DateWheelSheet/)
  assert.match(screen, /TimeWheelField/)
  assert.match(screen, /usePreventRemove\(dirty \|\| generating/)
  assert.doesNotMatch(screen, /SELECT |INSERT INTO|setInterval|expo-notifications|fetch\(|axios/)
  assert.doesNotMatch(screen, /自动在后台|关闭后也会自动创建/)
})

test('重复任务：零可创建时仍可只保存规则，文案说明创建 0 条且不改已有任务', () => {
  const screen = read('screens/RecurrenceScreen.tsx')
  assert.match(screen, /只保存规则（创建 0 条任务）/)
  assert.match(screen, /editingRuleId !== null && !preview\.blockedReason/)
  assert.match(screen, /confirmingSaveOnly/)
  assert.match(screen, /这次不会创建任何任务，只保存规则/)
  assert.match(screen, /已有任务逐条保持不变/)
  assert.match(screen, /已删除的日期不会因为保存规则而重建/)
  // 旧的错误文案：created 不含 deleted，却说“其中 deleted 条已删除”。
  assert.doesNotMatch(screen, /其中 \$\{deleted\} 条已被删除/)
  assert.doesNotMatch(screen, /账本：已创建/)
  assert.doesNotMatch(screen, /按账本跳过/)
})

test('同步提交闸门：模板表单 / 任务表单 / 重复任务生成都使用立即 ref guard', () => {
  const templateForm = read('screens/TaskTemplateFormScreen.tsx')
  const taskForm = read('screens/TaskFormScreen.tsx')
  const recurrence = read('screens/RecurrenceScreen.tsx')
  assert.match(templateForm, /createImmediateSubmissionGuard/)
  assert.match(templateForm, /submitGuardRef\.current\.tryEnter\(\)/)
  assert.match(templateForm, /submitGuardRef\.current\.release\(\)/)
  assert.match(taskForm, /createImmediateSubmissionGuard/)
  assert.match(taskForm, /submitGuardRef\.current\.tryEnter\(\)/)
  assert.match(taskForm, /submitGuardRef\.current\.release\(\)/)
  assert.match(recurrence, /createImmediateSubmissionGuard/)
  assert.match(recurrence, /generateGuardRef\.current\.tryEnter\(\)/)
  assert.match(recurrence, /generateGuardRef\.current\.release\(\)/)
})

test('模板删除 / 规则删除都先确认，并说明不会删除已创建任务', () => {
  const list = read('screens/TaskTemplateListScreen.tsx')
  assert.match(list, /title="删除这个模板？"/)
  assert.match(list, /已经用这个模板创建过的任务不会被删除/)

  const recurrence = read('screens/RecurrenceScreen.tsx')
  assert.match(recurrence, /title="删除这条重复规则？"/)
  assert.match(recurrence, /已经创建的任务不会被删除/)
})
