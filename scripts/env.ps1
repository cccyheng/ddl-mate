# =====================================================================
# 公共设置：Java 21、Maven、pnpm、工作区内的依赖缓存
# 其它脚本都会先 dot-source 本文件。
#
# 约定：
#   - 所有下载/缓存都落在工作区 .tools 下，不修改全局环境；
#   - 无论从哪个目录启动脚本，工作目录都固定为工作区根目录，
#     因此 dev profile 的 H2 数据目录 ./data 一定落在工作区里；
#   - pnpm 优先用 PATH 上的命令，找不到时回退到 Harness 内置的 pnpm.cjs。
# =====================================================================

$ErrorActionPreference = 'Stop'

$env:DSH_WORKSPACE_ROOT = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $env:DSH_WORKSPACE_ROOT

$script:WorkspaceRoot = $env:DSH_WORKSPACE_ROOT
$script:ToolsDir = Join-Path $WorkspaceRoot '.tools'
$script:M2Repo = Join-Path $ToolsDir 'm2\repository'
$script:PnpmStore = Join-Path $ToolsDir 'pnpm-store'
$script:NpmCache = Join-Path $ToolsDir 'npm-cache'

# ---------- Java 21 ----------
if (-not $env:JAVA_HOME -or -not (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
    $candidate = 'C:\Program Files\Java\jdk-21.0.10'
    if (Test-Path -LiteralPath (Join-Path $candidate 'bin\java.exe')) {
        $env:JAVA_HOME = $candidate
    } else {
        throw "未找到 Java 21，请设置 JAVA_HOME 后重试（期望目录：C:\Program Files\Java\jdk-21.0.10）"
    }
}

# ---------- Maven ----------
$script:MvnCmd = 'C:\Program Files\JetBrains\IntelliJ IDEA 2026.1.1\plugins\maven\lib\maven3\bin\mvn.cmd'
if (-not (Test-Path -LiteralPath $MvnCmd)) {
    $found = Get-ChildItem 'C:\Program Files\JetBrains' -Recurse -Filter 'mvn.cmd' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($found) { $script:MvnCmd = $found.FullName }
    else { throw '未找到 Maven：既没有安装到 PATH，也没有在 IntelliJ 目录下找到打包版 maven3' }
}

# ---------- pnpm / node ----------
$script:NodeCmd = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $NodeCmd) {
    $nodeCandidates = @(
        'C:\Users\33284\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe',
        'D:\DS Harness\resources\runtime\node\node.exe'
    )
    foreach ($c in $nodeCandidates) {
        if (Test-Path -LiteralPath $c) { $script:NodeCmd = $c; break }
    }
}
if (-not $NodeCmd) { throw '未找到 node，可执行 pnpm 的路径，请把 node 加入 PATH' }

$script:PnpmCmd = (Get-Command pnpm -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $PnpmCmd) {
    $pnpmCjsCandidates = @(
        'D:\DS Harness\resources\runtime\pnpm\bin\pnpm.cjs',
        'C:\Users\33284\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\pnpm.cjs'
    )
    foreach ($c in $pnpmCjsCandidates) {
        if (Test-Path -LiteralPath $c) { $script:PnpmCjs = $c; break }
    }
    if (-not $PnpmCjs) { throw '未找到 pnpm：PATH 中没有 pnpm，也没有找到 pnpm.cjs' }
}

New-Item -ItemType Directory -Force -Path $M2Repo, $PnpmStore, $NpmCache | Out-Null

# npm/pnpm 全部缓存与状态都指向工作区，并关闭更新检查
# 注意：这里必须用绝对路径。.npmrc 中的相对路径是相对 frontend/ 解析的，环境变量则不是。
$env:npm_config_store_dir = $PnpmStore
$env:npm_config_cache = $NpmCache
$env:npm_config_update_notifier = 'false'
$env:npm_config_fund = 'false'
$env:npm_config_audit = 'false'
$env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
$env:NO_UPDATE_NOTIFIER = '1'

# 非交互式构建：pnpm 需要重建 node_modules 时不再等待 TTY 确认，
# 否则报 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY。
# 只允许重建"生成的" node_modules；源码与 pnpm-lock.yaml 不会被改动。
$env:CI = 'true'
$env:npm_config_confirm_modules_purge = 'false'

function Invoke-Maven {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & $MvnCmd -B "-Dmaven.repo.local=$M2Repo" -f (Join-Path $WorkspaceRoot 'backend\pom.xml') @Arguments
}

function Invoke-Pnpm {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    Push-Location (Join-Path $WorkspaceRoot 'frontend')
    try {
        if ($PnpmCmd) {
            & $PnpmCmd @Arguments
        } else {
            # 回退：用 node 直接执行内置的 pnpm.cjs
            & $NodeCmd $PnpmCjs @Arguments
        }
    } finally {
        Pop-Location
    }
}

function Invoke-Node {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & $NodeCmd @Arguments
}

Write-Host "[env] 工作目录   = $WorkspaceRoot" -ForegroundColor DarkGray
Write-Host "[env] JAVA_HOME = $env:JAVA_HOME" -ForegroundColor DarkGray
Write-Host "[env] Maven     = $MvnCmd" -ForegroundColor DarkGray
Write-Host "[env] Node      = $NodeCmd" -ForegroundColor DarkGray
Write-Host "[env] pnpm      = $(if ($PnpmCmd) { $PnpmCmd } else { "$NodeCmd $PnpmCjs" })" -ForegroundColor DarkGray
Write-Host "[env] 本地仓库   = $M2Repo" -ForegroundColor DarkGray
