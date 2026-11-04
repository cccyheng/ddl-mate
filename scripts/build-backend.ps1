# 安装后端依赖并编译（依赖缓存写入工作区 .tools\m2）
. "$PSScriptRoot\env.ps1"

Invoke-Maven -DskipTests package
if ($LASTEXITCODE -ne 0) { throw "后端构建失败（exit $LASTEXITCODE）" }
Write-Host '后端构建完成：backend\target\ddl-mate-backend-1.0.0-SNAPSHOT.jar' -ForegroundColor Green
