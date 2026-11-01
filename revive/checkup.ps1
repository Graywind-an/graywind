# =============================================================================
# 复活体检 checkup.ps1   ·   9 项固定编号：00 ~ 08（顺序不许改，加项只能往后加）
#
# 用法：
#   checkup.ps1                    只体检，出报告（不动任何文件）
#   checkup.ps1 -Fix 02            只修第 02 项
#   checkup.ps1 -Fix 01,02         修 01 和 02
#   checkup.ps1 -Restore -Yes      修所有能修的（01 02 06 07）
#   checkup.ps1 ... -Overwrite     连「内容不同」的也覆盖（覆盖前备份）
#   checkup.ps1 ... -NoPause       不停下来等回车（给别的脚本调用）
#   checkup.ps1 -Config x.json     换一份配置（默认同目录 revive-config.json）
#
# 三条硬规矩：
#   1) 每项独立 try/catch —— 一项炸了不影响别的项
#   2) 修之前先备份到 _修前备份\<时间>\<编号>\
#   3) 只修「缺失」，不动「内容不同」的 —— 要覆盖必须显式 -Overwrite
#
# 本文件必须带 UTF-8 BOM（不带的话中文会乱码，脚本可能直接起不来）。
# =============================================================================

param(
  [string[]]$Fix = @(),
  [switch]$Restore,
  [switch]$Yes,
  [switch]$Overwrite,
  [switch]$NoPause,
  [string]$Config = ''
)

