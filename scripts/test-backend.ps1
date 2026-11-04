# 运行后端集成测试（H2 内存库 + MockMvc）
. "$PSScriptRoot\env.ps1"

Invoke-Maven test
if ($LASTEXITCODE -ne 0) { throw "测试失败（exit $LASTEXITCODE）" }
Write-Host '全部测试通过' -ForegroundColor Green
