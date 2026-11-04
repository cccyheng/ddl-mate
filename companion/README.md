# DDL Mate 本地 OCR 伴侣服务（`companion/`）

> 一台**同一 Wi-Fi 电脑**上跑的小 Node 服务：手机把课表截图发过来，它用**本地** Tesseract
> 识别成结构化候选再发回去。图片不出局域网、不上传任何第三方，也不碰本项目的后端 8080。

端口默认 **8082**（后端 8080、Metro 8081 都保持不变）。

## 1. 启动

```powershell
cd companion
pnpm install        # 依赖已装好时跳过（见第 4 节的安装说明）
pnpm start          # 只监听 127.0.0.1:8082，模拟器 / 本机用
pnpm start:lan      # 监听 0.0.0.0:8082，手机真机用；会打印手机该填的地址
pnpm test           # 13 项 HTTP 边界测试，不需要 OCR
```

`pnpm start:lan` 的输出里会有类似：

```
OCR 伴侣服务已启动：http://127.0.0.1:8082（监听 0.0.0.0:8082）
手机端地址可以填：http://192.168.31.73:8082
当前仅监听局域网（同一 Wi-Fi 才能访问）；没有开隧道、没有改防火墙。
```

把那一行地址填到手机 App 的「课程 → 识别服务设置」里即可（App 也会尝试按
Expo/Metro 的主机名自动推断，但自动推断失败时以这一行为准）。

可选参数：`--port 8083`、`--host <addr>`、`--localhost`（显式回到只监听本机）。

## 2. 接口（只有两个，没有别的）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/v1/health` | 健康检查（手机确认「连上的是这台电脑」） |
| `POST` | `/v1/ocr/timetable` | `{ "imageBase64": "<PNG 或 JPEG 的 base64>" }` → 识别候选 |

响应：

```jsonc
{
  "ok": true,
  "serviceVersion": "0.1.0",
  "image": { "width": 1080, "height": 2400, "format": "png", "bytes": 1752730 },
  "layout": "week-grid",          // 或回退路径的 list / grid / region / full-image
  "week": 7,                      // 图片里显示的第 N 教学周；没显示就是 null
  "candidates": [ { "name": "形势与政策", "weekday": 7, "startTime": "08:00", "endTime": "09:35", "startWeek": 7, "endWeek": 7, "periodStart": 1, "periodEnd": 2, "location": "百川楼-103（多媒体）", "warnings": [] } ],
  "warnings": [],
  "diagnostics": { "coverage": 0.397, "componentCount": 21, "columnCount": 6, "periodCount": 10 },
  "rawText": "…",
  "ms": 2936
}
```

## 3. 安全与边界（都写进代码并在测试里断言）

- **默认只监听 `127.0.0.1`**；只有显式 `--lan` 才绑局域网，启动日志里会说清楚。
- **没有任何文件服务**：没有静态目录、不接受路径参数、不接受 URL 参数 →
  不存在「读服务器任意文件」或「让服务器去访问任意网址」的接口。任意未知路径一律 404。
- 只接受 `POST` + `application/json`；否则 405 / 415。
- 上限：请求体 ≤ ~16MB（base64 计）、原图 ≤ 12MB、像素 ≤ 2600 万、单边 ≤ 10000。
  超限返回 413 与可读中文说明，**在解码之前**就拒绝（PNG/JPEG 都先只看头部尺寸）。
- 只认 PNG / JPEG 的魔数，不信任扩展名或 MIME；HEIC 由手机先转 JPEG。
- 并发上限 2，超过返回 429（`BUSY`）；单次识别超时 180 秒，超时按取消处理。
- 语言模型只从工作区 `frontend/public/tesseract/lang` 读，**不联网下载**。
- 日志不打印图片内容、不打印 base64、不打印任何凭据。

## 4. 依赖与安装说明

`pnpm-workspace.yaml` 里设了 `nodeLinker: hoisted`，原因是 `tesseract.js` 运行时会
`require('regenerator-runtime/runtime')`，pnpm 默认的 isolated 布局下顶层 `node_modules`
里没有它，启动就报 `Cannot find module 'regenerator-runtime/runtime'`。

依赖：`tesseract.js@6`（识别）、`jpeg-js`（JPEG 解码）、`pngjs`（PNG 解码 / 测试用编码）。
安装命令（缓存与 store 都留在工作区内）：

```powershell
$env:CI='true'
pnpm install --store-dir=../.tools/pnpm-store --cache-dir=../.tools/npm-cache
```

`allowBuilds: tesseract.js: false` 是刻意的：它的 install 脚本只是 opencollective 募捐提示，
不执行不影响识别（已实测 `import('tesseract.js')` 正常）。

## 5. 复用而不是重写

识别流水线直接 import 前端产品代码，一行规则都不复制：

- `frontend/src/ocr/weekGridOcr.js` —— 卡片式周视图的完整编排（几何 + 逐块识别 + 有限重试）
- `frontend/src/ocr/weekGridLayout.js` / `imageOps.js` —— 几何与预处理纯函数
- `frontend/src/ocr/timetableParser.js` —— 不像周视图时的整图回退解析
- `frontend/src/ocr/ocrConfig.js` —— 与浏览器相同的 Tesseract 参数
- `frontend/public/tesseract/lang` —— 本地中英文语言模型

`tesseract.js` 用 `createRequire(frontend/package.json)` 从前端的 `node_modules` 解析，
因此**不需要**改前端 `package.json`、也不需要把依赖再装一遍。

## 6. 测试

```powershell
# 13 项 HTTP / 解码边界测试（假引擎，秒级）
node --test --experimental-test-isolation=none tests/server.test.mjs

# 5 项真实 socket HTTP 测试（正常请求 / 客户端中途断开 / 413 / 404 / 默认只绑本机）
node --test --experimental-test-isolation=none tests/serverHttp.test.mjs

# 1 项真实引擎「整图回退」测试：用 frontend/public/samples 两张合成图
node --test --experimental-test-isolation=none tests/fallbackEngine.test.mjs

# 真实用户照片的 HTTP 端到端报告（会真的起服务、真的识别）
node tests/realImageHttp.mjs --json ..\.supervision\phase2-real-image-ocr.json
```

`tests/realImageHttp.mjs` 里的对照数据来自 `.supervision/user-photo-expected.json`，
**只用于打印命中率报告，绝不参与识别**（服务端并不知道这个文件存在）。

最近一次真实照片结果：21 块 / 21 名称 / 21 时刻 / 20 地点 / 显示第 7 周，约 2.8 秒。
已知一处地点误读（百川 → 百咱）不做硬编码修正，交给手机端「可编辑候选」让用户改。
