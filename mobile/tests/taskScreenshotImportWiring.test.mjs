/**
 * 接线验证：任务直接截图 / 只导入截图 / 旧路径修复。
 *
 * 只读真实源码文本，检查用户可见入口和不可越界的写入路径；具体行为由
 * `taskScreenshotDirect` / `screenshotBackupImport` / `screenshotPathRecovery`
 * 的真实文件 + 真实 SQLite 测试覆盖。
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

test('任务原图页有从相册 / 相机直接添加的明确入口，且复用 store.archiveOriginal', () => {
  const screen = read('screens/TaskPhotosScreen.tsx')
  assert.match(screen, /title="直接放一张截图"/)
  assert.match(screen, /从相册添加截图/)
  assert.match(screen, /拍照添加截图/)
  assert.match(screen, /archiveOriginal: \(uri, source, attemptSource\)/)
  assert.match(screen, /storeRef\.current\.archiveOriginal/)
  assert.match(screen, /storeRef\.current\.backup\.gate === 'idle'/)
  assert.match(screen, /storeRef\.current\.restoreEpoch/)
  assert.match(screen, /选择照片或拍照，保存到这条任务，也能在截图库中查看。/)
  assert.match(screen, /不会识别，也不会上传。/)
})

test('store.archiveOriginal 走公共串行队列 + 备份闸门，不另开文件写入队列', () => {
  const store = read('store/AppStore.tsx')
  const start = store.indexOf('archiveOriginal: async (uri, source, attemptSource)')
  const block = store.slice(start, start + 2800)
  assert.ok(start >= 0)
  assert.match(block, /await enqueue\(/)
  assert.match(block, /refreshAfter: false/)
  assert.match(block, /current\.screenshots\.recordAttempt/)
  assert.doesNotMatch(block, /importQueue|new ScreenshotLibraryRepository/, '复用公共队列 / 现有仓库')
})

test('备份预览页有「只导入截图」入口，明确不恢复任务 / 课程；空备份明确说明', () => {
  const screen = read('screens/BackupScreen.tsx')
  assert.match(screen, /label="只导入截图"/)
  assert.match(screen, /backup\.importImagesFromPreview\(/)
  assert.match(screen, /preview\.counts\.images > 0/)
  assert.match(screen, /不会恢复或替换|都不会被恢复或替换/)
  assert.match(screen, /这份备份里没有截图，无法只导入截图/)
  assert.match(screen, /重复导入不会多出新的图片/)
  assert.match(screen, /busyRef\.current !== 'importImages'/, '导入进行中不能删掉它正在读的预览暂存目录')
})

test('备份内容页也能只导入截图，不冒充恢复', () => {
  const screen = read('screens/BackupContentScreen.tsx')
  assert.match(screen, /label="只导入截图"/)
  assert.match(screen, /backup\.importImagesFromContentView\(view\)/)
  assert.match(screen, /不会恢复或替换任务、课程、课表、设置/)
  assert.match(screen, /这份备份里没有截图，无法只导入截图/)
})

test('只导入截图模块只写截图库：不 DELETE 任务 / 课程 / 课表 / 设置，不复制旧 refs', () => {
  const module = read('domain/screenshotBackupImport.ts')
  assert.doesNotMatch(module, /DELETE FROM (tasks|courses|schedules|app_settings|screenshot_refs)/)
  assert.doesNotMatch(module, /INSERT INTO (tasks|courses|schedules|app_settings|screenshot_refs)/)
  assert.match(module, /listAttemptsBySha256/)
  assert.match(module, /rebaseArchivedPath/)
  assert.match(module, /for \(const attempt of existing\)/, '同一 SHA 的每条旧记录都要检查')
  assert.match(module, /pathHasMatchingBytes/)
  assert.match(module, /appOwnedScreenshotRelativePath/, '只读当前应用目录里的内容寻址文件')
})

test('截图库显示找不到原图的记录，并给出路径修复 / 只导入截图两个显式恢复入口', () => {
  const screen = read('screens/PhotoLibraryScreen.tsx')
  assert.match(screen, /找不到原图/)
  assert.match(screen, /检查并修复旧图片路径/)
  assert.match(screen, /从备份文件只导入截图/)
  assert.match(screen, /navigation\.navigate\('Backup'\)/)
  assert.match(screen, /原图还在列表里，没有删除/)
  assert.match(screen, /onError=\{\(\) => markMissing\(attempt\.id\)\}/)
  assert.doesNotMatch(screen, /filter\(\(attempt\) => !attempt\.archivedPath\)/, '不静默过滤缺失记录')
})

test('启动与手动修复共用同一份只改路径的域逻辑，并有共享闸门', () => {
  const store = read('store/AppStore.tsx')
  assert.match(store, /repairScreenshotPathsDomain/)
  assert.match(store, /repos\.screenshots\.rebaseArchivedPath/)
  assert.match(store, /beginBackup\('repairing'\)/)
  assert.match(store, /beginBackup\('importing'\)/)
  assert.match(store, /screenshotPathRepair/)
  assert.match(store, /listAttempts\(1000\)/)
})
