/** 主题：system 跟随系统（不写 data-theme），light / dark 强制。 */
export const THEMES = ['system', 'light', 'dark']

export const THEME_LABELS = { system: '跟随系统', light: '浅色', dark: '深色' }

export function nextTheme(current) {
  const index = THEMES.indexOf(current)
  return THEMES[(index + 1) % THEMES.length]
}

export function applyTheme(theme, root = document.documentElement) {
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme
  else delete root.dataset.theme
}
