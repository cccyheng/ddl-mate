import { ref, shallowRef } from 'vue'
import { ApiError, settingsApi } from '@/api'

/**
 * 读写一项键值设置（格式与手机端相同）。
 *
 * - `decode(raw)`：把库里的字符串（从未写过时是 `null`）解码成页面要用的数据；
 *   解码失败应当抛错，页面会显示错误而不是悄悄当成空数据覆盖掉。
 * - `encode(data)`：把数据编码回字符串。
 *
 * 保存时带上读到的 revision；被别的标签页改过会得到 409，这里把 `conflict` 置为 true，
 * 由页面提示"已在别处修改，请刷新"，绝不自动覆盖。
 */
export function useSetting(key, { decode, encode }) {
  const data = shallowRef(null)
  const revision = ref(0)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')
  const conflict = ref(false)

  const resolveKey = () => (typeof key === 'function' ? key() : key)

  async function load() {
    loading.value = true
    error.value = ''
    conflict.value = false
    try {
      const result = await settingsApi.get(resolveKey())
      data.value = decode(result.value ?? null)
      revision.value = result.revision
      return data.value
    } catch (err) {
      error.value = err.message || '读取失败'
      throw err
    } finally {
      loading.value = false
    }
  }

  /** 保存成功返回 true；冲突或失败返回 false（错误信息在 `error` 里）。 */
  async function save(next) {
    saving.value = true
    error.value = ''
    try {
      const result = await settingsApi.put(resolveKey(), encode(next), revision.value)
      revision.value = result.revision
      data.value = decode(result.value)
      conflict.value = false
      return true
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SETTING_CONFLICT') conflict.value = true
      error.value = err.message || '保存失败'
      return false
    } finally {
      saving.value = false
    }
  }

  return { data, revision, loading, saving, error, conflict, load, save }
}
