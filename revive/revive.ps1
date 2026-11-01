# 复活入口 · 人着急的时候判断力会下降，所以每个按钮自己说「什么时候按」
#
# 按钮表在 revive-config.json，加功能 = 加一行，不改这个脚本。
# 路径不写死：找不到时自动换盘符（C/D/E/F/G/H）。
# 保护：进来先同步保护区；标了「锁保护」的按钮（动别人机器那几条）先把受保护文件锁只读；按 00 解锁。
# 取保护区（5）：连崩溃日志一起复制到桌面。
# 体检（6）：只读报告；体检完问一句要不要补缺失。
# 按编码修（7XX）：702 / 706 这样——只修那一项，别的都不动。前缀和「哪些能修」在配置里写死。
# 启动：双击 复活.cmd
#
# 注意：按钮编号会漂（加一条就全往后挪）。所以脚本里任何地方都不许拿「键」当判据，
# 要按类型 / 要按字段——拿编号当判据的话，插一条新按钮就锁错对象。

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $here 'revive-config.json'

function Resolve-Target([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return $null }
  if (Test-Path -LiteralPath $p) { return $p }
  $tail = $p.Substring(3)
  foreach ($d in @('C','D','E','F','G','H')) {
    $try = ('{0}:\{1}' -f $d, $tail)
    if (Test-Path -LiteralPath $try) { return $try }
  }
  return $null
}

# 菜单文字里的 {镜像盘} / {底线盘} 换成这台机器实际的盘符。
# 为什么要有：配置里的按钮文字不写死盘符——复活包发给别人时，别人的镜像不一定在 E 盘。
function Resolve-Text([string]$t) {
  if ([string]::IsNullOrEmpty($t)) { return $t }
  $mirror = $cfg.'路径'.'镜像目录'
  $mirrorQual = if ([string]::IsNullOrWhiteSpace($mirror)) { '?' } else { Split-Path -Qualifier $mirror }
  $floor = $cfg.'路径'.'底线目录'
  $floorQual = if ([string]::IsNullOrWhiteSpace($floor)) { '?' } else { Split-Path -Qualifier $floor }
  $t = $t.Replace('{镜像盘}', $mirrorQual)
  $t = $t.Replace('{底线盘}', $floorQual)
  return $t
}

function Sync-Protection {
  $dst = $cfg.'保护区'
  if ([string]::IsNullOrWhiteSpace($dst)) { return $null }
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  $copied = 0; $missing = 0
  foreach ($src in $cfg.'受保护的文件') {
    $real = Resolve-Target $src
    if (-not $real) { $missing++; continue }
    try {
      $leaf = Split-Path $real -Leaf
      Copy-Item -LiteralPath $real -Destination (Join-Path $dst $leaf) -Recurse -Force -ErrorAction Stop
      $copied++
    } catch { }
  }
  return @{ copied = $copied; missing = $missing }
}

function Lock-Protection {
  $n = 0
  foreach ($src in $cfg.'受保护的文件') {
    $real = Resolve-Target $src
    if (-not $real -or $real -notmatch '\.md$') { continue }
    $item = Get-Item -LiteralPath $real -ErrorAction SilentlyContinue
    if ($item -and -not $item.IsReadOnly) { $item.IsReadOnly = $true; $n++ }
  }
  return $n
}

function Unlock-Protection {
  $n = 0
  foreach ($src in $cfg.'受保护的文件') {
    $real = Resolve-Target $src
    if (-not $real -or $real -notmatch '\.md$') { continue }
    $item = Get-Item -LiteralPath $real -ErrorAction SilentlyContinue
    if ($item -and $item.IsReadOnly) { $item.IsReadOnly = $false; $n++ }
  }
  return $n
}

function Test-Locked {
  $n = 0
  foreach ($src in $cfg.'受保护的文件') {
    $real = Resolve-Target $src
    if (-not $real -or $real -notmatch '\.md$') { continue }
    $item = Get-Item -LiteralPath $real -ErrorAction SilentlyContinue
    if ($item -and $item.IsReadOnly) { $n++ }
  }
  return $n
}

function Dump-Protection {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $out = Join-Path ([Environment]::GetFolderPath('Desktop')) ("复活-$stamp")
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  $got = 0
  $dst = $cfg.'保护区'
  if (-not [string]::IsNullOrWhiteSpace($dst) -and (Test-Path -LiteralPath $dst)) {
    Copy-Item -LiteralPath $dst -Destination (Join-Path $out '保护区') -Recurse -Force
    $got++
  }
  $logs = Resolve-Target $cfg.'崩溃日志'
  if ($logs) {
    Copy-Item -LiteralPath $logs -Destination (Join-Path $out '崩溃日志') -Recurse -Force -ErrorAction SilentlyContinue
    $got++
  }
  if ($got -eq 0) { Remove-Item -LiteralPath $out -Recurse -Force -ErrorAction SilentlyContinue; return $null }
  return $out
}

