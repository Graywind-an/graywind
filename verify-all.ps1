param([string]$Config = '')

# verify-all.ps1 —— 一次跑完所有验证，产出一份报告。
#
# 用法（云电脑 / 任何 Windows，管理员 PowerShell）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-all.ps1
#
# 仓库位置自动找：$env:USERPROFILE\graywind，找不到就试桌面\graywind。
# 输出：桌面 verify-all.txt
#
# 设计原则：
#   · 每块独立 try/catch —— 一块炸了不影响后面
#   · 只读为主 —— 不装东西、不改配置（「干净机器」那一段用临时目录）
#   · 输出全 UTF-8 —— 不再出现 鉂? 这种乱码
#   · checkup.ps1 用 Write-Host 输出，必须 *>&1 才能抓到

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$家 = $env:USERPROFILE
$rt  = Join-Path $家 'AppData\Local\Programs\DeepSeek Harness\resources\runtime'
$node = Join-Path $rt 'primary-runtime\dependencies\node\bin\node.exe'
$dsh  = Join-Path $rt 'cli\bin\dsh.cmd'
$repo = Join-Path $家 'graywind'
if (-not (Test-Path $repo)) {
  $alt = Join-Path ([Environment]::GetFolderPath('Desktop')) 'graywind'
  if (Test-Path $alt) { $repo = $alt }
}
$无BOM = New-Object System.Text.UTF8Encoding($false)

$报告 = New-Object System.Collections.ArrayList
function 记($s) { [void]$报告.Add([string]$s); Write-Host $s }
function 标题($t) { 记 ''; 记 ('==================== ' + $t + ' ====================') }
function 输出尾($o, $n) {
  $行 = ($o -split "`n") | Where-Object { $_.Trim() }
  foreach ($l in ($行 | Select-Object -Last $n)) { 记 ('  ' + $l.Trim()) }
}

标题 '0 环境'
记 ('用户        ' + $env:USERNAME)
记 ('仓库        ' + $repo + '  存在=' + (Test-Path $repo))
if (Test-Path $node) { 记 ('node 版本   ' + (& $node --version 2>&1)) } else { 记 'node 不存在，后面全会失败' }
if (Test-Path $dsh) { 记 ('DSH 版本    ' + (& $dsh --version 2>&1)) } else { 记 'dsh cli 不存在' }

标题 '1 stallguard 自测 + 冒烟'
foreach ($f in @('_selftest.mjs', '_smoke.mjs')) {
  $p = Join-Path $repo "stallguard\$f"
  记 ('--- ' + $f + ' ---')
  if (-not (Test-Path $p)) { 记 '  缺文件'; continue }
  try {
    $o = & $node $p 2>&1 | Out-String
    输出尾 $o 2
    记 ('  退出码 ' + $LASTEXITCODE)
  } catch { 记 ('  异常: ' + $_.Exception.Message) }
}

标题 '2 digest 冒烟'
$p = Join-Path $repo 'digest\_smoke.mjs'
if (Test-Path $p) {
  try {
    $o = & $node $p 2>&1 | Out-String
    输出尾 $o 2
    记 ('  退出码 ' + $LASTEXITCODE)
  } catch { 记 ('  异常: ' + $_.Exception.Message) }
} else { 记 '  缺文件' }

标题 '3 digest 脚本版（四个子命令）'
$ds = Join-Path $repo 'digest\消化系统.mjs'
if (Test-Path $ds) {
  $组 = @(
    @('配置'),
    @('尝', (Join-Path $repo 'digest\plugin')),
    @('消化', (Join-Path $repo 'digest\plugin'), '--不记账'),
    @('排泄')
  )
  foreach ($子 in $组) {
    记 ('--- node 消化系统.mjs ' + ($子 -join ' ') + ' ---')
    try {
      $o = & $node $ds @子 2>&1 | Out-String
      输出尾 $o 3
      记 ('  退出码 ' + $LASTEXITCODE)
    } catch { 记 ('  异常: ' + $_.Exception.Message) }
  }
} else { 记 '  缺文件' }

标题 '4 scripts/analyze.mjs（扫会话）'
$an = Join-Path $repo 'scripts\analyze.mjs'
if (Test-Path $an) {
  try {
    $o = & $node $an 2>&1 | Out-String
    输出尾 $o 4
    记 ('  退出码 ' + $LASTEXITCODE)
  } catch { 记 ('  异常: ' + $_.Exception.Message) }
} else { 记 '  缺文件' }

标题 '5 插件栈（dump-config）'
if (Test-Path $dsh) {
  try {
    $o = & $dsh --profile web --dump-config 2>&1 | Out-String
    记 ('  退出码 ' + $LASTEXITCODE)
    $命中 = ($o -split "`n") | Where-Object { $_ -match 'reasoning-guard|dsh-digest|skipping' }
    if ($命中) { foreach ($l in $命中) { 记 ('  ' + $l.Trim()) } } else { 记 '  dump 里没有我们的 entry（要么没装，要么没加进 bundles）' }
  } catch { 记 ('  异常: ' + $_.Exception.Message) }
} else { 记 '  没有 dsh.cmd' }

标题 '6 复活包体检（checkup.ps1，只读）'
$ck = Join-Path $repo 'revive\checkup.ps1'
if (Test-Path $ck) {
  try {
    # Write-Host 走 Information 流，必须 *>&1
    # 参数**必须直接写**，不能先塞数组再 `& $ck @ckArg`：
    # PowerShell 的数组 splatting 只喂位置参数，`-NoPause` 这种单独开关
    # 会被当成 -Fix 的值（实测日志里冒出「[跳] 没有编号 -NoPause」，
    # 而 NoPause 仍是 false → 交互式窗口就停在「按回车关闭」）。
    # 2026-11-02 云电脑上真卡住过。
    if ($Config) { $o = & $ck -NoPause -Config $Config *>&1 | Out-String }
    else { $o = & $ck -NoPause *>&1 | Out-String }
    输出尾 $o 25
    记 ('  退出码 ' + $LASTEXITCODE)
  } catch { 记 ('  异常: ' + $_.Exception.Message) }
} else { 记 '  缺文件' }

标题 '7 干净机器验证（空 USERPROFILE）'
try {
  $假家 = Join-Path $env:TEMP ('fakehome-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
  New-Item -ItemType Directory -Path $假家 -Force | Out-Null
  记 ('假家目录    ' + $假家)
  记 ('进来时有   ' + @(Get-ChildItem $假家 -Force).Count + ' 项')
  $旧家 = $env:USERPROFILE
  $env:USERPROFILE = $假家
  try {
    $o = & $node (Join-Path $repo 'stallguard\_smoke.mjs') 2>&1 | Out-String
    输出尾 $o 2
    记 ('  退出码 ' + $LASTEXITCODE)
    $假日志 = Join-Path $假家 '.dsh\notes\reasoning-guard.log'
    记 ('日志被创建  ' + (Test-Path $假日志))
    if (Test-Path $假日志) { 记 ('  行数     ' + (Get-Content $假日志).Count) }
  } finally {
    $env:USERPROFILE = $旧家
  }
  Remove-Item $假家 -Recurse -Force -ErrorAction SilentlyContinue
} catch { 记 ('  异常: ' + $_.Exception.Message) }

标题 '8 结论'
记 '报告结束。把 verify-all.txt 整份贴回去。'

$out = Join-Path ([Environment]::GetFolderPath('Desktop')) ('verify-all-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
[System.IO.File]::WriteAllText($out, ($报告 -join "`r`n"), $无BOM)
Write-Host ''
Write-Host ('报告写到: ' + $out)
