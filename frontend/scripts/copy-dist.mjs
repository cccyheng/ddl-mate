// 把 vite 构建产物复制到后端静态目录，实现「后端直接托管前端」的演示模式。
//
// 用法：node scripts/copy-dist.mjs
//
// 安全约束（避免参数误删）：
//   1. 目标目录**固定**为 <工作区>/backend/src/main/resources/static，
//      不接受任意命令行参数；
//   2. 清理前逐个解析绝对路径，并确认仍在目标目录内；
//   3. 只清理已知的生成产物（index.html、assets），不了解的条目一律不动。
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const frontendDir = resolve(here, '..')
const workspaceDir = resolve(frontendDir, '..')

const source = resolve(frontendDir, 'dist')
const staticDir = resolve(workspaceDir, 'backend', 'src', 'main', 'resources', 'static')

// 允许清理的生成产物（相对目标目录）：这些都会被本次构建产物完整覆盖。
// samples/ 与 tesseract/ 是 OCR 需要的静态资源（样例图 + worker/core/语言模型），
// 必须一起复制，否则生产 8080 上的照片导入会缺资源。
const GENERATED_ENTRIES = ['index.html', 'assets', 'samples', 'tesseract', 'favicon.svg']
// 保留的后端自带文件（不与前端产物同名，避免误删）
const PROTECTED_ENTRIES = new Set(['favicon.ico'])

/** 断言路径确实位于目标目录内部，否则拒绝操作。 */
function assertInside(targetDir, candidate) {
  const normalizedTarget = resolve(targetDir)
  const normalizedCandidate = resolve(candidate)
  if (normalizedCandidate !== normalizedTarget && !normalizedCandidate.startsWith(normalizedTarget + sep)) {
    throw new Error(`[copy-dist] 拒绝操作目标目录之外的路径：${normalizedCandidate}`)
  }
  return normalizedCandidate
}

if (!existsSync(source)) {
  console.error(`[copy-dist] 找不到构建产物：${source}\n请先执行 pnpm build`)
  process.exit(1)
}
if (!existsSync(staticDir)) {
  console.error(`[copy-dist] 目标目录不存在：${staticDir}`)
  process.exit(1)
}
if (workspaceDir !== resolve(frontendDir, '..')) {
  console.error('[copy-dist] 工作区解析异常，已中止')
  process.exit(1)
}

console.log(`[copy-dist] 工作区：${workspaceDir}`)
console.log(`[copy-dist] 源目录：${source}`)
console.log(`[copy-dist] 目标目录（固定）：${staticDir}`)

await mkdir(staticDir, { recursive: true })

const existing = await readdir(staticDir)
for (const entry of GENERATED_ENTRIES) {
  if (!existing.includes(entry) || PROTECTED_ENTRIES.has(entry)) continue
  const victim = assertInside(staticDir, resolve(staticDir, entry))
  console.log(`[copy-dist] 清理旧产物：${victim}`)
  await rm(victim, { recursive: true, force: true })
}

await cp(source, staticDir, { recursive: true })
console.log(`[copy-dist] 完成：${source} -> ${staticDir}`)
