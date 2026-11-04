// Actual screen handlers plus the installed stack router; native layout needs phone QA.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { StackRouter, TabRouter, CommonActions, StackActions } from '@react-navigation/routers'

const require = createRequire(import.meta.url), ts = require('typescript')
const read = name => readFileSync(new URL(`../src/screens/${name}.tsx`, import.meta.url), 'utf8')
function compile(source, dependencies) {
  const code = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText
  const mod = { exports: {} }
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`)(id => {
    if (id in dependencies) return dependencies[id]
    throw Error(`Unexpected import ${id}`)
  }, mod, mod.exports)
  return mod.exports
}
function nodes(tree, predicate, result = []) {
  if (Array.isArray(tree)) tree.forEach(child => nodes(child, predicate, result))
  else if (tree?.props) {
    if (predicate(tree)) result.push(tree)
    nodes(tree.props.children, predicate, result)
  }
  return result
}
const config = { routeNames: ['CourseList', 'CourseDetail', 'PhotoLibrary', 'SourceArchive'], routeParamList: {}, routeGetIdList: {} }
function fixture({ legacyRoot = false, attempts = null, detail = false } = {}) {
  const h = { slots: [], pos: 0, popCount: 0, replaceCount: 0 }
  const router = StackRouter({ initialRouteName: legacyRoot ? 'PhotoLibrary' : 'CourseList' })
  h.state = router.getInitialState(config)
  const dispatch = action => {
    const next = router.getStateForAction(h.state, action, config)
    assert.ok(next, 'Action must be handled by course stack, never bubble to another tab')
    h.state = next
  }
  if (detail) dispatch(CommonActions.navigate('CourseDetail', { id: 42 }))
  if (!legacyRoot) dispatch(CommonActions.navigate('PhotoLibrary', { focusAttemptId: 7 }))
  const navigation = {
    getState: () => h.state,
    canGoBack: () => true, // Parent history exists even for legacy single-route state.
    goBack: () => { h.popCount++; dispatch(CommonActions.goBack()) },
    replace: name => { h.replaceCount++; dispatch(StackActions.replace(name)) },
    navigate: (name, params) => dispatch(CommonActions.navigate(name, params)),
  }
  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const p = { ...props, children }
      return typeof type === 'function' ? type(p) : { type, props: p }
    },
    useState(value) {
      const i = h.pos++
      if (!(i in h.slots)) h.slots[i] = typeof value === 'function' ? value() : value
      return [h.slots[i], value => { h.slots[i] = typeof value === 'function' ? value(h.slots[i]) : value }]
    },
    useRef(value) { const i = h.pos++; return h.slots[i] ??= { current: value } },
    useCallback: fn => fn, useMemo: fn => fn(), useEffect() {},
  }
  const store = { screenshotLibrary: { listAttempts: async () => attempts }, screenshotPathRepair: { ok: true } }
  const dependencies = {
    react: React,
    'react-native': { Image: 'Image', Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: x => x } },
    '@react-navigation/native': { useNavigation: () => navigation, useRoute: () => ({ params: { focusAttemptId: 7 } }), useFocusEffect() {} },
    '../domain/photoOcrClient': {}, '../domain/photoFiles': {},
    '../store/AppStore': { useAppStore: () => store },
    '../ui/components': Object.fromEntries(['AppButton', 'Badge', 'EmptyState', 'LoadingState', 'SectionCard'].map(x => [x, x])),
    '../ui/ScreenScaffold': { ScreenScaffold: props => React.createElement('Scaffold', props, props.headerAccessory, props.children) },
    '../ui/ScreenshotViewer': { ScreenshotViewer: 'ScreenshotViewer' },
    '../ui/theme': { colors: {}, spacing: {}, radius: {}, typography: {} },
    './photoImportController': { createInitialPhotoImportState: () => ({}), createPhotoImportOperation: () => ({ active: false }) },
  }
  const { PhotoLibraryScreen } = compile(read('PhotoLibraryScreen'), dependencies)
  h.render = () => { h.pos = 0; h.tree = PhotoLibraryScreen() }
  h.find = predicate => nodes(h.tree, predicate)[0]
  h.render(); h.slots[0] = attempts; h.render()
  h.back = () => {
    const button = h.find(n => n.props.testID === 'photo-library-back')
    assert.ok(button, 'Back remains available outside list loading/empty branches')
    assert.ok(!button.props.disabled)
    button.props.onPress()
  }
  h.dispatch = dispatch
  return h
}

for (const attempts of [null, []]) {
  test(`legacy root escapes to courses while ${attempts === null ? 'loading' : 'empty'}, ignoring parent back history`, () => {
    const h = fixture({ legacyRoot: true, attempts })
    h.back()
    assert.equal(h.popCount, 0)
    assert.equal(h.replaceCount, 1)
    assert.deepEqual(h.state.routes.map(r => r.name), ['CourseList'])
    assert.equal(h.state.index, 0)
  })
}
test('normal and repeated entry return to the preceding local route with its params intact', () => {
  const h = fixture({ attempts: [], detail: true })
  const originalKey = h.state.routes[1].key
  for (let round = 0; round < 2; round++) {
    h.back()
    assert.equal(h.state.routes[h.state.index].name, 'CourseDetail')
    assert.equal(h.state.routes[h.state.index].key, originalKey)
    assert.equal(h.state.routes[h.state.index].params.id, 42)
    if (!round) h.dispatch(CommonActions.navigate('PhotoLibrary'))
  }
  assert.equal(h.replaceCount, 0)
})
test('closing original returns to the unchanged list, which still has a working back button', () => {
  const attempt = { id: 7, capturedAt: '2026-10-29T08:00:00Z', archivedPath: 'file:///saved.jpg', status: 'ARCHIVED', source: 'LIBRARY', bytes: 100 }
  const h = fixture({ attempts: [attempt] })
  h.find(n => n.type === 'Pressable').props.onPress(); h.render()
  assert.equal(h.find(n => n.type === 'ScreenshotViewer').props.photo.id, 7)
  h.find(n => n.type === 'ScreenshotViewer').props.onClose(); h.render()
  assert.equal(h.find(n => n.type === 'ScreenshotViewer').props.photo, null)
  assert.equal(h.slots[0][0], attempt)
  h.back()
  assert.equal(h.state.routes[h.state.index].name, 'CourseList')
})
for (const name of ['NoticePhotoScreen', 'BatchNoticeScreen']) {
  test(`${name} actual cross-tab helper preserves the initial course route and doesn't remove the source draft`, () => {
    const source = read(name)
    const start = source.indexOf('function openCoursesScreen(')
    const end = source.indexOf('\nconst EMPTY_', start)
    assert.ok(start >= 0 && end > start)
    const { openCoursesScreen } = compile(`export ${source.slice(start, end)}`, {})
    const calls = []
    const tabs = TabRouter({ initialRouteName: 'Tasks' })
    const tabConfig = { routeNames: ['Tasks', 'Courses'], routeParamList: {}, routeGetIdList: {} }
    let tabState = tabs.getInitialState(tabConfig)
    const draftState = { index: 1, routes: [{ name: 'TaskList', key: 'list' }, { name: 'NoticePhoto', key: 'draft' }] }
    tabState.routes[0] = { ...tabState.routes[0], state: draftState }
    openCoursesScreen({ getParent: () => ({ navigate: (name, params) => {
      calls.push([name, params]); tabState = tabs.getStateForAction(tabState, CommonActions.navigate(name, params), tabConfig)
    } }) }, 'PhotoLibrary', { focusAttemptId: 7 })
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'Courses')
    assert.equal(calls[0][1].initial, false)
    assert.equal(calls[0][1].params.focusAttemptId, 7)
    assert.equal(tabState.routes[tabState.index].name, 'Courses')
    assert.equal(tabState.routes[0].state, draftState, 'Source stack remains mounted with same draft route key')
    tabState = tabs.getStateForAction(tabState, CommonActions.navigate('Tasks'), tabConfig)
    assert.equal(tabState.routes[tabState.index].state, draftState)
  })
}
