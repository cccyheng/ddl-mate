import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// DDL Mate 前端构建配置
// - dev server 绑定 127.0.0.1:5173，并把 /api 代理到后端 127.0.0.1:8080
// - base 必须是 '/'：应用部署在站点根路径（后端静态托管 / Vite dev 都是根路径）。
//   用相对 base './' 会让 history 路由的深层地址（如 /tasks/1）把资源解析成
//   /tasks/assets/xxx.js，被 SPA 回退返回 index.html，从而出现
//   "MIME type text/html" 白屏。深层路由由后端的 SpaController 回退到 index.html。
// - @domain 直接指向手机端的纯 TypeScript 规则模块（专注、计划、压力、模板、复习……），
//   两端共用同一份实现，上限 / 校验 / 上海时区规则不会漂移。Vite 自带 TS 转译，不做类型检查；
//   类型检查仍由 mobile 的 tsc 负责。只能引用不依赖 React Native / Expo / SQLite 的模块。
const domainDir = fileURLToPath(new URL('../mobile/src/domain', import.meta.url))

export default defineConfig({
  base: '/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@domain': domainDir,
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    fs: {
      allow: [fileURLToPath(new URL('.', import.meta.url)), domainDir],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
})
