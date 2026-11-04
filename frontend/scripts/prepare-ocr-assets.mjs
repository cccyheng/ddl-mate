// 把 Tesseract.js 的 worker / core(wasm) / 中文+英文语言模型复制到 public/tesseract/，
// 这样生产构建后由后端 8080 同源提供，运行期不依赖任何 CDN，用户图片也不离开浏览器。
//
// 资源来源（全部是官方 npm 包，构建阶段复制，不安装全局）：
//   - tesseract.js               → dist/worker.min.js          (Apache-2.0)
//   - tesseract.js-core          → tesseract-core*.js/.wasm    (Apache-2.0)
//   - @tesseract.js-data/chi_sim → chi_sim.traineddata.gz      (Apache-2.0, tessdata)
//   - @tesseract.js-data/eng     → eng.traineddata.gz          (Apache-2.0, tessdata)
//
// 关键点：pnpm 的 node_modules 是隔离布局，tesseract.js-core 不一定有顶层软链，
// 因此用 createRequire(require.resolve('tesseract.js')) 从 tesseract.js 自己的位置解析依赖，
// 而不是靠扫描目录猜路径。语言模型目录里同时存在 4.0.0 与 4.0.0_best_int 时，
// 明确优先选择 *_best_int（LSTM 版本），不依赖目录枚举顺序。
//
// 用法：node scripts/prepare-ocr-assets.mjs
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const frontendDir = resolve(here, '..')
const target = join(frontendDir, 'public', 'tesseract')
const LANGS = ['chi_sim', 'eng']

const require = createRequire(import.meta.url)

function fail(message) {
  console.error(`\n[ocr-assets] ${message}\n`)
  console.error('请先安装依赖（在 frontend 目录）：')
  console.error('  pnpm install')
  console.error('安装完成后重新执行：')
  console.error('  pnpm build          # 会自动执行本脚本')
  console.error('  pnpm prepare-ocr    # 只准备 OCR 资源')
  process.exit(1)
}

function resolvePackageDir(specifier, fromEntry) {
  const resolver = fromEntry ? createRequire(fromEntry) : require
  const packageJson = resolver.resolve(`${specifier}/package.json`)
  return dirname(packageJson)
}

/** 在目录里递归找指定文件名（限制深度，避免深入无关目录）。 */
async function findFile(root, fileName, depth = 4) {
  const hits = []
  async function walk(dir, level) {
    if (level > depth) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, level + 1)
      else if (entry.name === fileName) hits.push(full)
    }
  }
  await walk(root, 0)
  return hits
}

/**
 * 语言模型目录里可能有多个版本（如 4.0.0、4.0.0_best_int）。
 * 确定性排序：*_best_int 优先，其次版本号大的优先。
 */
async function pickLanguageFile(packageDir, lang) {
  const fileName = `${lang}.traineddata.gz`
  const direct = join(packageDir, fileName)
  if (existsSync(direct)) return direct

  const entries = await readdir(packageDir, { withFileTypes: true })
  const versionDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => {
      const score = (name) => (name.includes('best_int') ? 1000 : 0) + (Number.parseFloat(name) || 0)
      return score(b) - score(a)
    })

  for (const versionDir of versionDirs) {
    const candidate = join(packageDir, versionDir, fileName)
    if (existsSync(candidate)) return candidate
  }
  const found = await findFile(packageDir, fileName)
  return found[0] || null
}

// --------------------------------------------------------------------- 解析依赖目录
let tesseractDir
try {
  tesseractDir = resolvePackageDir('tesseract.js')
} catch (error) {
  fail(`无法解析 tesseract.js：${error.message}`)
}

const tesseractEntry = require.resolve('tesseract.js')
let coreDir
try {
  coreDir = resolvePackageDir('tesseract.js-core', tesseractEntry)
} catch {
  try {
    coreDir = resolvePackageDir('tesseract.js-core')
  } catch (error) {
    fail(`无法解析 tesseract.js-core：${error.message}`)
  }
}

const langDirs = {}
for (const lang of LANGS) {
  try {
    langDirs[lang] = resolvePackageDir(`@tesseract.js-data/${lang}`)
  } catch (error) {
    fail(`无法解析 @tesseract.js-data/${lang}：${error.message}（请确认已安装该依赖）`)
  }
}

// --------------------------------------------------------------------- 复制
await rm(target, { recursive: true, force: true })
await mkdir(join(target, 'core'), { recursive: true })
await mkdir(join(target, 'lang'), { recursive: true })

const workerSource = join(tesseractDir, 'dist', 'worker.min.js')
if (!existsSync(workerSource)) fail(`找不到 ${workerSource}`)
await copyFile(workerSource, join(target, 'worker.min.js'))
const workerSize = (await stat(join(target, 'worker.min.js'))).size

const coreEntries = (await readdir(coreDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /^tesseract-core.*\.(js|wasm)$/.test(entry.name))
  .map((entry) => entry.name)
if (!coreEntries.length) fail(`在 ${coreDir} 里找不到 tesseract-core*.js/.wasm`)
let coreBytes = 0
for (const name of coreEntries) {
  const destination = join(target, 'core', name)
  await copyFile(join(coreDir, name), destination)
  coreBytes += (await stat(destination)).size
}

const copiedLangs = []
for (const lang of LANGS) {
  const source = await pickLanguageFile(langDirs[lang], lang)
  if (!source) fail(`在 ${langDirs[lang]} 里找不到 ${lang}.traineddata.gz`)
  const destination = join(target, 'lang', `${lang}.traineddata.gz`)
  await copyFile(source, destination)
  copiedLangs.push({
    lang,
    source: source.replace(frontendDir, '.'),
    bytes: (await stat(destination)).size,
  })
}

await writeFile(
  join(target, 'README.txt'),
  [
    'These files are copied from official npm packages at build time by scripts/prepare-ocr-assets.mjs.',
    'Do not edit by hand. Sources and licenses:',
    `  tesseract.js               (Apache-2.0) -> worker.min.js   [${tesseractDir.replace(frontendDir, '.')}]`,
    `  tesseract.js-core          (Apache-2.0) -> core/           [${coreDir.replace(frontendDir, '.')}]`,
    ...copiedLangs.map(
      (item) =>
        `  @tesseract.js-data/${item.lang} (Apache-2.0, tessdata) -> lang/${item.lang}.traineddata.gz [${item.source}]`,
    ),
    '',
  ].join('\n'),
  'utf8',
)

console.log('[ocr-assets] 已准备到 frontend/public/tesseract：')
console.log(`  worker.min.js  ${(workerSize / 1024).toFixed(1)} KB  ← ${tesseractDir.replace(frontendDir, '.')}`)
console.log(
  `  core/          ${coreEntries.length} 个文件，${(coreBytes / 1024 / 1024).toFixed(1)} MB  ← ${coreDir.replace(frontendDir, '.')}`,
)
for (const item of copiedLangs) {
  console.log(`  lang/${item.lang}.traineddata.gz  ${(item.bytes / 1024 / 1024).toFixed(1)} MB  ← ${item.source}`)
}
