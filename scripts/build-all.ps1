# 「后端托管前端」演示模式：先构建前端，把 dist 复制到后端静态目录，再打包后端
# 注意：静态目录会包含 assets、samples（样例课表图）与 tesseract（OCR worker/core/语言模型），
# 否则生产 8080 上的「照片导入课表」会因为缺资源而失败。
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

Invoke-Node (Join-Path $WorkspaceRoot 'frontend\scripts\copy-dist.mjs')
if ($LASTEXITCODE -ne 0) { throw "复制前端产物失败（exit $LASTEXITCODE）" }

Invoke-Maven -DskipTests package
if ($LASTEXITCODE -ne 0) { throw "后端打包失败（exit $LASTEXITCODE）" }

Write-Host '演示包已就绪：执行 scripts\start-backend.ps1 后访问 http://127.0.0.1:8080' -ForegroundColor Green