$ErrorActionPreference = 'Continue'
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $here ('_修前备份\' + $stamp)
$script:backupUsed = $false
$script:rows = New-Object System.Collections.ArrayList

# ---------------------------------------------------------------- 小工具 ----
function Expand-P([string]$s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  $t = [Environment]::ExpandEnvironmentVariables($s.Trim())
  if ($t -eq '~') { return $env:USERPROFILE }
  if ($t.StartsWith('~\') -or $t.StartsWith('~/')) { $t = Join-Path $env:USERPROFILE $t.Substring(2) }
  return $t
}

# 配置里还是示例路径（YOUR_NAME / <你的用户>）？
# 是的话，"找不到文件"不是"文件丢了"，而是"还没改配置"——这两件事必须分开报，
# 否则别人第一次拿到会以为自己的受保护文件真没了。
function Test-占位符([string]$s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return $false }
  return ($s -match 'YOUR_NAME' -or $s -match '<[^>]{1,20}>' -or $s -match '你的用户')
}
# 路径找不到时自动换盘符（和 revive.ps1 一样：本机的路径拷到别的机器也能用）
function Resolve-Real([string]$p) {
  $p = Expand-P $p
  if (-not $p) { return $null }
  try { if (Test-Path -LiteralPath $p) { return (Get-Item -LiteralPath $p -Force).FullName } } catch { }
  if ($p -match '^[A-Za-z]:\\') {
    $tail = $p.Substring(3)
    foreach ($d in @('C', 'D', 'E', 'F', 'G', 'H', 'I', 'J')) {
      $try = ('{0}:\{1}' -f $d, $tail)
      try { if (Test-Path -LiteralPath $try) { return (Get-Item -LiteralPath $try -Force).FullName } } catch { }
    }
  }
  return $null
}

function Get-Cfg($obj, [string]$name, $default) {
  if ($obj) {
    try {
      if ($obj.PSObject.Properties[$name]) {
        $v = $obj.$name
        if ($null -ne $v -and "$v" -ne '') { return $v }
      }
    } catch { }
  }
  return $default
}

function First-Existing([string[]]$paths) {
  foreach ($p in $paths) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  return $null
}

function Find-OnDrives([string]$rel) {
  foreach ($drv in @('C:\', 'D:\', 'E:\', 'F:\', 'G:\', 'H:\', 'I:\', 'J:\')) {
    if (-not (Test-Path -LiteralPath $drv)) { continue }
    $try = Join-Path $drv $rel
    if (Test-Path -LiteralPath $try) { return $try }
  }
  return $null
}

function Add-Row {
  param([string]$no, [string]$item, [string]$level, [string]$now, [string]$note = '', [string]$fixable = '-')
  [void]$script:rows.Add([pscustomobject]@{
      编号 = $no; 项 = $item; 级别 = $level; 现状 = $now; 说明 = $note; 可修 = $fixable
    })
}

# 每项都从这里走：炸了也只坏这一项
function Check-Item {
  param([string]$no, [string]$item, [scriptblock]$body)
  try {
    & $body
  } catch {
    Add-Row $no $item '异常' ('检查本身出错：' + $_.Exception.Message) '这一项没查成，别的项不受影响；先看这条错误再往下' '-'
  }
}

function Backup-Into([string]$no, [string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $dir = Join-Path $backupRoot $no
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $leaf = Split-Path $path -Leaf
  $dst = Join-Path $dir $leaf
  if (Test-Path -LiteralPath $dst) { $dst = Join-Path $dir ($leaf + '-' + (Get-Date -Format 'HHmmss-fff')) }
  Copy-Item -LiteralPath $path -Destination $dst -Recurse -Force -ErrorAction Stop
  $script:backupUsed = $true
  return $dst
}

function Level-Color([string]$lv) {
  switch ($lv) {
    '正常' { return 'Green' }
    '注意' { return 'Yellow' }
    '异常' { return 'Red' }
    '致命' { return 'Magenta' }
    default { return 'Gray' }
  }
}

# ---------------------------------------------------------------- 读配置 ----
$cfgPath = if ($Config) { $Config } else { Join-Path $here 'revive-config.json' }
$cfg = $null
if (Test-Path -LiteralPath $cfgPath) {
  try { $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { Write-Host ('  ! 配置读不出来：' + $_.Exception.Message) -ForegroundColor Red }
} else {
  Write-Host ('  ! 没有配置文件：' + $cfgPath + '（下面按默认路径查）') -ForegroundColor Yellow
}
$P = Get-Cfg $cfg '路径' $null

$dshHome = First-Existing @((Expand-P (Get-Cfg $P 'DSH目录' '')), (Expand-P $env:DSH_HOME), (Join-Path $env:USERPROFILE '.dsh'))
if (-not $dshHome) { $dshHome = Join-Path $env:USERPROFILE '.dsh' }

$appDir = First-Existing @(
  (Expand-P (Get-Cfg $P '程序目录' '')),
  (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
  (Join-Path $env:ProgramFiles 'DeepSeek Harness'))
if (-not $appDir) { $appDir = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness' }

$ws = First-Existing @(
  (Expand-P (Get-Cfg $P '工作区' '')),
  (Join-Path $env:USERPROFILE 'Documents\deepseek-harness\default-workspace'))
if (-not $ws) { $ws = $PWD.Path }

$mirror = First-Existing @((Expand-P (Get-Cfg $P '镜像目录' '')))
if (-not $mirror) { $mirror = Find-OnDrives '复活镜像' }

$pure = First-Existing @((Expand-P (Get-Cfg $P '纯净区目录' '')))
if (-not $pure) {
  foreach ($drv in @('C:\', 'D:\', 'E:\', 'F:\', 'G:\', 'H:\')) {
    if (-not (Test-Path -LiteralPath $drv)) { continue }
    $try = Join-Path $drv 'dsh-sandbox\纯净'
    if (Test-Path -LiteralPath $try) { $pure = $try; break }
  }
}

# 底线版：主机和镜像都起不来时用的那一份（自带程序 + 最小配置）。
# 05 检查的是它，不是上面那个纯净区——纯净区是虚拟盘试验用的，救不了命。
$baseline = First-Existing @((Expand-P (Get-Cfg $P '底线目录' '')))
if (-not $baseline) { $baseline = Find-OnDrives '复活底线' }

$logDir = First-Existing @(
  (Expand-P (Get-Cfg $cfg '崩溃日志' '')),
  (Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop\logs'))
if (-not $logDir) { $logDir = Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop\logs' }

$zone = Expand-P (Get-Cfg $cfg '保护区' (Join-Path $here '保护区'))
if (-not $zone) { $zone = Join-Path $here '保护区' }

# 受保护的文件：配置里的原样，相对路径按工作区展开
$script:protCfg = @(Get-Cfg $cfg '受保护的文件' @())
if ($script:protCfg.Count -eq 0) { $script:protCfg = @('CORE.md', 'AGENTS.md', 'JUDGMENT.md', 'WORLD.md', 'memory') }
$script:protItems = @()
# 每次体检/修补前重算一遍：刚补回来的文件要立刻认得，不能吃启动那一刻的旧账
function Update-ProtItems {
  $script:protItems = @()
  foreach ($f in $script:protCfg) {
    $raw = [string]$f
    $p = $raw
    if ($p -notmatch '^[A-Za-z]:\\' -and -not $p.StartsWith('\\')) { $p = Join-Path $ws $p }
    $script:protItems += [pscustomobject]@{ 配置 = $raw; 路径 = $p; 实际 = (Resolve-Real $p) }
  }
}
Update-ProtItems

# ---------------------------------------------------------------- 体检 ------
function Invoke-Checkup {
  $script:rows = New-Object System.Collections.ArrayList
  Update-ProtItems

  # ---- 00 DSH 进程：只报告 ----
  Check-Item '00' 'DSH 进程' {
    $procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) {
      Add-Row '00' 'DSH 进程' '注意' '没在跑（0 个进程）' '可能只是没打开；如果是点了图标没反应，去看 03 崩溃日志和 01 程序本体' '-'
    }
    else {
      $starts = @()
      foreach ($pr in $procs) { try { if ($pr.StartTime) { $starts += $pr.StartTime } } catch { } }
      $t = if ($starts.Count -gt 0) { ($starts | Sort-Object | Select-Object -First 1).ToString('yyyy-MM-dd HH:mm:ss') } else { '读不到' }
      Add-Row '00' 'DSH 进程' '正常' ('在跑：{0} 个进程，最早一个 {1} 启动' -f $procs.Count, $t) '进程在 = 壳活着，不等于界面正常（界面对不对看 03）' '-'
    }
  }

  # ---- 01 程序本体：修 = 从镜像复制回来 ----
  Check-Item '01' '程序本体' {
    $asar = Join-Path $appDir 'resources\app.asar'
    if (-not (Test-Path -LiteralPath $asar)) {
      Add-Row '01' '程序本体' '致命' ('app.asar 不见了：' + $asar) 'DSH 一定起不来。用 -Fix 01 从镜像复制回来' '01'
      return
    }
    $it = Get-Item -LiteralPath $asar -Force
    $mb = [math]::Round($it.Length / 1MB, 1)
    if ($mb -lt 50) {
      Add-Row '01' '程序本体' '异常' ('app.asar 只有 ' + $mb + ' MB（正常约 180 MB）') '像被截断/换过。要覆盖得加 -Overwrite（会先备份）' '01+Overwrite'
    }
    else {
      Add-Row '01' '程序本体' '正常' ('app.asar 在，' + $mb + ' MB，改于 ' + $it.LastWriteTime.ToString('yyyy-MM-dd HH:mm')) '大小正常只说明文件完整，不说明版本对不对' '-'
    }
  }

  # ---- 02 profile 配置：修 = 从镜像 dsh-home\profiles 复制回来 ----
  Check-Item '02' 'profile 配置' {
    $prof = Join-Path $dshHome 'profiles\desktop'
    $pkg = Join-Path $prof 'package.json'
    $yml = Join-Path $prof 'cordis.patch.yml'
    $pkgOk = Test-Path -LiteralPath $pkg
    $ymlOk = Test-Path -LiteralPath $yml
    $bundles = -1
    if ($pkgOk) {
      try {
        $j = Get-Content -LiteralPath $pkg -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($j.dsh -and $j.dsh.profile -and $null -ne $j.dsh.profile.bundles) { $bundles = @($j.dsh.profile.bundles).Count }
        else { $bundles = 0 }
      } catch { $bundles = -2 }
    }
    if (-not $pkgOk) {
      Add-Row '02' 'profile 配置' '致命' ('缺 package.json：' + $pkg) 'profile 没了 DSH 起不来。用 -Fix 02 从镜像复制回来' '02'
      return
    }
    if ($bundles -eq -2) {
      Add-Row '02' 'profile 配置' '异常' 'package.json 解析不了（JSON 坏了）' '内容坏了不算缺失，-Fix 02 不会动；确认要换加 -Overwrite（会先备份）' '02+Overwrite'
      return
    }
    if (-not $ymlOk) {
      Add-Row '02' 'profile 配置' '异常' ('缺 cordis.patch.yml；bundles ' + $bundles + ' 个') '插件配置全丢，界面会像换了个新的。用 -Fix 02 从镜像补回来' '02'
      return
    }
    if ($bundles -eq 0) {
      Add-Row '02' 'profile 配置' '异常' 'package.json 里 bundles 是空的（0 个）' '没有 bundle = 装了个空壳。要换加 -Overwrite（会先备份）' '02+Overwrite'
      return
    }
    Add-Row '02' 'profile 配置' '正常' ('package.json 在，cordis.patch.yml 在，bundles ' + $bundles + ' 个') '配置齐了只说明列得出来，能不能加载看启动' '-'
  }

  # ---- 03 崩溃日志：只报告 ----
  Check-Item '03' '崩溃日志' {
    if (-not (Test-Path -LiteralPath $logDir)) {
      Add-Row '03' '崩溃日志' '注意' ('日志目录还不存在：' + $logDir) '从没崩过，或者 DSH 没在这台机器跑过。不是问题' '-'
      return
    }
    $crash = @(Get-ChildItem -LiteralPath $logDir -Filter 'crash-*.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if ($crash.Count -eq 0) {
      Add-Row '03' '崩溃日志' '正常' ('目录在，0 份 crash：' + $logDir) '没有崩溃记录' '-'
      return
    }
    $latest = $crash[0]
    $ageDays = [math]::Round(((Get-Date) - $latest.LastWriteTime).TotalDays, 1)
    $head = ''
    try {
      $txt = @(Get-Content -LiteralPath $latest.FullName -TotalCount 4 -Encoding UTF8 -ErrorAction Stop)
      foreach ($ln in $txt) { if ($ln -and $ln.Trim() -ne '' -and $ln -notmatch '[\x00-\x08]') { $head = $ln.Trim(); break } }
      if ($head.Length -gt 90) { $head = $head.Substring(0, 90) + '…' }
    } catch { $head = '' }
    $now = ('{0} 份 crash；最新 {1}（{2} 天前，{3} 字节）' -f $crash.Count, $latest.LastWriteTime.ToString('yyyy-MM-dd HH:mm'), $ageDays, $latest.Length)
    if ($head) { $now = $now + '；开头：' + $head }
    if ($ageDays -le 7) {
      Add-Row '03' '崩溃日志' '异常' $now '最近 7 天崩过。对崩溃原因清单看是哪一类（cookie 撑爆 / 插件 export / bundle / 升级 / GPU）' '-'
    }
    else {
      Add-Row '03' '崩溃日志' '注意' $now '旧崩溃，不是今天的病。但要是现在起不来，先看 01 / 02' '-'
    }
  }

  # ---- 04 镜像：只报告 ----
  Check-Item '04' '镜像' {
    if (-not $mirror -or -not (Test-Path -LiteralPath $mirror)) {
      Add-Row '04' '镜像' '异常' '找不到镜像目录（复活镜像）' '没有镜像 = 01/02 修不了，也没有「镜像反修」那条路。先把镜像盘接上或重新拷一份' '-'
      return
    }
    $mirAsar = First-Existing @(
      (Join-Path $mirror 'app\resources\app.asar'),
      (Join-Path $mirror 'resources\app.asar'),
      (Join-Path $mirror 'app.asar'))
    $mirProf = First-Existing @((Join-Path $mirror 'dsh-home\profiles'), (Join-Path $mirror 'profiles'))
    $mirWs = First-Existing @((Join-Path $mirror 'ws'))
    $miss = @()
    if (-not $mirAsar) { $miss += 'app.asar' }
    if (-not $mirProf) { $miss += 'profiles' }
    if (-not $mirWs) { $miss += '工作区' }
    if ($miss.Count -eq 0) {
      $mmb = [math]::Round((Get-Item -LiteralPath $mirAsar -Force).Length / 1MB, 1)
      Add-Row '04' '镜像' '正常' ('在：' + $mirror + '；app.asar ' + $mmb + ' MB，profiles 和 工作区 都在') '镜像旧才是它的用处——别同步成最新' '-'
    }
    else {
      Add-Row '04' '镜像' '注意' ('在：' + $mirror + '；缺 ' + ($miss -join '、')) '缺件的那部分修不回来。缺 app.asar 要马上补（01 只能靠它）' '-'
    }
  }

  # ---- 05 底线版：只报告（真正「都起不来」时用的那一份） ----
  Check-Item '05' '底线版' {
    if (-not $baseline -or -not (Test-Path -LiteralPath $baseline)) {
      Add-Row '05' '底线版' '注意' '底线版还没有（或路径不对）' '底线版是「主机和镜像都起不来」时的最后手段。没有它不影响现在修' '-'
      return
    }
    $bExe = Join-Path $baseline 'app\DeepSeek Harness.exe'
    $bProf = Join-Path $baseline 'dsh-home\profiles\desktop'
    if (-not (Test-Path -LiteralPath $bExe)) {
      Add-Row '05' '底线版' '致命' ('底线版里没有程序：' + $bExe) '没有程序就开不起来——它不是最后手段，只是个空目录。从镜像的 app 整份复制过来' '-'
      return
    }
    if (-not (Test-Path -LiteralPath $bProf)) {
      Add-Row '05' '底线版' '异常' ('有程序，但没有 profile：' + $bProf) '少了 profile 起不来。把 profiles\desktop 整份复制进去' '-'
      return
    }
    $bNm = Join-Path $bProf 'node_modules\@deepseek-ai'
    $bPkg = Join-Path $bProf 'package.json'
    $bPat = Join-Path $bProf 'cordis.patch.yml'
    $bMiss = @()
    if (-not (Test-Path -LiteralPath $bNm)) { $bMiss += '@deepseek-ai 依赖' }
    if (-not (Test-Path -LiteralPath $bPkg)) { $bMiss += 'package.json' }
    if (-not (Test-Path -LiteralPath $bPat)) { $bMiss += 'cordis.patch.yml' }
    $bExeMb = [math]::Round((Get-Item -LiteralPath $bExe).Length / 1MB, 1)
    if ($bMiss.Count -gt 0) {
      Add-Row '05' '底线版' '异常' ('程序在（' + $bExeMb + ' MB），但 profile 缺：' + ($bMiss -join '、')) '缺这些就起不来。整份 profiles\desktop 复制一遍最省事' '-'
      return
    }
    # 判据：patch 该是最小那份（约 800 B）。它一变大，说明底线又背上了主机的插件配置，
    # 主机因插件崩的时候它跟着崩——那就不叫底线了。
    $bPatB = (Get-Item -LiteralPath $bPat).Length
    if ($bPatB -gt 5000) {
      Add-Row '05' '底线版' '注意' ('程序 ' + $bExeMb + ' MB，依赖齐，但 patch 有 ' + $bPatB + ' B') 'patch 该是最小那份（约 800 B）。这么大 = 它又背上了主机的插件配置，主机因插件崩时它跟着崩。要换回最小配置' '-'
      return
    }
    Add-Row '05' '底线版' '正常' ('程序 ' + $bExeMb + ' MB，profile 依赖齐，patch ' + $bPatB + ' B（最小配置）') '能开的前提齐了。注意：主机 DSH 还开着时它起不来（单实例锁），这是正常的' '-'
  }

  # ---- 06 受保护文件：修 = 从保护区复制回来 ----
  Check-Item '06' '受保护文件' {
    $占位06 = @($protItems | Where-Object { Test-占位符 $_.配置 })
    if ($占位06.Count -gt 0 -and $占位06.Count -eq $protItems.Count) {
      Add-Row '06' '受保护文件' '注意' ('配置里还是示例路径（YOUR_NAME），不是真的缺文件：' + $protItems.Count + ' 项全部没解析出来') '先改 revive-config.json：把 YOUR_NAME 换成你的 Windows 用户名（多用户再先把 X: 换成你的盘）' '-'
      return
    }
    if ($protItems.Count -eq 0) {
      Add-Row '06' '受保护文件' '注意' '配置里没有「受保护的文件」清单' '在 revive-config.json 的「受保护的文件」里填路径（相对工作区的文件名也行）' '-'
      return
    }
    $miss = @(); $empty = @()
    foreach ($it in $protItems) {
      if (-not $it.实际) { $miss += $it; continue }
      try {
        $f = Get-Item -LiteralPath $it.实际 -Force -ErrorAction Stop
        if (-not $f.PSIsContainer -and $f.Length -eq 0) { $empty += $it }
      } catch { $miss += $it }
    }
    if ($miss.Count -eq 0 -and $empty.Count -eq 0) {
      Add-Row '06' '受保护文件' '正常' ('{0} 项都在，没有 0 字节的' -f $protItems.Count) '在只说明文件在，内容对不对看保护区（07）' '-'
    }
    else {
      $soul = @('CORE.md', 'AGENTS.md', 'JUDGMENT.md', 'WORLD.md')
      $soulMiss = @($miss | Where-Object { $soul -contains (Split-Path $_.路径 -Leaf) })
      $names = @()
      foreach ($m in $miss) { $names += (Split-Path $m.路径 -Leaf) }
      foreach ($e in $empty) { $names += ((Split-Path $e.路径 -Leaf) + '(0字节)') }
      $lvl = if ($soulMiss.Count -gt 0) { '致命' } else { '异常' }
      Add-Row '06' '受保护文件' $lvl ('缺 ' + $miss.Count + ' 项、空 ' + $empty.Count + ' 项：' + ($names -join '、')) '用 -Fix 06 从保护区补回来（保护区没有就从镜像工作区补）' '06'
    }
  }

  # ---- 07 保护区：修 = 重新同步 ----
  Check-Item '07' '保护区' {
    if (Test-占位符 $zone) {
      Add-Row '07' '保护区' '注意' ('配置里的保护区还是示例路径：' + $zone) '先改 revive-config.json，把 YOUR_NAME 换成你的 Windows 用户名' '-'
      return
    }
    if (-not (Test-Path -LiteralPath $zone)) {
      Add-Row '07' '保护区' '异常' ('保护区目录不存在：' + $zone) '保护区 = 受保护文件的副本，DSH 坏了从这里拿回来。-Fix 07 建它并同步' '07'
      return
    }
    $miss = @(); $stale = @(); $dirCount = 0; $checked = 0
    foreach ($it in $protItems) {
      if (-not $it.实际) { continue }
      $checked++
      $leaf = Split-Path $it.实际 -Leaf
      $copy = Join-Path $zone $leaf
      if (-not (Test-Path -LiteralPath $copy)) { $miss += $leaf; continue }
      try {
        $s = Get-Item -LiteralPath $it.实际 -Force -ErrorAction Stop
        $d = Get-Item -LiteralPath $copy -Force -ErrorAction Stop
        if ($s.PSIsContainer -or $d.PSIsContainer) {
          if ($s.PSIsContainer -ne $d.PSIsContainer) { $miss += ($leaf + '(类型不对)') } else { $dirCount++ }
        }
        else {
          if ($s.Length -ne $d.Length -or $s.LastWriteTime -gt $d.LastWriteTime.AddSeconds(2)) { $stale += $leaf }
        }
      } catch { $miss += ($leaf + '(读不了)') }
    }
    if ($checked -eq 0) {
      Add-Row '07' '保护区' '注意' '没有可比的源文件（受保护的文件一个都不在）' '先修 06，再回来同步保护区' '-'
      return
    }
    if ($miss.Count -gt 0) {
      Add-Row '07' '保护区' '异常' ('保护区缺 ' + $miss.Count + ' 项：' + ($miss -join '、')) '保护区没同步 = 真出事时拿不到那份。用 -Fix 07 重新同步' '07'
      return
    }
    if ($stale.Count -gt 0) {
      Add-Row '07' '保护区' '注意' ('保护区有 ' + $stale.Count + ' 项比源文件旧：' + ($stale -join '、')) '保护区是旧拷贝（可能是故意的）。要按现在的源文件刷新用 -Fix 07' '07'
      return
    }
    Add-Row '07' '保护区' '正常' ('{0} 项都在，和源文件大小一致' -f $checked) ('其中有 ' + $dirCount + ' 项是目录，只比了在不在') '-'
  }

  # ---- 08 纯净区：只报告（虚拟盘试验用的那份 DSH_HOME，不是最后手段） ----
  # 最后手段是 05 底线版。这一项管的是「能不能模拟重启 / 复现问题」，
  # 它坏了不影响救火，只影响我平时排查。
  Check-Item '08' '纯净区' {
    if (-not $pure -or -not (Test-Path -LiteralPath $pure)) {
      Add-Row '08' '纯净区' '注意' '纯净目录还没有（或路径不对）' '纯净区是虚拟盘试验用的 DSH_HOME。没有它不影响复活，只影响模拟重启' '-'
      return
    }
    $pureProfDir = Join-Path $pure 'profiles'
    if (-not (Test-Path -LiteralPath $pureProfDir)) {
      Add-Row '08' '纯净区' '异常' ('纯净区在，但没有 profiles：' + $pure) '少了 profiles 就是空壳，模拟不了重启' '-'
      return
    }
    $pureProfs = @(Get-ChildItem -LiteralPath $pureProfDir -Directory -ErrorAction SilentlyContinue)
    if ($pureProfs.Count -eq 0) {
      Add-Row '08' '纯净区' '异常' ('里面一个 profile 都没有：' + $pureProfDir) '空目录起不来。要从主机的 profiles 复制进去' '-'
      return
    }
    $pureWithNm = @($pureProfs | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'node_modules') })
    $pureDshNm = @($pureWithNm | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'node_modules\@deepseek-ai') })
    # 假模型那一层：没有它，虚拟盘跑起来会去调真 API、花真钱——这是虚拟盘唯一不能省的东西
    $fakeNote = if (Test-Path -LiteralPath (Join-Path $pure 'patch-fake.yml')) { '假模型 patch 在' } else { '没有 patch-fake.yml：真跑起来会去调真 API、花真钱' }
    if ($pureWithNm.Count -eq 0) {
      Add-Row '08' '纯净区' '异常' ('{0} 个 profile，但都没有 node_modules' -f $pureProfs.Count) ('依赖没装 = 起不来。' + $fakeNote) '-'
    }
    elseif ($pureDshNm.Count -eq 0) {
      Add-Row '08' '纯净区' '注意' ('{0} 个 profile 有 node_modules，但都没有 @deepseek-ai' -f $pureWithNm.Count) ('缺 DSH 自己的包就起不来。' + $fakeNote) '-'
    }
    else {
      Add-Row '08' '纯净区' '正常' ('{0} 个 profile，其中 {1} 个依赖齐' -f $pureProfs.Count, $pureDshNm.Count) $fakeNote '-'
    }
  }

  return $script:rows
}

# ---------------------------------------------------------------- 修补 ------
function Fix-01 {
  $target = Join-Path $appDir 'resources\app.asar'
  if (-not $mirror) { Write-Host '  [停] 没有镜像，01 无从修——先把镜像盘接上。' -ForegroundColor Red; return $false }
  $src = First-Existing @(
    (Join-Path $mirror 'app\resources\app.asar'),
    (Join-Path $mirror 'resources\app.asar'),
    (Join-Path $mirror 'app.asar'))
  if (-not $src) { Write-Host ('  [停] 镜像里也没有 app.asar：' + $mirror) -ForegroundColor Red; return $false }
  if (Test-Path -LiteralPath $target) {
    $mb = [math]::Round((Get-Item -LiteralPath $target -Force).Length / 1MB, 1)
    if ($mb -ge 50 -and -not $Overwrite) {
      Write-Host ('  [跳] app.asar 在、大小正常（' + $mb + ' MB）——只修缺失，不动内容。要强制覆盖加 -Overwrite。') -ForegroundColor Yellow
      return $false
    }
    if (-not $Overwrite) {
      Write-Host ('  [跳] app.asar 不正常（' + $mb + ' MB）但文件在——覆盖要加 -Overwrite（会先备份）。') -ForegroundColor Yellow
      return $false
    }
    $bk = Backup-Into '01' $target
    Write-Host ('  备份旧件：' + $bk) -ForegroundColor DarkGray
  }
  else {
    New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
  }
  Write-Host ('  复制：' + $src) -ForegroundColor Green
  Write-Host ('     -> ' + $target) -ForegroundColor Green
  Copy-Item -LiteralPath $src -Destination $target -Force -ErrorAction Stop
  if (-not (Test-Path -LiteralPath $target)) { Write-Host '  [错] 复制完还是找不到文件' -ForegroundColor Red; return $false }
  $mb2 = [math]::Round((Get-Item -LiteralPath $target -Force).Length / 1MB, 1)
  Write-Host ('  完成：app.asar ' + $mb2 + ' MB') -ForegroundColor Green
  return $true
}

function Fix-02 {
  if (-not $mirror) { Write-Host '  [停] 没有镜像，02 无从修。' -ForegroundColor Red; return $false }
  $msrc = First-Existing @((Join-Path $mirror 'dsh-home\profiles\desktop'), (Join-Path $mirror 'profiles\desktop'))
  if (-not $msrc) { Write-Host ('  [停] 镜像里没有 profiles\desktop：' + $mirror) -ForegroundColor Red; return $false }
  $dst = Join-Path $dshHome 'profiles\desktop'
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  $changed = $false
  foreach ($f in @('package.json', 'cordis.patch.yml')) {
    $s = Join-Path $msrc $f
    $d = Join-Path $dst $f
    if (-not (Test-Path -LiteralPath $s)) { Write-Host ('  [跳] 镜像里没有 ' + $f) -ForegroundColor Yellow; continue }
    if ((Test-Path -LiteralPath $d) -and -not $Overwrite) {
      Write-Host ('  [跳] ' + $f + ' 已在——只修缺失，不动内容（要覆盖加 -Overwrite）') -ForegroundColor Yellow
      continue
    }
    if (Test-Path -LiteralPath $d) {
      $bk = Backup-Into '02' $d
      Write-Host ('  备份旧件：' + $bk) -ForegroundColor DarkGray
    }
    Copy-Item -LiteralPath $s -Destination $d -Force -ErrorAction Stop
    Write-Host ('  复制：' + $f + '  <-  ' + $s) -ForegroundColor Green
    $changed = $true
  }
  if (-not $changed) { Write-Host '  没写任何文件。' -ForegroundColor DarkGray }
  return $changed
}

function Fix-06 {
  $restored = 0
  foreach ($it in $protItems) {
    if ($it.实际) { continue }
    $leaf = Split-Path $it.路径 -Leaf
    $cand = @()
    $cand += (Join-Path $zone $leaf)
    if ($mirror) { $cand += (Join-Path $mirror ('ws\' + $leaf)) }
    $src = First-Existing $cand
    if (-not $src) {
      Write-Host ('  [停] ' + $leaf + ' 在保护区和镜像里都没有，补不回来') -ForegroundColor Red
      continue
    }
    $parent = Split-Path $it.路径 -Parent
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item -LiteralPath $src -Destination $it.路径 -Recurse -Force -ErrorAction Stop
    Write-Host ('  补回：' + $it.路径) -ForegroundColor Green
    Write-Host ('     <- ' + $src) -ForegroundColor DarkGray
    $restored++
  }
  Write-Host ('  共补回 ' + $restored + ' 项') -ForegroundColor Green
  return ($restored -gt 0)
}

function Fix-07 {
  New-Item -ItemType Directory -Force -Path $zone | Out-Null
  $n = 0; $fail = 0
  foreach ($it in $protItems) {
    if (-not $it.实际) { continue }
    $leaf = Split-Path $it.实际 -Leaf
    $dst = Join-Path $zone $leaf
    try {
      if (Test-Path -LiteralPath $dst) {
        $bk = Backup-Into '07' $dst
        Write-Host ('  备份保护区旧件：' + $bk) -ForegroundColor DarkGray
      }
      Copy-Item -LiteralPath $it.实际 -Destination $dst -Recurse -Force -ErrorAction Stop
      Write-Host ('  同步：' + $leaf) -ForegroundColor Green
      $n++
    } catch {
      Write-Host ('  [错] ' + $leaf + '：' + $_.Exception.Message) -ForegroundColor Red
      $fail++
    }
  }
  Write-Host ('  同步 ' + $n + ' 项，失败 ' + $fail + ' 项') -ForegroundColor Green
  return ($n -gt 0)
}

function Invoke-Fix([string]$no) {
  Write-Host ''
  Write-Host ('  ==== 修 ' + $no + ' ====') -ForegroundColor Cyan
  Update-ProtItems
  switch ($no) {
    '01' { return (Fix-01) }
    '02' { return (Fix-02) }
    '06' { return (Fix-06) }
    '07' { return (Fix-07) }
    default {
      Write-Host ('  [' + $no + '] 这一项只报告，不能自动修。能修的只有：01 / 02 / 06 / 07') -ForegroundColor Yellow
      return $false
    }
  }
}

# ---------------------------------------------------------------- 出报告 ----
function Get-VerdictLine($rowList) {
  $f = @($rowList | Where-Object { $_.级别 -eq '致命' }).Count
  $b = @($rowList | Where-Object { $_.级别 -eq '异常' }).Count
  $w = @($rowList | Where-Object { $_.级别 -eq '注意' }).Count
  $ok = @($rowList | Where-Object { $_.级别 -eq '正常' }).Count
  if ($f -gt 0) { return ('致命 ' + $f + ' 项（正常 ' + $ok + ' / 注意 ' + $w + ' / 异常 ' + $b + '）') }
  if ($b -gt 0) { return ('异常 ' + $b + ' 项（正常 ' + $ok + ' / 注意 ' + $w + '）') }
  if ($w -gt 0) { return ('注意 ' + $w + ' 项，没有致命/异常（正常 ' + $ok + '）') }
  return ('全部正常（9 项）')
}

function Show-Rows($rowList) {
  foreach ($r in $rowList) {
    Write-Host ('  [' + $r.编号 + '] ' + $r.项 + ' ') -ForegroundColor White -NoNewline
    Write-Host ('···· ' + $r.级别) -ForegroundColor (Level-Color $r.级别)
    Write-Host ('       现状：' + $r.现状) -ForegroundColor Gray
    if ($r.说明) { Write-Host ('       ' + $r.说明) -ForegroundColor DarkGray }
    if ($r.可修 -and $r.可修 -ne '-') {
      $tail = if ($r.可修 -match 'Overwrite') { '  （内容不同，要覆盖加 -Overwrite）' } else { '' }
      Write-Host ('       能修：checkup.ps1 -Fix ' + $r.编号 + $tail) -ForegroundColor DarkCyan
    }
  }
}

function Write-Report($rowList) {
  $dir = Join-Path $here '体检报告'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $file = Join-Path $dir ('体检-' + $stamp + '.md')
  $md = @()
  $md += '# 复活体检报告 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
  $md += ''
  $md += '**结论：' + (Get-VerdictLine $rowList) + '**'
  $md += ''
  $md += '| 编号 | 项 | 级别 | 现状 | 说明 | 可修 |'
  $md += '|---|---|---|---|---|---|'
  foreach ($r in $rowList) {
    $md += ('| ' + $r.编号 + ' | ' + $r.项 + ' | ' + $r.级别 + ' | ' + $r.现状 + ' | ' + $r.说明 + ' | ' + $r.可修 + ' |')
  }
  $md += ''
  if ($script:cookieNote) { $md += '附注：' + $script:cookieNote; $md += '' }
  $mirrorTxt = if ($mirror) { $mirror } else { '（没找到）' }
  $md += '路径：程序目录 `' + $appDir + '` / DSH 目录 `' + $dshHome + '` / 工作区 `' + $ws + '` / 镜像 `' + $mirrorTxt + '` / 保护区 `' + $zone + '`'
  Set-Content -LiteralPath $file -Value ($md -join "`r`n") -Encoding UTF8
  return $file
}

# ---------------------------------------------------------------- 主流程 ----
Write-Host ''
Write-Host '  ==================================================' -ForegroundColor DarkCyan
Write-Host ('   复活体检   ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Cyan
Write-Host '  ==================================================' -ForegroundColor DarkCyan
Write-Host ('   程序目录  ' + $appDir) -ForegroundColor DarkGray
Write-Host ('   DSH 目录  ' + $dshHome) -ForegroundColor DarkGray
Write-Host ('   工作区    ' + $ws) -ForegroundColor DarkGray
Write-Host ('   镜像      ' + $(if ($mirror) { $mirror } else { '（没找到）' })) -ForegroundColor DarkGray
Write-Host ('   纯净区    ' + $(if ($pure) { $pure } else { '（没有）' }) + '   ← 虚拟盘试验用，不是最后手段') -ForegroundColor DarkGray
Write-Host ('   底线版    ' + $(if ($baseline) { $baseline } else { '（没有）' }) + '   ← 都起不来时用的那一份') -ForegroundColor DarkGray
Write-Host ('   保护区    ' + $zone) -ForegroundColor DarkGray
Write-Host ''

$rows = Invoke-Checkup
# 附注：cookie 大小。它不在 00~07 里（编号是死的），但这是最常见的一条死法，
# 所以每次体检顺手报一句——超 5 万字节就该清（崩溃原因清单第 1 条）。
$script:cookieNote = ''
try {
  $cookiePath = Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop\Network\Cookies'
  if (Test-Path -LiteralPath $cookiePath) {
    $cb = (Get-Item -LiteralPath $cookiePath -Force).Length
    if ($cb -ge 50000) { $script:cookieNote = ('Cookies ' + $cb + ' B —— 已超 5 万，随时可能撑爆请求头（清 cookie 见崩溃原因清单第 1 条）') }
    else { $script:cookieNote = ('Cookies ' + $cb + ' B（2 万左右 = 空库；超过 5 万就该清了）') }
  }
} catch { $script:cookieNote = '' }
Show-Rows $rows
$verdict = Get-VerdictLine $rows
$fatalN = @($rows | Where-Object { $_.级别 -eq '致命' }).Count
$vc = if ($fatalN -gt 0) { 'Magenta' } elseif (@($rows | Where-Object { $_.级别 -eq '异常' }).Count -gt 0) { 'Red' } elseif (@($rows | Where-Object { $_.级别 -eq '注意' }).Count -gt 0) { 'Yellow' } else { 'Green' }
Write-Host ''
Write-Host ('  ==== ' + $verdict + ' ====') -ForegroundColor $vc
if ($script:cookieNote) { Write-Host ('  附注：' + $script:cookieNote) -ForegroundColor DarkGray }
$reportFile = Write-Report $rows
Write-Host ('  报告：' + $reportFile) -ForegroundColor DarkGray

# ---- 要修哪些：-Fix 编号 / -Restore 全部可修 ----
$fixList = @()
if ($Restore) { $fixList = @('01', '02', '06', '07') }
foreach ($f in $Fix) {
  $f2 = ([string]$f).Trim()
  if ($f2 -match '^[0-9]$') { $f2 = '0' + $f2 }
  if ($f2 -notmatch '^0[0-7]$') { Write-Host ('  [跳] 没有编号 ' + $f) -ForegroundColor Yellow; continue }
  if ($fixList -notcontains $f2) { $fixList += $f2 }
}

if ($fixList.Count -gt 0) {
  Write-Host ''
  Write-Host ('  ---- 开始修：' + ($fixList -join ' ') + ' ----') -ForegroundColor Cyan
  $done = @()
  foreach ($no in $fixList) {
    try { if (Invoke-Fix $no) { $done += $no } } catch { Write-Host ('  [错] 修 ' + $no + ' 失败：' + $_.Exception.Message) -ForegroundColor Red }
  }
  Write-Host ''
  if ($done.Count -gt 0) {
    if ($script:backupUsed) { Write-Host ('  改过的文件备份在：' + $backupRoot) -ForegroundColor DarkGray }
    Write-Host ('  修了：' + ($done -join ' ') + '，复查一遍：') -ForegroundColor Cyan
    Write-Host ''
    $rows2 = Invoke-Checkup
    Show-Rows $rows2
    $verdict2 = Get-VerdictLine $rows2
    $fatal2 = @($rows2 | Where-Object { $_.级别 -eq '致命' }).Count
    $vc2 = if ($fatal2 -gt 0) { 'Magenta' } elseif (@($rows2 | Where-Object { $_.级别 -eq '异常' }).Count -gt 0) { 'Red' } elseif (@($rows2 | Where-Object { $_.级别 -eq '注意' }).Count -gt 0) { 'Yellow' } else { 'Green' }
    Write-Host ''
    Write-Host ('  ==== 修后：' + $verdict2 + ' ====') -ForegroundColor $vc2
    $rows = $rows2
  }
  else {
    Write-Host '  这次没有写任何文件（没有可修的东西，或者被「只修缺失」挡下）。' -ForegroundColor Yellow
  }
}

$fatalF = @($rows | Where-Object { $_.级别 -eq '致命' }).Count
$badF = @($rows | Where-Object { $_.级别 -eq '异常' }).Count
$code = if ($fatalF -gt 0) { 2 } elseif ($badF -gt 0) { 1 } else { 0 }
Write-Host ''
Write-Host ('  退出码：' + $code + '（0 正常 / 1 有异常 / 2 有致命）') -ForegroundColor DarkGray

if (-not $NoPause) {
  Write-Host ''
  Read-Host '  按回车关闭' | Out-Null
}
exit $code
