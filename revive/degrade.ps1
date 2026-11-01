# 降级启动：DSH 起不来、界面那三个选项都试过没用时用
#
# 干的事：
#   1) 把 profile 的 cordis.patch.yml 备份到 _降级备份\<时间>\
#   2) 把它清空（DSH 用自带的默认配置启动，插件全不加载）
#   3) 启动 DSH，等 25 秒看它还活着没有
#   4) 活着 = 是配置/插件的问题；死了 = 不是插件，往程序 / GPU / 缓存查
#
# 用法：
#   degrade.ps1            降级启动（会改配置，但先备份）
#   degrade.ps1 -Restore   把最近一次备份恢复回去

param([switch]$Restore)

$ErrorActionPreference = 'Continue'
$prof    = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$cfg     = Join-Path $prof 'cordis.patch.yml'
$bakRoot = Join-Path $env:USERPROFILE 'Desktop\复活\_降级备份'
$exe     = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'

function Say($m) { Write-Host $m }

if ($Restore) {
  $latest = Get-ChildItem $bakRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $latest) { Say '没有备份可恢复。'; exit 1 }
  $src = Join-Path $latest.FullName 'cordis.patch.yml'
  if (-not (Test-Path $src)) { Say ('备份里没有 cordis.patch.yml：' + $latest.FullName); exit 1 }
  Copy-Item $src $cfg -Force
  Say ('已恢复：' + $src)
  exit 0
}

if (-not (Test-Path $cfg)) { Say ('找不到配置：' + $cfg); exit 1 }
if (-not (Test-Path $exe)) { Say ('找不到 DSH：' + $exe); exit 1 }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = Join-Path $bakRoot $stamp
New-Item -ItemType Directory -Force -Path $bak | Out-Null
Copy-Item $cfg (Join-Path $bak 'cordis.patch.yml') -Force
Say ('已备份：' + $bak)

$p = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($p) {
  Say '注意：DSH 正在运行。降级启动应该在没有 DSH 的时候用——先把 DSH 完全退出。'
  exit 2
}

$note = @('#',
  '# 2026-11-01 降级启动：配置被清空，DSH 用自带默认配置。',
  ('# 原文件在 ' + $bak + '\cordis.patch.yml'),
  '# 要恢复：degrade.ps1 -Restore')
$note | Set-Content $cfg -Encoding UTF8

Say '已清空 cordis.patch.yml，启动 DSH ...'
Start-Process -FilePath $exe | Out-Null
Start-Sleep -Seconds 25

$p2 = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
Say ''
if ($p2) {
  Say '=========================================='
  Say '  DSH 起来了（进程还在）'
  Say '  -> 是配置 / 插件的问题'
  Say '=========================================='
  Say '要恢复原配置：degrade.ps1 -Restore'
} else {
  Say '=========================================='
  Say '  DSH 还是起不来（进程没了）'
  Say '  -> 不是插件 / 配置，往这三处查：'
  Say '     1) app.asar 被换（体检 [01]）'
  Say '     2) GPU 子进程崩（discussion #332，exitCode 0x80000003）'
  Say '     3) 缓存坏了（Session Storage / Local Storage）'
  Say '=========================================='
  Say ''
  Say ('原配置已经备份，没丢：' + $bak)
}
