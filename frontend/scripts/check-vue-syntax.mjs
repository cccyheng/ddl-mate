/**
 * 离线校验：用 Vue 官方编译器（@vue/compiler-sfc）解析每个 .vue 文件，
 * 只做语法/编译检查，不打包、不启动 esbuild 子进程。
 *
 * 为什么要单独写：本工作区处于受限沙箱时，vite build 需要的 esbuild 服务
 * 通过管道 stdio 启动子进程会得到 EPERM（沙箱边界），无法在本轮完成真实构建。
 * 这个脚本能覆盖"模板/脚本语法错误"这一类最容易在 UI 重构里引入的问题。
 *
 * 用法：node frontend/scripts/check-vue-syntax.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(here, '..', 'src')

const compilerPath = resolve(
  here,
  '..',
  'node_modules',
  '.pnpm',
  '@vue+compiler-sfc@3.5.13',
  'node_modules',
  '@vue',
  'compiler-sfc',
  'dist',
  'compiler-sfc.cjs.js',
)
const { parse, compileScript, compileTemplate } = (await import(`file://${compilerPath.replace(/\\/g, '/')}`))
  .default

function listVueFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listVueFiles(full))
    else if (entry.name.endsWith('.vue')) files.push(full)
  }
  return files
}

let failed = 0
const files = listVueFiles(srcDir).sort()
for (const file of files) {
  const id = relative(srcDir, file).replace(/\\/g, '/')
  try {
    const source = readFileSync(file, 'utf8')
    const { descriptor, errors } = parse(source, { filename: file })
    if (errors.length) throw new Error(errors.map((error) => error.message).join('; '))
    const hasScript = Boolean(descriptor.script || descriptor.scriptSetup)
    if (hasScript) compileScript(descriptor, { id })
    if (descriptor.template) {
      const result = compileTemplate({
        source: descriptor.template.content,
        filename: file,
        id,
        scoped: descriptor.styles.some((style) => style.scoped),
      })
      if (result.errors.length) throw new Error(result.errors.map((error) => error.message || error).join('; '))
    }
    console.log(`ok   ${id}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${id}\n     ${error.message}`)
  }
}

console.log(`\n共 ${files.length} 个 .vue 文件，失败 ${failed} 个`)
process.exit(failed ? 1 : 0)