function Show-Menu {
  try { Clear-Host } catch { }
  Write-Host ''
  Write-Host '  ==============================================' -ForegroundColor DarkCyan
  Write-Host '     复  活   ·   选  一  个' -ForegroundColor Cyan
  Write-Host '  ==============================================' -ForegroundColor DarkCyan
  Write-Host ''
  foreach ($b in $cfg.'按钮') {
    Write-Host ('   [{0}] {1}' -f $b.'键', $b.'名字') -ForegroundColor White
    Write-Host ('        {0}' -f (Resolve-Text $b.'什么时候按')) -ForegroundColor DarkGray
    if ($b.'类型' -eq 'none') {
      Write-Host ('         ! {0}' -f $b.'备注') -ForegroundColor DarkYellow
    }
    Write-Host ''
  }
  Write-Host '   [0] 退出' -ForegroundColor DarkGray
  Write-Host ('   保护区：{0}' -f $cfg.'保护区') -ForegroundColor DarkGray
  Write-Host ''
}

if (-not (Test-Path $cfgPath)) {
  Write-Host "找不到配置：$cfgPath" -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}
$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json

# 体检那一行除了「跑体检」，还带出两样东西：按编码修的前缀、哪些编码能自动修。
$inspectBtn = $cfg.'按钮' | Where-Object { $_.'类型' -eq 'inspect' } | Select-Object -First 1
$fixPrefix = $null
$fixable = @()
$checkupPath = $null
if ($inspectBtn) {
  $fixPrefix = $inspectBtn.'修键前缀'
  $fixable = @($inspectBtn.'可修编码' | Where-Object { $_ })
  $checkupPath = Resolve-Target $inspectBtn.'执行'
}

$sync = Sync-Protection

