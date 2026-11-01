# run-all.ps1 —— 一键：自动备份 → 准备 → 只读验证 → 出报告
#
# 你只需要：
#   1) 把 graywind-<时间戳>.zip 传到桌面
#   2) 解压（脚本会自己解，你也可以不管）
#   3) 跑：powershell -NoProfile -ExecutionPolicy Bypass -File run-all.ps1
#
# 它做的事：
#   ① 备份：桌面\复活 已经存在就改名成 复活.bak-<时间>，**绝不删**
#   ② 解包：桌面上的 graywind-*.zip 解到家目录\graywind（已有就改名备份，再解新的）
#   ③ 准备：revive\ 复制到 桌面\复活，把配置里的 YOUR_NAME 换成当前用户名
#   ④ 只读验证：verify-all（七段）+ verify-buttons（按钮表）+ 按钮9（check.cmd）
#   ⑤ 报告：桌面 run-all-<时间>.txt
#
# 不做的事（故意的）：
#   · 不清 cookie、不降级、不启动 DSH —— 那些会改机器状态，你来决定什么时候按
#   · 不删任何目录。备份一律用改名。

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$家 = $env:USERPROFILE
$桌面 = [Environment]::GetFolderPath('Desktop')
$用户 = $env:USERNAME
$无BOM = New-Object System.Text.UTF8Encoding($false)
$报告 = New-Object System.Collections.ArrayList
function 记($s) { [void]$报告.Add([string]$s); Write-Host $s }
function 标题($t) { 记 ''; 记 ('############ ' + $t + ' ############') }

标题 '① 备份（改名，不删）'
$复活 = Join-Path $桌面 '复活'
if (Test-Path $复活) {
  $备份 = $复活 + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  # Move 失败最常见的原因：有进程把这个目录当「当前目录」——比如挂在那儿没人按的复活菜单
  # （revive.cmd → revive.ps1 是交互菜单，双击后没人按就一直占着，而且是隐藏窗口）。
  # 这**不致命**：③ 会把文件整份覆盖进去。但**必须说出来**。
  # 静默当成改名成功，下一个人就以为备份在——2026-11-02 本机真撞上：这一行报了
  # 「已改名备份」，⑦ 汇总却是「备份数量：0」，目录原地没动。报成功 ≠ 真成功。
  $改好了 = $false
  for ($i = 1; $i -le 3; $i++) {
    try { Move-Item $复活 $备份 -Force -ErrorAction Stop; $改好了 = $true; break }
    catch { Start-Sleep -Milliseconds 400 }
  }
  if ($改好了 -and -not (Test-Path $复活)) {
    记 ('已改名备份：' + (Split-Path $备份 -Leaf))
  } else {
    记 '!! 桌面\复活 改名失败（有进程占着这个目录），改为原地覆盖：旧的多余文件会留着'
  }
} else {
  记 '桌面\复活 本来就不存在，跳过'
}

标题 '② 解包'
$仓库 = Join-Path $家 'graywind'
$zip = Get-ChildItem $桌面 -Filter 'graywind-*.zip' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $zip) { 记 '!! 桌面上没有 graywind-*.zip，停'; exit 1 }
# 仓库已存在时：**改名备份，然后解压新的**。
# 2026-11-02 的教训：原来写"已存在就跳过"，结果拿旧仓库去验，
# 旧 check.cmd（含中文注释）静默失败，白跑一轮。
if (Test-Path $仓库) {
  $旧备 = $仓库 + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  # 这一处失败**必须停**：继续下去又是「拿旧仓库里的旧脚本去验」，
  # 正是这个 bug 当初的样子。备份侧可以容忍残留，代码侧不能。
  $改好了 = $false
  for ($i = 1; $i -le 3; $i++) {
    try { Move-Item $仓库 $旧备 -Force -ErrorAction Stop; $改好了 = $true; break }
    catch { Start-Sleep -Milliseconds 400 }
  }
  if (-not $改好了 -or (Test-Path $仓库)) {
    记 ('!! 旧仓库改名失败（' + $仓库 + ' 有进程占着），停——不然又拿旧脚本去验'); exit 1
  }
  记 ('旧仓库已改名：' + (Split-Path $旧备 -Leaf))
}
记 ('用这个包：' + $zip.Name)
Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip.FullName, $仓库, [System.Text.Encoding]::UTF8)
  记 '解包完成'
} catch { 记 ('!! 解包失败：' + $_.Exception.Message); exit 1 }
记 ('中文名检查：' + (Test-Path (Join-Path $仓库 'digest\消化.mjs')))

标题 '③ 准备复活包'
$源 = Join-Path $仓库 'revive'
if (-not (Test-Path $源)) { 记 '!! 仓库里没有 revive，停'; exit 1 }
New-Item -ItemType Directory $复活 -Force | Out-Null
Copy-Item (Join-Path $源 '*') $复活 -Recurse -Force
记 ('已复制到：' + $复活)

$cfgPath = Join-Path $复活 'revive-config.json'
$原文 = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText($cfgPath, $原文.Replace('YOUR_NAME', $用户), $无BOM)
记 ('配置已改：YOUR_NAME → ' + $用户)

标题 '④ 七段验证'
$va = Join-Path $仓库 'verify-all.ps1'
if (Test-Path $va) { & $va -Config $cfgPath *>&1 | ForEach-Object { 记 ([string]$_) } } else { 记 '找不到 verify-all.ps1' }

标题 '⑤ 按钮表'
$vb = Join-Path $仓库 'verify-buttons.ps1'
if (Test-Path $vb) { & $vb -Config $cfgPath *>&1 | ForEach-Object { 记 ([string]$_) } } else { 记 '找不到 verify-buttons.ps1' }

标题 '⑥ 按钮9（只读：扫历史会话）'
$ck = Join-Path $复活 'stallguard\check.cmd'
if (Test-Path $ck) {
  $o = $null | cmd /c "`"$ck`"" 2>&1 | Out-String
  foreach ($l in (($o -split "`n") | Where-Object { $_.Trim() } | Select-Object -First 8)) { 记 ('  ' + $l.Trim()) }
} else { 记 '找不到 check.cmd' }

标题 '⑦ 汇总'
$备份们 = @(Get-ChildItem $桌面 -Directory -Filter '复活.bak-*' -ErrorAction SilentlyContinue)
记 ('备份数量：' + $备份们.Count + '（都在这儿，没删）')
foreach ($b in $备份们) { 记 ('  ' + $b.Name) }
记 ''
记 '没做的事：清 cookie / 降级 / 启动 DSH —— 那些会改机器状态，等你另外说。'
记 '报告结束。'

$out = Join-Path $桌面 ('run-all-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
[System.IO.File]::WriteAllText($out, ($报告 -join "`r`n"), $无BOM)
Write-Host ''
Write-Host ('报告写到: ' + $out)
