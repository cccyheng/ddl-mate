<#
.SYNOPSIS
    启动 DDL Mate 原生客户端的开发服务器（Metro），用手机上的 Expo Go 预览。

.DESCRIPTION
    这是「路线 A：Expo Go 预览」的入口，**不是**独立签名 App 的构建脚本。

    要点：
    - 使用**项目内**的 Expo CLI（mobile/node_modules/expo/bin/cli），不依赖全局 npm；
    - Node 用本机固定的那个绝对路径（见 $DefaultNodePath），找不到才回退 PATH，
      并把该 Node 所在目录**前置**到子进程的 PATH，避免子进程解析到别的 node；
    - 默认绑定 localhost（最保守，不把开发服务器暴露到局域网）；
      手机真机预览必须**显式**加 -Lan，脚本不会替你猜测；
    - -Lan 与 -Localhost 互斥，同时给出会直接报错，不做隐式优先级；
    - 不建隧道（--tunnel）、不改防火墙、不注册守护进程、不做任何云端上传；
    - 只启动一个前台进程：按 Ctrl+C 结束，脚本不留在后台，并原样透传 CLI 退出码。

    登录态：脚本**不设置、不覆盖 Expo 的家目录**，也不读取任何凭据文件。
    它沿用这台电脑上默认的 Expo 登录态（用户已登录），所以扫码时手机与电脑
    只要登录**同一个免费账号**即可。如果提示未登录，请先在 mobile 目录手动执行
    `expo start`（或 `expo login`）完成一次登录，脚本不代你登录。

.PARAMETER Lan
    显式使用 LAN 绑定，手机真机扫码必须用它。不传时默认走 localhost。

.PARAMETER Localhost
    使用 localhost 绑定（**默认行为**）。仅在本机 / 模拟器 / 浏览器预览时用。

.PARAMETER Clear
    启动前清掉 Metro 缓存（--clear）。

.PARAMETER NoGo
    不传 `--go`。默认会传，强制客户端解析到 Expo Go，避免在多客户端环境下弹选择。

.PARAMETER Port
    Metro 端口，默认 8081。取值范围 1..65535。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\start-mobile.ps1
    默认 localhost 启动，适合模拟器 / 本机预览。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\start-mobile.ps1 -Lan
    显式 LAN 启动，适合 iPhone 上的 Expo Go 扫码。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\start-mobile.ps1 -Localhost -Clear
    本机/模拟器预览并清缓存。
#>
[CmdletBinding()]
param(
    [switch]$Lan,
    [switch]$Localhost,
    [switch]$Clear,
    [switch]$NoGo,
    [ValidateRange(1, 65535)]
    [int]$Port = 8081
)

$ErrorActionPreference = 'Stop'

# -Lan / -Localhost 互斥：同时给出属于调用方错误，直接失败而不是猜一个。
if ($Lan -and $Localhost) {
    throw '参数冲突：-Lan 与 -Localhost 不能同时使用。请只选一个（不传则默认 localhost）。'
}

# 工作区根目录（本脚本在 scripts/ 下，因此上一级就是根）
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$mobileDir = Join-Path $workspaceRoot 'mobile'

# 本机固定的 Node 运行时；找不到再回退到 PATH 里的 node。
$DefaultNodePath = 'C:\Users\33284\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'

function Resolve-NodePath {
    if (Test-Path -LiteralPath $DefaultNodePath) { return $DefaultNodePath }
    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    throw "找不到 Node 运行时。已检查 '$DefaultNodePath'，PATH 里也没有 node。"
}

function Assert-Prerequisites {
    if (-not (Test-Path -LiteralPath $mobileDir)) {
        throw "找不到 mobile 目录：$mobileDir"
    }
    $cli = Join-Path $mobileDir 'node_modules\expo\bin\cli'
    if (-not (Test-Path -LiteralPath $cli)) {
        throw @"
Expo CLI 不存在：$cli
请先在 mobile 目录安装依赖（缓存留在工作区内）：
  cd "$mobileDir"
  pnpm install
"@
    }
    return $cli
}

$nodePath = Resolve-NodePath
$cliPath = Assert-Prerequisites

# Node 版本要求（Expo SDK 57 / Metro 需要 >= 20.19.4）
$nodeVersion = (& $nodePath --version).Trim()
$parsed = [version]($nodeVersion.TrimStart('v'))
if ($parsed -lt [version]'20.19.4') {
    Write-Warning "当前 Node 为 $nodeVersion，Expo SDK 57 建议 >= 20.19.4。"
}

# 把本机 Node 所在目录前置到 PATH，让 Metro / Expo 派生的子进程也用同一个运行时。
$nodeDir = Split-Path -Parent $nodePath
$env:PATH = "$nodeDir;$env:PATH"

# 只关遥测；**不**改 Expo 家目录，沿用用户已保存的默认登录态。
$env:EXPO_NO_TELEMETRY = '1'

# 绑定方式：默认 localhost，显式 -Lan 才暴露到局域网。
$hostFlag = if ($Lan) { '--lan' } else { '--localhost' }

$expoArgs = @($cliPath, 'start', $hostFlag, '--port', "$Port")
if ($Clear) { $expoArgs += '--clear' }
if (-not $NoGo) { $expoArgs += '--go' }

Write-Host ''
Write-Host 'DDL Mate 原生客户端 · 开发服务器（Metro）' -ForegroundColor Green
Write-Host "  工作区      : $workspaceRoot"
Write-Host "  mobile      : $mobileDir"
Write-Host "  Node        : $nodePath ($nodeVersion)"
Write-Host "  Expo home   : 默认（沿用已登录状态；脚本不覆盖、不读取凭据）"
Write-Host "  绑定方式    : $hostFlag (端口 $Port)"
Write-Host "  隧道/守护进程: 不使用（Ctrl+C 结束）"
Write-Host ''
Write-Host '在 iPhone 上预览的步骤：' -ForegroundColor Cyan
Write-Host '  1. App Store 安装 Expo Go（用户手机为 iOS 27）。'
Write-Host '  2. 手机与电脑登录**同一个免费 Expo 账号**（SDK 57 起 Expo Go 需要登录，'
Write-Host '     本脚本沿用电脑上已保存的默认登录态）。'
Write-Host '  3. 手机与电脑连**同一个 Wi-Fi**，并用 -Lan 启动本脚本。'
Write-Host '  4. 用 Expo Go 扫描下面终端里出现的二维码。'
Write-Host '  5. 加载与每次重载都需要这台电脑上的 Metro 保持运行：'
Write-Host '     这是原生开发容器预览，不是独立安装、也不是离线冷启动。'
Write-Host ''
if (-not $Lan) {
    Write-Host '提示：当前是 localhost 绑定，手机扫码连不上属于预期。真机预览请加 -Lan。' -ForegroundColor Yellow
}
Write-Host '如果 LAN 二维码连不上：确认手机和电脑在同一网段；'
Write-Host '不要改用 --tunnel（本任务不授权隧道），也不要修改防火墙。' -ForegroundColor Yellow
Write-Host ''

Push-Location $mobileDir
try {
    & $nodePath @expoArgs
    $cliExit = $LASTEXITCODE
}
finally {
    Pop-Location
}

# 原样透传 CLI 退出码，便于 CI / 上层脚本判断失败。
exit $cliExit
