/**
 * 相册 / 相机选择器的**唯一封装**（原生模块只在调用时动态 import）。
 *
 * 为什么抽出来：任务原图页现在也允许直接放一张截图；如果每页各抄一份
 * `expo-image-picker` 调用，权限文案、取消语义和字段形状很容易漂移。
 *
 * 这里只负责「拿到一个本机临时 URI + 尺寸 / MIME」；不归档、不识别、不写库。
 * 真正的持久化由调用方（截图库归档 / 任务原图）显式执行。
 */

/** 一次「选照片 / 拍照」的结果；与 `photoImportController` 的既有形状一致。 */
export type PhotoPickResult =
  | { status: 'picked'; uri: string; source?: { width?: number | null; height?: number | null; mimeType?: string | null } }
  | { status: 'cancelled' }
  | { status: 'permission'; message: string; canAskAgain: boolean }
  | { status: 'error'; message: string }

/** 从相册选一张；返回本机 uri 或可读原因。 */
export async function pickPhotoFromLibrary(): Promise<PhotoPickResult> {
  const ImagePicker = await import('expo-image-picker')
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!permission.granted) {
    return {
      status: 'permission',
      canAskAgain: permission.canAskAgain,
      message: '还没有允许访问相册。请在系统提示里允许，或到 iOS「设置 → Expo Go → 照片」打开后重试。',
    }
  }
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: false })
  if (result.canceled || !result.assets?.length) return { status: 'cancelled' }
  const asset = result.assets[0]!
  if (!asset.uri) return { status: 'error', message: '系统没有返回图片内容，请换一张图再试。' }
  return {
    status: 'picked',
    uri: asset.uri,
    source: { width: asset.width, height: asset.height, mimeType: asset.mimeType ?? null },
  }
}

/** 取得相机权限并拍照；返回本机 uri 或可读原因。 */
export async function capturePhotoFromCamera(): Promise<PhotoPickResult> {
  const ImagePicker = await import('expo-image-picker')
  const permission = await ImagePicker.requestCameraPermissionsAsync()
  if (!permission.granted) {
    return {
      status: 'permission',
      canAskAgain: permission.canAskAgain,
      message: permission.canAskAgain
        ? '还没有允许使用相机。请再点一次并在系统提示里选择「允许」，或改用「从相册选择」。'
        : '相机权限已被拒绝。请到 iOS「设置 → Expo Go → 相机」里打开，或改用「从相册选择」。',
    }
  }
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: false })
  if (result.canceled || !result.assets?.length) return { status: 'cancelled' }
  const asset = result.assets[0]!
  if (!asset.uri) return { status: 'error', message: '相机没有返回图片，请再试一次。' }
  return {
    status: 'picked',
    uri: asset.uri,
    source: { width: asset.width, height: asset.height, mimeType: asset.mimeType ?? null },
  }
}
