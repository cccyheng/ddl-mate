# 启动前端开发服务器（127.0.0.1:5173，/api 代理到 8080）
. "$PSScriptRoot\env.ps1"

if (-not (Test-Path -LiteralPath (Join-Path $WorkspaceRoot 'frontend\node_modules'))) {
    Write-Host '未发现 node_modules，先执行 pnpm install…' -ForegroundColor Yellow
    Invoke-Pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败（exit $LASTEXITCODE）" }
}

Write-Host '启动前端：http://127.0.0.1:5173  （API 代理到 http://127.0.0.1:8080）' -ForegroundColor Cyan
Invoke-Pnpm dev
