# setup-and-verify.ps1 —— 模拟"用户拿到复活包之后该怎么装"，然后验按钮。
#
# 做的事（就是说明书里那几步）：
#   ① 把仓库里的 revive\ 复制到桌面\复活\（用户会这么解压）
#   ② 把 revive-config.json 里的 YOUR_NAME 换成当前用户名
#   ③ 再跑 verify-buttons，看按钮能不能解析了
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup-and-verify.ps1
#
# 只读为主：不启动 DSH、不按任何按钮、不改系统设置。

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$家 = $env:USERPROFILE
$仓库 = Join-Path $家 'graywind'
if (-not (Test-Path $仓库)) { $仓库 = Join-Path ([Environment]::GetFolderPath('Desktop')) 'graywind' }
$源 = Join-Path $仓库 'revive'
$目标 = Join-Path ([Environment]::GetFolderPath('Desktop')) '复活'
$用户 = $env:USERNAME

$报告 = New-Object System.Collections.ArrayList
function 记($s) { [void]$报告.Add([string]$s); Write-Host $s }

记 '==================== 模拟安装 ===================='
记 ('仓库   ' + $仓库)
记 ('源     ' + $源)
记 ('目标   ' + $目标)

if (-not (Test-Path $源)) { 记 '!! 找不到 revive 目录，停'; exit 1 }

# ① 复制
# 目标已经存在时：改名备份，绝不直接删。
# 2026-11-02 的教训：这条原来是 Remove-Item，在本机跑了一次，把正式的 桌面\复活 删了。
# 判据：**删之前先问"这个目录是不是我建的"** —— 不是，就只许改名，不许删。
if (Test-Path $目标) {
  $时间 = Get-Date -Format 'yyyyMMdd-HHmmss'
  $备份 = $目标 + '.bak-' + $时间
  Move-Item $目标 $备份 -Force
  记 ('目标已存在，改名为：' + $备份)
  记 '  （没有删任何东西。确认不需要了就自己清理）'
}
New-Item -ItemType Directory $目标 -Force | Out-Null
Copy-Item (Join-Path $源 '*') $目标 -Recurse -Force
记 ('已复制到：' + $目标)

# ② 改配置
$cfgPath = Join-Path $目标 'revive-config.json'
if (-not (Test-Path $cfgPath)) { 记 '!! 复制后没有 revive-config.json，停'; exit 1 }
$原文 = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8)
$改后 = $原文.Replace('YOUR_NAME', $用户)
$无BOM = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($cfgPath, $改后, $无BOM)
记 ('配置已改：YOUR_NAME → ' + $用户)

# 验证改对了
try {
  $cfg = $改后 | ConvertFrom-Json
  记 ('  保护区     ' + $cfg.'保护区')
  记 ('  崩溃日志   ' + $cfg.'崩溃日志')
  记 ('  镜像目录   ' + $cfg.'路径'.'镜像目录')
  记 ('  插件库     ' + $cfg.'路径'.'插件库')
} catch { 记 ('!! 改完 JSON 读不出来：' + $_.Exception.Message); exit 1 }

# ③ 跑按钮验证
记 ''
$vb = Join-Path $仓库 'verify-buttons.ps1'
if (-not (Test-Path $vb)) {
  # 仓库里可能叫别的名字，退回用桌面\复活 下的
  $vb = Join-Path $目标 'verify-buttons.ps1'
}
if (Test-Path $vb) {
  # 关键：验的是「桌面\复活 里刚改好的那份配置」，不是仓库里那份占位版。
  # 另外 verify-buttons 用 Write-Host 输出（Information 流），必须 *>&1 才抓得到。
  & $vb -Config $cfgPath *>&1 | ForEach-Object { 记 ('  ' + [string]$_) }
} else {
  记 '找不到 verify-buttons.ps1'
}

# ④ 顺手看几个关键文件在不在
记 ''
记 '==================== 关键文件 ===================='
foreach ($f in @('revive.ps1', 'checkup.ps1', 'degrade.ps1', 'revive.cmd', '清cookie并启动.cmd', 'revive-config.json', '给AI的说明书.md', '给人的说明书.md', 'stallguard\check.cmd')) {
  $p = Join-Path $目标 $f
  记 ('{0,-24} {1}' -f $f, (Test-Path -LiteralPath $p))
}

$out = Join-Path ([Environment]::GetFolderPath('Desktop')) ('setup-verify-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
[System.IO.File]::WriteAllText($out, ($报告 -join "`r`n"), $无BOM)
Write-Host ''
Write-Host ('报告写到: ' + $out)