while ($true) {
  Show-Menu
  if ($sync) {
    Write-Host ('   保护区已同步：复制 {0} 项，找不到 {1} 项' -f $sync.copied, $sync.missing) -ForegroundColor DarkGray
    Write-Host ''
    $sync = $null
  }

  $choice = Read-Host '   按哪个'
  if ($null -eq $choice) { exit 0 }   # 输入断了（EOF）就退出，别在这儿死循环
  if ($choice -eq '0') { exit 0 }

  # ---- 按编码修：<修键前缀><两位编码>，例如 702 / 706 ----
  if ($fixPrefix -and $choice -match ('^{0}(\d{{2}})$' -f [regex]::Escape($fixPrefix))) {
    $no = $Matches[1]
    Write-Host ''
    if ($fixable.Count -eq 0) {
      Write-Host ('   [{0}] 配置里没写「可修编码」，不知道哪些能修。' -f $no) -ForegroundColor Red
      Write-Host ''
      Read-Host '   按回车继续'
      continue
    }
    if ($fixable -notcontains $no) {
      Write-Host ('   [{0}{1}] 这一项只报告、不能自动修。能修的只有：{2}' -f $fixPrefix, $no, ($fixable -join ' / ')) -ForegroundColor Yellow
      Write-Host ''
      Read-Host '   按回车继续'
      continue
    }
    if (-not $checkupPath) {
      Write-Host ('   找不到体检脚本：{0}——修这一项得靠它。' -f $inspectBtn.'执行') -ForegroundColor Red
      Write-Host ''
      Read-Host '   按回车继续'
      continue
    }

    # 修 06/07 是往受保护文件里写。之前按过「锁保护」的按钮，这些文件是只读的，写不进去。
    # 这不是障碍，是要他点个头——改受保护文件这件事，什么时候都不该由脚本悄悄替他决定。
    $locked = Test-Locked
    if ($locked -gt 0) {
      Write-Host ('   有 {0} 个受保护文件是只读的（之前按过会锁保护的那几个按钮）。修 {1} 要写它们。' -f $locked, $no) -ForegroundColor DarkYellow
      $yn = Read-Host '   临时解锁来修吗？(y/N)'
      if ($yn -ne 'y' -and $yn -ne 'Y') {
        Write-Host '   没修，什么都没动。' -ForegroundColor DarkGray
        Write-Host ''
        Read-Host '   按回车继续'
        continue
      }
      $u = Unlock-Protection
      Write-Host ('   已解锁 {0} 个。' -f $u) -ForegroundColor DarkGray
    }

    Write-Host ('   只修第 {0} 项，别的都不动...' -f $no) -ForegroundColor Green
    Write-Host ''
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $checkupPath -Fix $no
    Write-Host ''
    Read-Host '   按回车继续'
    continue
  }

  $hit = $cfg.'按钮' | Where-Object { $_.'键' -eq $choice } | Select-Object -First 1
  if (-not $hit) {
    Write-Host '   没有这个键。' -ForegroundColor Yellow
    Start-Sleep -Seconds 1
    continue
  }

  if ($hit.'类型' -eq 'unlock') {
    $n = Unlock-Protection
    Write-Host ''
    Write-Host ('   已解锁 {0} 个受保护文件。改完记得再进来，按会锁保护的那几个按钮会重新锁上。' -f $n) -ForegroundColor Green
    Write-Host ''
    Read-Host '按回车继续'
    continue
  }

  if ($hit.'类型' -eq 'fix') {
    Write-Host ''
    if (-not $fixPrefix) {
      Write-Host '   配置里没写「修键前缀」，按编码修用不了。' -ForegroundColor Red
    } else {
      Write-Host ('   要写成 {0}XX —— XX 是体检报告里那一项的编号。' -f $fixPrefix) -ForegroundColor Yellow
      if ($fixable.Count -gt 0) {
        Write-Host ('   能自动修的只有：{0}' -f ($fixable -join ' / ')) -ForegroundColor DarkGray
        Write-Host ('   例：{0}{1} 就只修第 {1} 项' -f $fixPrefix, $fixable[0]) -ForegroundColor DarkGray
      }
      Write-Host '   各管各的，不会顺手动别的。' -ForegroundColor DarkGray
    }
    Write-Host ''
    Read-Host '按回车继续'
    continue
  }

  if ($hit.'类型' -eq 'dump-protection') {
    Write-Host ''
    try {
      $out = Dump-Protection
      if ($out) {
        Write-Host ('   已复制到桌面：{0}' -f $out) -ForegroundColor Green
        Write-Host '   （里面有：保护区 + 崩溃日志）' -ForegroundColor DarkGray
      } else {
        Write-Host '   保护区不存在，也没找到崩溃日志，没东西可取。' -ForegroundColor Yellow
      }
    } catch { Write-Host ('   复制失败：{0}' -f $_.Exception.Message) -ForegroundColor Red }
    Write-Host ''
    Read-Host '按回车继续'
    continue
  }

  if ($hit.'类型' -eq 'inspect') {
    $real = Resolve-Target $hit.'执行'
    Write-Host ''
    if (-not $real) {
      Write-Host ('   找不到体检脚本：{0}' -f $hit.'执行') -ForegroundColor Red
      Read-Host '按回车继续'
      continue
    }
    Write-Host '   跑体检（只读，不写盘）...' -ForegroundColor Green
    Write-Host ''
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $real
    Write-Host ''
    $ans = Read-Host '   要按「只补缺失、不动已有」补文件吗？(y/N)'
    if ($ans -eq 'y' -or $ans -eq 'Y') {
      Write-Host ''
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $real -Restore -Yes
    }
    Write-Host ''
    Read-Host '按回车继续'
    continue
  }

  if ($hit.'类型' -eq 'restore-plugins') {
    Write-Host ''
    # 插件库备份在「备份目录\镜像\plugins」（复活备份.ps1 写的），不是「镜像目录」——
    # 那个是可启动的镜像版 DSH（app/dsh-home/ws），里面没有 plugins。
    $backupDir = Resolve-Target $cfg.'路径'.'备份目录'
    $srcRoot = if ($backupDir) { Join-Path $backupDir '镜像\plugins' } else { $null }
    $dstRoot = Resolve-Target $cfg.'路径'.'插件库'
    if (-not $srcRoot -or -not (Test-Path -LiteralPath $srcRoot)) {
      Write-Host ('   备份里没有插件目录：{0}' -f $srcRoot) -ForegroundColor Yellow
      Write-Host '   先确认「路径.备份目录」对不对，或者备份任务是不是没跑过。' -ForegroundColor DarkGray
      Write-Host ''
      Read-Host '按回车继续'
      continue
    }
    if (-not $dstRoot) {
      Write-Host ('   插件库目录不存在：{0}' -f $cfg.'路径'.'插件库') -ForegroundColor Yellow
      $yn0 = Read-Host '   要建这个目录并把插件全部拷过去吗？(y/N)'
      if ($yn0 -ne 'y' -and $yn0 -ne 'Y') { Write-Host '   没动。' -ForegroundColor DarkGray; Start-Sleep -Seconds 1; continue }
      New-Item -ItemType Directory -Force -Path $cfg.'路径'.'插件库' | Out-Null
      $dstRoot = $cfg.'路径'.'插件库'
    }
    $files = @(Get-ChildItem -LiteralPath $srcRoot -Recurse -File -Force -ErrorAction SilentlyContinue)
    if ($files.Count -eq 0) {
      Write-Host ('   镜像里的插件目录是空的：{0}' -f $srcRoot) -ForegroundColor Yellow
      Write-Host ''
      Read-Host '按回车继续'
      continue
    }
    $missing = @()
    foreach ($f in $files) {
      $rel = $f.FullName.Substring($srcRoot.Length).TrimStart('\')
      $dst = Join-Path $dstRoot $rel
      if (-not (Test-Path -LiteralPath $dst)) { $missing += $f }
    }
    if ($missing.Count -eq 0) {
      Write-Host ('   插件库是全的（镜像里有 {0} 个文件，一个都不缺）。' -f $files.Count) -ForegroundColor Green
      Write-Host '   如果插件还是报错，多半是没重启 DSH，或者插件本身坏了。' -ForegroundColor DarkGray
      Write-Host ''
      Read-Host '按回车继续'
      continue
    }
    $copied = 0
    foreach ($f in $missing) {
      try {
        $rel = $f.FullName.Substring($srcRoot.Length).TrimStart('\')
        $dst = Join-Path $dstRoot $rel
        $dir = Split-Path $dst -Parent
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Copy-Item -LiteralPath $f.FullName -Destination $dst -Force -ErrorAction Stop
        $copied++
      } catch {
        Write-Host ('   拷不过去：{0}（{1}）' -f $f.Name, $_.Exception.Message) -ForegroundColor Yellow
      }
    }
    Write-Host ('   已补回 {0} 个文件（镜像里有 {1} 个，其余都已经在）。' -f $copied, $files.Count) -ForegroundColor Green
    Write-Host '   补完要重启 DSH 才会加载。' -ForegroundColor DarkGray
    $yn = Read-Host '   要顺便把「已存在但内容不同」的也覆盖成镜像版吗？(y/N)'
    if ($yn -eq 'y' -or $yn -eq 'Y') {
      $over = 0
      foreach ($f in $files) {
        try {
          $rel = $f.FullName.Substring($srcRoot.Length).TrimStart('\')
          $dst = Join-Path $dstRoot $rel
          if (Test-Path -LiteralPath $dst) {
            Copy-Item -LiteralPath $f.FullName -Destination $dst -Force -ErrorAction Stop
            $over++
          }
        } catch { }
      }
      Write-Host ('   已覆盖 {0} 个文件。' -f $over) -ForegroundColor Green
    }
    Write-Host ''
    Read-Host '按回车继续'
    continue
  }

  if ($hit.'类型' -eq 'none') {
    Write-Host ''
    Write-Host ('   [{0}] 还没搭好：{1}' -f $hit.'键', $hit.'备注') -ForegroundColor Yellow
    Write-Host ''
    Read-Host '按回车继续'
    continue
  }

  $real = Resolve-Target $hit.'执行'
  if (-not $real) {
    Write-Host ''
    Write-Host ('   找不到要执行的文件：{0}' -f $hit.'执行') -ForegroundColor Red
    Write-Host '   已经在 C/D/E/F/G/H 各盘找过同名位置，都没有。' -ForegroundColor Red
    Write-Host ''
    Read-Host '按回车继续'
    continue
  }

  Write-Host ''
  Write-Host ('   正在执行：{0}' -f $hit.'名字') -ForegroundColor Green
  if ($real -ne $hit.'执行') { Write-Host ('   （自适应找到：{0}）' -f $real) -ForegroundColor DarkGray }

  # 判据是「这条会动别人的机器 / 会改环境」，所以在配置里标「锁保护」，不看编号。
  if ($hit.'锁保护' -eq $true) {
    $lk = Lock-Protection
    Write-Host ('   已把 {0} 个受保护文件锁成只读——这次修不许改它们，要改先按 00。' -f $lk) -ForegroundColor DarkYellow
  }

  Write-Host ''
  try {
    Start-Process -FilePath $real -WorkingDirectory (Split-Path -Parent $real)
    Write-Host '   已启动。这个窗口可以关掉了。' -ForegroundColor DarkGray
    Start-Sleep -Seconds 2
    exit 0
  } catch {
    Write-Host ('   启动失败：{0}' -f $_.Exception.Message) -ForegroundColor Red
    Read-Host '按回车继续'
  }
}
