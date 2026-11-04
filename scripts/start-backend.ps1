# 以 dev profile（H2 文件数据库）启动后端，监听 127.0.0.1:8080
# 后台/隐藏窗口启动示例（会输出 PID）：
#   $p = Start-Process pwsh -ArgumentList '-NoProfile','-File',"$PWD\scripts\start-backend.ps1" -WindowStyle Hidden -PassThru
#   $p.Id | Out-File .tools\backend.pid
. "$PSScriptRoot\env.ps1"

$env:DDLMATE_SERVER_PORT = if ($env:DDLMATE_SERVER_PORT) { $env:DDLMATE_SERVER_PORT } else { '8080' }
$env:DDLMATE_BIND_ADDRESS = if ($env:DDLMATE_BIND_ADDRESS) { $env:DDLMATE_BIND_ADDRESS } else { '127.0.0.1' }

# 重要：application-dev.yml 用的是相对路径 ./data，而 Maven 以 **backend/** 作为进程工作目录，
# 所以 H2 数据库与上传附件实际落在 backend\data\ 下，不是仓库根目录的 data\。
# 想固定位置可显式设置绝对路径，例如：
#   $env:DDLMATE_UPLOAD_DIR = Join-Path $WorkspaceRoot 'data\uploads'
$dataDir = Join-Path $WorkspaceRoot 'backend\data'

Write-Host "启动后端：http://$($env:DDLMATE_BIND_ADDRESS):$($env:DDLMATE_SERVER_PORT)  （profile=dev）" -ForegroundColor Cyan
Write-Host "  工作目录（Maven 设定）：$WorkspaceRoot\backend" -ForegroundColor DarkGray
Write-Host "  H2 数据库：$(Join-Path $dataDir 'ddlmate-dev.mv.db')" -ForegroundColor DarkGray
Write-Host "  附件目录：$(if ($env:DDLMATE_UPLOAD_DIR) { $env:DDLMATE_UPLOAD_DIR } else { Join-Path $dataDir 'uploads' })" -ForegroundColor DarkGray

Invoke-Maven spring-boot:run "-Dspring-boot.run.profiles=dev" "-Dspring-boot.run.jvmArguments=-Dfile.encoding=UTF-8"
