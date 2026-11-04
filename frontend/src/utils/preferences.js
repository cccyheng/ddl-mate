/**
 * 本机界面偏好（侧栏折叠、主题、上次筛选等）。
 *
 * 只放"丢了也无所谓"的小偏好：隐私窗口或禁用存储时读写会抛错，这里一律吞掉并回退默认值。
 * 业务数据绝不放这里，统一走后端。
 */
const PREFIX = 'ddlmate.web.'

export function readPreference(key) {
  try {
    return window.localStorage.getItem(PREFIX + key)
  } catch {
    return null
  }
}

export function writePreference(key, value) {
  try {
    window.localStorage.setItem(PREFIX + key, value)
  } catch {
    // 存不下就算了：下次打开回到默认值
  }
}
