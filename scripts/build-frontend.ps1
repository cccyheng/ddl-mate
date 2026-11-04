# 安装前端依赖并构建（pnpm store 写入工作区 .tools\pnpm-store）
#
# 说明：OCR 资源（worker/core/中英文语言模型）由 prepare-ocr-assets.mjs 从 node_modules
# 复制到 frontend/public/tesseract，再被 vite 一起打包。这里显式先跑一次准备脚本，
# 不依赖 pnpm 的 prebuild 钩子是否被 pnpm11 执行。
. "$PSScriptRoot\env.ps1"

Invoke-Pnpm install --no-frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败（exit $LASTEXITCODE）" }

Invoke-Node (Join-Path $WorkspaceRoot 'frontend\scripts\prepare-ocr-assets.mjs')
if ($LASTEXITCODE -ne 0) { throw "OCR 资源准备失败（exit $LASTEXITCODE）" }

Push-Location (Join-Path $WorkspaceRoot 'frontend')
try {
    Invoke-Node 'node_modules\vite\bin\vite.js' build
    if ($LASTEXITCODE -ne 0) { throw "vite build 失败（exit $LASTEXITCODE）" }
} finally {
    Pop-Location
}

Write-Host '前端构建完成：frontend\dist（含 samples 与 tesseract 资源）' -ForegroundColor Green
