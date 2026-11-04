import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// DDL Mate 前端构建配置
// - dev server 绑定 127.0.0.1:5173，并把 /api 代理到后端 127.0.0.1:8080
// - base 必须是 '/'：应用部署在站点根路径（后端静态托管 / Vite dev 都是根路径）。
//   用相对 base './' 会让 history 路由的深层地址（如 /tasks/1）把资源解析成
//   /tasks/assets/xxx.js，被 SPA 回退返回 index.html，从而出现
//   "MIME type text/html" 白屏。深层路由由后端的 SpaController 回退到 index.html。
export default defineConfig({
  base: '/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
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
