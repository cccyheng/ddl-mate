/**
 * 全屏原图 / 备份大图 Modal 的 iPhone 安全区聚焦测试。
 *
 * 用户截图证明：关闭按钮落在状态栏 / 灵动岛下面。这里只锁定**真实 TSX**
 * 里的安全区上下文、控件位置和回调，不依赖设备像素猜测，也不把用户截图当夹具。
 *
 * 守的是：
 * - Modal 内重新提供 SafeAreaProvider，并用当前窗口 initialMetrics，而不是只信根节点；
 * - 顶部标题可截断，关闭按钮不会收缩，保持 44pt 触控；
 * - 底部「返回」在缩放 ScrollView 之外，并受底部安全区保护；
 * - 缺图 / 失败 / 双指缩放都能通过 onClose 关闭；缩放区域里没有控件被手势吞掉；
 * - 备份内容大图同样有独立安全区和底部返回。
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

function between(source, start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.ok(from >= 0, `找不到起点：${start}`)
  assert.ok(to > from, `找不到终点：${end}`)
  return source.slice(from, to)
}

test('ScreenshotViewer：Modal 内部重新提供当前窗口安全区，不沿用根节点旧上下文', () => {
  const viewer = read('ui/ScreenshotViewer.tsx')
  assert.match(viewer, /import \{[\s\S]{0,120}initialWindowMetrics,[\s\S]{0,120}SafeAreaProvider,[\s\S]{0,120}SafeAreaView,[\s\S]{0,120}\} from 'react-native-safe-area-context'/)
  const modal = between(viewer, '<Modal', '</Modal>')
  assert.match(modal, /<SafeAreaProvider\s+initialMetrics=\{initialWindowMetrics\}>/)
  assert.match(
    modal,
    /<SafeAreaView[\s\S]{0,160}edges=\{\['top', 'bottom', 'left', 'right'\]\}[\s\S]{0,80}testID="screenshot-viewer"/,
  )
  assert.match(viewer, /onRequestClose=\{onClose\}/, '系统返回也走同一个关闭回调')
})

test('ScreenshotViewer：标题可截断、关闭按钮不收缩且保持 44pt 触控', () => {
  const viewer = read('ui/ScreenshotViewer.tsx')
  assert.match(viewer, /<Text style=\{styles\.title\} numberOfLines=\{1\} ellipsizeMode="tail">/)
  assert.match(viewer, /style=\{styles\.headerClose\}/)
  assert.match(viewer, /headerClose: \{ flexShrink: 0, minWidth: 44, minHeight: 44 \}/)
  assert.match(viewer, /header: \{[\s\S]{0,220}flexWrap: 'nowrap'/)
})

test('ScreenshotViewer：底部返回在缩放 ScrollView 之外，footer 有底部安全区', () => {
  const viewer = read('ui/ScreenshotViewer.tsx')
  const modal = between(viewer, '<Modal', '</Modal>')
  const scroll = between(modal, '<ScrollView', '</ScrollView>')
  assert.doesNotMatch(scroll, /AppButton/, '缩放手势区域内不能放控件')
  const footer = modal.indexOf('<View style={styles.footer}>')
  const scrollEnd = modal.indexOf('</ScrollView>')
  assert.ok(footer > scrollEnd, 'footer 必须在 ScrollView 之后')
  const footerBlock = modal.slice(footer, modal.indexOf('</SafeAreaView>', footer))
  assert.match(footerBlock, /<AppButton[\s\S]{0,120}label="返回"[\s\S]{0,160}onPress=\{onClose\}/)
  assert.match(footerBlock, /accessibilityLabel="返回并关闭原图"/)
  assert.match(viewer, /footer: \{[\s\S]{0,220}paddingBottom: spacing\.md/)
})

test('ScreenshotViewer：缺图 / 加载失败 / 重新读取都有 onClose 出口，重试先关模态', () => {
  const viewer = read('ui/ScreenshotViewer.tsx')
  const retryBlock = between(viewer, 'const handleRetry', 'return (')
  assert.match(retryBlock, /onRetry\?\.\(\)/)
  assert.match(retryBlock, /onClose\(\)/)
  assert.match(viewer, /label="重新读取"[\s\S]{0,180}onPress=\{handleRetry\}/)
  const modal = between(viewer, '<Modal', '</Modal>')
  const closeButtons = [...modal.matchAll(/label="关闭"[\s\S]{0,120}onPress=\{onClose\}/g)]
  assert.ok(closeButtons.length >= 3, 'header / 缺图 / 加载失败都有关闭出口')
  assert.match(modal, /label="重新加载图片"[\s\S]{0,220}onPress=\{\(\) => \{/)
  assert.match(modal, /maximumZoomScale=\{6\}/)
})

test('BackupContentScreen 大图：独立 SafeAreaProvider + 底部返回，图片仍可缩放', () => {
  const screen = read('screens/BackupContentScreen.tsx')
  assert.match(screen, /initialWindowMetrics[\s\S]{0,80}SafeAreaProvider[\s\S]{0,80}SafeAreaView/)
  const modal = between(screen, '<Modal', '</Modal>')
  assert.match(modal, /<SafeAreaProvider\s+initialMetrics=\{initialWindowMetrics\}>/)
  assert.match(modal, /<SafeAreaView style=\{styles\.modalSafe\} edges=\{\['top', 'bottom', 'left', 'right'\]\}>/)
  const scroll = between(modal, '<ScrollView', '</ScrollView>')
  assert.doesNotMatch(scroll, /AppButton/, '大图缩放区域没有控件')
  const scrollEnd = modal.indexOf('</ScrollView>')
  const returnButton = modal.indexOf('label="返回"', scrollEnd)
  assert.ok(returnButton > scrollEnd, '底部返回在 ScrollView 之外')
  assert.match(modal, /label="返回"[\s\S]{0,160}onPress=\{\(\) => setExpanded\(null\)\}/)
  assert.match(modal, /onRequestClose=\{\(\) => setExpanded\(null\)\}/)
  assert.match(modal, /maximumZoomScale=\{4\}/)
  assert.match(screen, /modalReturn: \{ flexShrink: 0, minWidth: 88, minHeight: 44 \}/)
})
