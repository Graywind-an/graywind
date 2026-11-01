# verify-buttons.ps1 —— 只读地验复活包的按钮表，不按任何按钮。
#
# 验三件事：
#   ① 每个按钮的「执行」路径，在配好/没配好的机器上分别能不能解析
#   ② {镜像盘} / {底线盘} 替换对不对（Resolve-Text）
#   ③ 找不到时自动换盘符对不对（Resolve-Target）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-buttons.ps1
#
# 输出：屏幕 + 桌面 verify-buttons-<时间>.txt

param([string]$Config = '')

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$cfgPath = if ($Config) { $Config } else { Join-Path $here 'revive-config.json' }
if (-not (Test-Path $cfgPath)) { $cfgPath = Join-Path $here 'revive\revive-config.json' }
$报告 = New-Object System.Collections.ArrayList
function 记($s) { [void]$报告.Add([string]$s); Write-Host $s }

if (-not (Test-Path $cfgPath)) {
  记 ('找不到 revive-config.json：' + $cfgPath)
  exit 1
}
try { $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json }
catch { 记 ('配置读不出来：' + $_.Exception.Message); exit 1 }

# 和 revive.ps1 里一模一样的两段 —— 故意复制过来，不 import，
# 验的就是"这两段在真实配置上跑出来什么"。
function Resolve-Target([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return $null }
  if (Test-Path -LiteralPath $p) { return $p }
  if ($p.Length -le 3) { return $null }
  $tail = $p.Substring(3)
  foreach ($d in @('C','D','E','F','G','H')) {
    $try = ('{0}:\{1}' -f $d, $tail)
    if (Test-Path -LiteralPath $try) { return $try }
  }
  return $null
}

function Resolve-Text([string]$t) {
  if ([string]::IsNullOrEmpty($t)) { return $t }
  $mirror = $cfg.'路径'.'镜像目录'
  $mirrorQual = if ([string]::IsNullOrWhiteSpace($mirror)) { '?' } else { Split-Path -Qualifier $mirror }
  $floor = $cfg.'路径'.'底线目录'
  $floorQual = if ([string]::IsNullOrWhiteSpace($floor)) { '?' } else { Split-Path -Qualifier $floor }
  return ($t.Replace('{镜像盘}', $mirrorQual).Replace('{底线盘}', $floorQual))
}

function 是占位([string]$s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return $false }
  return ($s -match 'YOUR_NAME' -or $s -match '<[^>]{1,20}>')
}

记 '==================== 复活包按钮表 ===================='
记 ('配置      ' + $cfgPath)
记 ('镜像目录  ' + $cfg.'路径'.'镜像目录' + '   ← {镜像盘} 会替换成 ' + (Resolve-Text '{镜像盘}'))
记 ('底线目录  ' + $cfg.'路径'.'底线目录' + '   ← {底线盘} 会替换成 ' + (Resolve-Text '{底线盘}'))
记 ('保护区    ' + $cfg.'保护区')
记 ''
记 ('共 ' + @($cfg.按钮).Count + ' 个按钮')

$占位数 = 0
$找不到 = 0
$能解析 = 0

记 ''
记 ('{0,-4} {1,-14} {2,-18} {3,-8} {4}' -f 'ID', '类型', '名字', '解析', '目标')
记 ('-' * 110)

foreach ($b in @($cfg.按钮)) {
  $执行 = Resolve-Text $b.'执行'
  $名 = Resolve-Text $b.'名字'
  $类型 = [string]$b.'类型'
  $是命令 = ($类型 -eq 'cmd')

  $状态 = ''
  $目标显示 = $执行

  if ([string]::IsNullOrWhiteSpace($执行)) {
    # 这几个类型没有外部脚本，是 revive.ps1 内部处理的
    if ($类型 -in @('dump-protection','inspect','fix','restore-plugins','unlock')) { $状态 = '内部' }
    else { $状态 = '无路径' }
    $目标显示 = ''
  }
  elseif (是占位 $执行) {
    $状态 = '占位'
    $占位数++
  }
  else {
    $r = Resolve-Target $执行
    if ($r) {
      $状态 = 'OK'
      $能解析++
      $目标显示 = $r
    }
    else {
      $状态 = '找不到'
      $找不到++
    }
  }

  记 ('{0,-4} {1,-14} {2,-18} {3,-8} {4}' -f ([string]$b.'键'), $类型, $名, $状态, $目标显示)
  if ($b.'锁保护') { 记 ('      └ 锁保护 = true（按它之前会把受保护文件锁只读）') }
}

记 ''
记 ('汇总：能解析 ' + $能解析 + ' / 占位 ' + $占位数 + ' / 找不到 ' + $找不到 + ' / 共 ' + @($cfg.按钮).Count)
if ($占位数 -gt 0) {
  记 ''
  记 '※ 有「占位」的按钮，说明 revive-config.json 还没按这台机器改过。'
  记 '  这不是坏了 —— 是还没配。改法：把 YOUR_NAME 换成你的 Windows 用户名。'
}

$out = Join-Path ([Environment]::GetFolderPath('Desktop')) ('verify-buttons-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
[System.IO.File]::WriteAllText($out, ($报告 -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Host ''
Write-Host ('报告写到: ' + $out)
