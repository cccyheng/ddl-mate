/**
 * 新版本提示：网页打开着时不会自己换成新代码，服务器更新后要刷新才生效。
 * 每 5 分钟、以及切回这个标签页时，取一次首页 HTML，比较入口脚本的文件名（带内容哈希）；
 * 和当前页面用的不一样，就说明服务器上已经是新版本。
 */
import { ref } from 'vue'

export const updateAvailable = ref(false)

const ENTRY = /\/assets\/index-[A-Za-z0-9_-]+\.js/

function currentEntry() {
  const script = [...document.querySelectorAll('script[type="module"][src]')].find((s) => ENTRY.test(s.src))
  return script ? ENTRY.exec(script.src)[0] : null
}

export async function checkForUpdate() {
  const mine = currentEntry()
  if (!mine || updateAvailable.value) return // 开发环境没有打包入口，不检查
  try {
    const html = await fetch('/', { cache: 'no-store', credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : ''))
    const latest = ENTRY.exec(html)?.[0]
    if (latest && latest !== mine) updateAvailable.value = true
  } catch {
    /* 离线或服务器重启中，下次再查 */
  }
}

let started = false
export function startUpdateCheck() {
  if (started || typeof window === 'undefined') return
  started = true
  window.setInterval(checkForUpdate, 5 * 60 * 1000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate()
  })
}
