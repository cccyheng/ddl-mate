/**
 * 原生设计令牌：暖白 / 森林绿 / 陶土橙。全局改版统一圆角、间距与状态色。
 * 原生端独立维护，不依赖网页样式或 WebView。
 */

import { Platform, TextStyle } from 'react-native'

export const colors = {
  /** 暖白底 */
  bg: '#f5f6f2',
  surface: '#ffffff',
  surfaceSoft: '#f5f7f3',
  surfaceMute: '#f1efe6',
  /** 墨色正文 */
  text: '#23352e',
  textSoft: '#4f6157',
  textMuted: '#65746b',
  /** 主操作深绿 */
  primary: '#285b47',
  primaryDark: '#1d4636',
  primarySoft: '#e7efea',
  primaryTint: '#f1f6f3',
  /** 陶土橙（紧迫 / 逾期 / 危险） */
  clay: '#b4573a',
  claySoft: '#fbeee8',
  clayDark: '#8f4530',
  /** 暖赭石（警示） */
  warn: '#8a6a2f',
  warnSoft: '#f6efdf',
  border: '#e3e8df',
  borderStrong: '#d5d0be',
  white: '#ffffff',
  overlay: 'rgba(35, 53, 46, 0.45)',
} as const

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const

export const radius = {
  sm: 10,
  md: 14,
  lg: 22,
  pill: 999,
} as const

/** 可访问性：所有可点控件的触控目标 ≥ 44pt（Apple HIG 最小值）。 */
export const MIN_TOUCH_SIZE = 44

export const typography = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: '700', color: colors.text } as TextStyle,
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700', color: colors.text } as TextStyle,
  section: { fontSize: 17, lineHeight: 23, fontWeight: '600', color: colors.text } as TextStyle,
  body: { fontSize: 16, lineHeight: 23, color: colors.text } as TextStyle,
  bodySoft: { fontSize: 15, lineHeight: 22, color: colors.textSoft } as TextStyle,
  label: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.textSoft } as TextStyle,
  caption: { fontSize: 13, lineHeight: 18, color: colors.textMuted } as TextStyle,
  mono: {
    fontSize: 15,
    lineHeight: 21,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  } as TextStyle,
} as const

/** 只有一套本机字体栈，不加载网络字体。 */
export const fontFamily = Platform.select({
  ios: undefined as unknown as string,
  default: undefined as unknown as string,
})

export const shadows = {
  card: {
    shadowColor: '#23352e',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
} as const

/** 语义色调 → 颜色，供徽标 / 提示条统一使用。 */
export type Tone = 'neutral' | 'primary' | 'clay' | 'warn' | 'success' | 'muted'

export const toneColors: Record<Tone, { fg: string; bg: string; border: string }> = {
  neutral: { fg: colors.text, bg: colors.surfaceSoft, border: colors.border },
  primary: { fg: colors.primaryDark, bg: colors.primarySoft, border: colors.primary },
  clay: { fg: colors.clayDark, bg: colors.claySoft, border: colors.clay },
  warn: { fg: colors.warn, bg: colors.warnSoft, border: colors.warn },
  success: { fg: colors.primaryDark, bg: colors.primarySoft, border: colors.primary },
  muted: { fg: colors.textMuted, bg: colors.surfaceMute, border: colors.border },
}
