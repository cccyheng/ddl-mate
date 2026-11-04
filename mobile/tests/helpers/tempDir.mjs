/**
 * 测试夹具的**安全清理**：递归删除临时目录之前，必须先证明
 * 「要删的绝对路径」确实是本次夹具在系统临时目录下创建的那个目录。
 *
 * 为什么需要它：`rmSync(dir, { recursive: true, force: true })` 一旦拿到一个算错的路径
 * （变量被覆盖、join 传错、路径为空串…），删掉的可能是别的东西。
 * 这里把「能删」的条件写死成三条，任何一条不满足就直接抛错、**绝不删**：
 *   1. `dir` 解析后的绝对路径，其父目录正好是 `tmpdir()` 解析后的绝对路径；
 *   2. 该目录名以调用方声明的**精确前缀**开头（例如 `ddl-pressure-`）；
 *   3. 绝对路径不是 `/`、盘符根或临时目录本身。
 *
 * Windows 上还有一个真实约束：SQLite 文件还开着时 `rmSync` 会 `EPERM`。
 * 因此调用方必须**先关连接**再清理（本文件的 helper 只负责路径安全，不负责关库）。
 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve, sep } from 'node:path'

/**
 * 删除一个由测试自己创建的临时目录。
 *
 * @param {string} dir 目录路径（来自 `mkdtempSync(join(tmpdir(), prefix))`）。
 * @param {string} prefix 期望的目录名前缀，例如 `ddl-pressure-`。
 */
export function removeTempDir(dir, prefix) {
  if (typeof dir !== 'string' || dir.trim().length === 0) {
    throw new Error(`拒绝清理空的临时目录路径：${JSON.stringify(dir)}`)
  }
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new Error('拒绝清理：必须给出期望的目录名前缀。')
  }
  const target = resolve(dir)
  const tempRoot = resolve(tmpdir())
  if (dirname(target) !== tempRoot) {
    throw new Error(`拒绝清理不在系统临时目录下的路径：${target}`)
  }
  if (target === tempRoot) {
    throw new Error(`拒绝清理临时目录本身：${target}`)
  }
  if (!basename(target).startsWith(prefix)) {
    throw new Error(`拒绝清理目录名不符合前缀「${prefix}」的路径：${target}`)
  }
  // 再确认一次它不是任何形式的根目录（防御性地保留这条断言）。
  if (target === sep || /^[A-Za-z]:\\?$/.test(target)) {
    throw new Error(`拒绝清理根目录：${target}`)
  }
  rmSync(target, { recursive: true, force: true })
}
