/**
 * Node 端测试用的模块解析钩子。
 *
 * 背景：源码里用的是**无扩展名相对导入**（`./datetime`），这是 Metro/TypeScript
 * `moduleResolution: bundler` 的写法、也是 React Native 工程的标准写法，
 * 但 Node 的原生 ESM 解析要求显式扩展名，直接 `import '../src/domain/datetime'` 会失败。
 *
 * 解决方式：用 Node 24 的 `module.registerHooks()`（**主线程同步钩子**），
 * 只在解析失败时补一个 `.ts` / `.tsx` 再试一次。
 * 刻意不用 `module.register()`：那个走 worker 线程，在本机沙箱里会因为
 * 拿不到命名管道而 `spawn EPERM`。
 *
 * 这只影响测试运行方式，**不修改任何源码导入写法**。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CANDIDATE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.tsx']

export function resolve(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context)
  } catch (cause) {
    // 只处理相对/绝对路径，裸包名（node:sqlite、expo-sqlite 等）交给默认解析。
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:')) {
      throw cause
    }
    for (const extension of CANDIDATE_EXTENSIONS) {
      const attempt = `${specifier}${extension}`
      try {
        return nextResolve(attempt, context)
      } catch {
        // 试下一个候选
      }
    }
    // 源码里给的是目录（例如 `../db`）时，尝试它的 index 文件。
    if (specifier.startsWith('.')) {
      const base = new URL(specifier, context.parentURL)
      if (existsSync(fileURLToPath(base))) {
        for (const extension of CANDIDATE_EXTENSIONS) {
          try {
            return nextResolve(`${specifier}${extension}`, context)
          } catch {
            // 试下一个候选
          }
        }
      }
    }
    throw cause
  }
}
