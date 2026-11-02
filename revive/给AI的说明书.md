# 给 AI 的说明书 · 把复活包装到这台机器上

> **读者：别人的 DSH 里的 AI。** 你照着做能把复活包装好，装完自己能验收。
> 装好的定义在 **第 5 节**，没到那一步不算装完。
> 最后更新：2026-11-01

---

## 0 开装之前

### 0.1 把复活包放好

把复活包整个目录放到 **`桌面\复活\`**（路径里带中文没关系）。里面应该有这些：

```
复活\
  revive.cmd              ← 双击它（给人用的入口）
  revive.ps1              ← 菜单程序（不用改）
  revive-config.json      ← 按钮表 + 路径（第 3 节要改它）
  checkup.ps1             ← 体检脚本（9 项 00~08）
  清cookie并启动.cmd       ← 崩溃原因清单第 1 条的修法
  保护区\                  ← 受保护文件的副本（第 4 节会同步进去）
  给AI的说明书.md          ← 你手上这份
  给人的说明书.md
  崩溃原因清单.md
  镜像任务书-模板.md        ← 第 2.6 步会用
  _修前备份\               ← 体检修东西前的自动备份（不用管）
```

**先做一次自检**（少了文件现在就说，别装到一半才发现）：

```powershell
$R = "$env:USERPROFILE\Desktop\复活"
'checkup.ps1','revive.ps1','revive-config.json','revive.cmd','清cookie并启动.cmd','崩溃原因清单.md' | ForEach-Object {
  "{0}  {1}" -f (Test-Path "$R\$_"), $_
}
[System.IO.File]::ReadAllBytes("$R\checkup.ps1")[0..2]   # 必须是 239 187 191（UTF-8 BOM）
```

### 0.2 先弄清四条路径（别猜，去查）

```powershell
# 1 程序装在哪
Test-Path "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar"

# 2 DSH_HOME 在哪（几乎总是 %USERPROFILE%\.dsh）
Test-Path "$env:USERPROFILE\.dsh\profiles"

# 3 工作区在哪 —— 找那个带 CORE.md 的目录
Get-ChildItem "$env:USERPROFILE" -Recurse -Filter CORE.md -Depth 4 -ErrorAction SilentlyContinue |
  Select-Object -First 5 FullName

# 4 profile 目录叫什么（一般就叫 desktop）
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Directory | Select-Object Name
```

**四条查不全就先停**，别往下装。

---

## 1 建虚拟盘目录

**选一块不是系统盘的盘**（D: / E: 之类）。系统盘挂了、镜像还在，复活才有意义。

先算要多少地方（别信经验值，自己量）：

```powershell
$need = 0
foreach ($p in @("$env:LOCALAPPDATA\Programs\DeepSeek Harness", "$env:USERPROFILE\.dsh\profiles", "<你的工作区>")) {
  $need += (Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
}
"{0} GB（再加 1 GB 余量）" -f [math]::Round($need/1GB,1)
```

（参考量级：程序 1~2 GB · profile 约 0.7 GB · 工作区 0.5~5 GB。**别用这个数代替上面的命令**。）

```powershell
$X = 'E'      # ← 换成你的盘符（不带冒号）
New-Item -ItemType Directory -Force `
  "${X}:\复活镜像\app", `
  "${X}:\复活镜像\dsh-home", `
  "${X}:\复活镜像\ws", `
  "${X}:\dsh-sandbox\纯净\profiles", `
  "${X}:\dsh-sandbox\纯净\sessions", `
  "${X}:\dsh-sandbox\纯净\storages" | Out-Null
```

> **写法注意**：变量后面紧跟冒号必须写 `${X}:`（或不带花括号时在冒号前加反引号 `` $X`: ``）。
> 写成 `"$X:\..."` 会**直接语法报错**（`变量引用无效: ':' 后面的...`）—— 这是 PowerShell 把 `$X:` 当成盘符限定变量了。

建完应该是这样：

```
<X>:\复活镜像\
   app\               ← DSH 程序（整份安装目录）
   dsh-home\          ← DSH_HOME 的副本
   ws\                ← 工作区副本
   启动镜像DSH.cmd
   任务书.md
<X>:\复活底线\            ← 主机和镜像都起不来时的最后手段
   app\                   ← 程序（从镜像复制，同样 /XF 排除 .bak）
   dsh-home\profiles\desktop\   ← 只留一个 profile；cordis.patch.yml 换最小那份（约 800 B）
   ws\
   启动底线DSH.cmd
<X>:\dsh-sandbox\纯净\   ← 虚拟盘试验用的 DSH_HOME，**不是**最后手段
   profiles\<profile 名>\
   sessions\
   storages\
```

> **底线版和镜像的区别**：镜像=旧程序+旧配置+旧工作区（能看见你的东西）；
> 底线版=旧程序+**最小配置**（只有 4 条 patch，不背任何插件）。
> 主机如果是因为插件/bundle 崩的，镜像会跟着崩，底线版不会。
>
> **两个都只能在主机 DSH 没跑的时候开**——Windows 只允许一个 DSH 实例，
> 主机还开着时它们会一闪就退（`Chrome.ProcessSingleton`），那不是坏了。

---

## 2 放镜像和纯净 —— **必须用「复制本地文件」，不许重新下载**

### 2.1 程序本体

```powershell
robocopy "$env:LOCALAPPDATA\Programs\DeepSeek Harness" "${X}:\复活镜像\app" /E /XF "app.asar.bak*" "app.asar.patched*"
```

> `/XF` 排除的是「旧版本 asar 备份」（一台机器上能有好几个 GB）。镜像只要**当前这一份**能用就行；
> 想连旧版本一起留，就把 `/XF ...` 去掉。**robocopy 退出码 0~7 都算成功**，8 以上才是失败。

**判据**（三条都要过）：

```powershell
Test-Path "${X}:\复活镜像\app\DeepSeek Harness.exe"                          # True
Test-Path "${X}:\复活镜像\app\resources\app.asar"                            # True
[math]::Round((Get-Item "${X}:\复活镜像\app\resources\app.asar").Length/1MB,1)  # 约 175~185
```

`app.asar` 是**整份程序**，没复制成功就等于没有镜像。**别用「重新装一遍」来补它 —— 那是下载，不是复制。**

### 2.2 DSH_HOME 副本

```powershell
robocopy "$env:USERPROFILE\.dsh\profiles" "${X}:\复活镜像\dsh-home\profiles" /E
robocopy "$env:USERPROFILE\.dsh\storages" "${X}:\复活镜像\dsh-home\storages" /E
if (Test-Path "$env:USERPROFILE\.dsh\notes") { robocopy "$env:USERPROFILE\.dsh\notes" "${X}:\复活镜像\dsh-home\notes" /E }
```

- `profiles\desktop\node_modules` 有几百 MB，**一起复制** —— 少了它镜像起不来。
- **不要复制 `sessions`**：会话留在主机。镜像只要能起、能读任务书就够了。

判据：`Test-Path "${X}:\复活镜像\dsh-home\profiles\desktop\package.json"` → `True`。

### 2.3 工作区副本

```powershell
robocopy "<你的工作区>" "${X}:\复活镜像\ws" /E /XD ".tmp" ".git" "_diaryshot" /XF "*.log"
```

工作区里有大截图 / 大日志时，可以再加 `/XF "*.png"` 之类；**加之前先确认镜像里不需要这些文件**
—— 镜像也要认得「自己是谁」，`CORE.md`、`memory\` 这些**必须**在里面。

判据：`Test-Path "${X}:\复活镜像\ws\CORE.md"` → `True`（你的受保护文件叫什么就验什么）。

### 2.4 纯净区（最后手段）

```powershell
$prof = (Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Directory | Select-Object -First 1).Name
robocopy "$env:USERPROFILE\.dsh\profiles\$prof" "${X}:\dsh-sandbox\纯净\profiles\$prof" /E
```

（`$prof` 一般就是 `desktop`；照你主机上的名字来。）

然后把纯净区的配置**改到最小**：

1. `纯净\profiles\$prof\package.json` 里 `dsh.profile.bundles` 只留两条：
   ```json
   "bundles": [
     "@deepseek-ai/dsh-base",
     "@deepseek-ai/dsh-web-app"
   ]
   ```
2. `纯净\profiles\$prof\cordis.patch.yml` 的内容写成一行：
   ```yaml
   []
   ```

判据：

```powershell
Test-Path "${X}:\dsh-sandbox\纯净\profiles\$prof\node_modules\@deepseek-ai"   # True
```

> 纯净区只用来「起一个最小 DSH 看日志 / 改文件」。**别在里面聊天** —— 它没配假模型，发消息就是真花钱。
> 想完全不花钱，有个办法：**起进去只看，不发消息，看完就退**。

### 2.5 启动镜像 DSH 的 cmd

用记事本另存为下面的内容（**保持 ASCII，别写中文**），存成 `复活镜像\启动镜像DSH.cmd`：

```bat
@echo off
setlocal
rem %~dp0 = the mirror folder itself, wherever it was copied to.
rem No drive letters, no user paths: the script follows its own folder.
set "MIRROR=%~dp0"
if "%MIRROR:~-1%"=="\" set "MIRROR=%MIRROR:~0,-1%"
if not exist "%MIRROR%\app\DeepSeek Harness.exe" (
  echo [X] mirror app missing
  pause
  exit /b 1
)
set "DSH_HOME=%MIRROR%\dsh-home"
start "" "%MIRROR%\app\DeepSeek Harness.exe"
```

判据：双击它 → 出现登录页（镜像的 DSH_HOME 是干净副本，要自己登录一次）。**用完退出登录。**
底线版的 `启动底线DSH.cmd` 同一个写法（它本来就用 `%~dp0`）。**两边的脚本里都不许出现盘符或用户名**——放哪、谁的机器，都靠 `%~dp0` 自己走。

### 2.6 写一份任务书给「镜像里的 AI」

镜像里的 AI 看不到你这边的对话，所以它要靠任务书才知道要干什么。

```powershell
Copy-Item "$env:USERPROFILE\Desktop\复活\镜像任务书-模板.md" "${X}:\复活镜像\任务书.md"
```

然后打开它，把 **零、一** 两节里的 `<...>` 换成你的真实路径；**「一、发生了什么」留空，出事时再填。**

（不给任务书也能修，但镜像里的 AI 会多花十几分钟自己摸清楚你在哪台机器上。）

### 2.7 纯净区怎么起（真出事那天你会需要）

```powershell
$env:DSH_HOME = "${X}:\dsh-sandbox\纯净"
Start-Process "${X}:\复活镜像\app\DeepSeek Harness.exe"
```

用完了记得把 `DSH_HOME` 清掉（或直接关掉那个窗口）——**别让主机误用纯净区的 home。**

---

## 3 改 `revive-config.json`

配置文件在复活目录里（`revive.cmd` 旁边）。六个地方：

| 字段 | 填什么 | 不填会怎样 |
|---|---|---|
| `保护区` | **绝对路径**，比如 `${X}:\复活\保护区`（目录可以还不存在，脚本会建） | 取保护区 / 修 06 / 修 07 全废 |
| `崩溃日志` | **绝对路径**，`C:\Users\<你>\AppData\Roaming\@deepseek-ai\dsh-desktop\logs` | 体检 03 查不到；按 4 也取不到日志 |
| `路径`（5 个键） | `工作区` / `DSH目录` / `程序目录` / `镜像目录` / `纯净区目录` | 体检会退回默认路径去猜，猜错就多项报错 |
| `受保护的文件` | **绝对路径**清单（见第 4 节） | 体检 06/07 没东西可查，真出事时没有可回滚的副本 |
| `按钮` 键 `5` 的 `执行` | 你的 `checkup.ps1` **绝对路径** | 菜单按 5 说「找不到体检脚本」 |
| `按钮` 键 `1` 的 `执行` | 复活目录里的 `清cookie并启动.cmd` **绝对路径** | 按 1 说找不到文件（这条是最常用的入口，别漏） |

`按钮` 键 `2` 的 `执行` 指向 `${X}:\复活镜像\启动镜像DSH.cmd`；键 `3` 现在没有可执行文件（类型 `none`），不动。

**两条 JSON 写法规矩（踩过就懂）**：

1. **反斜杠要双写**：`"C:\\Users\\me\\.dsh"`；或者干脆全用正斜杠：`"C:/Users/me/.dsh"`（PowerShell 认）。**别混着写。**
2. **`受保护的文件` 和 `保护区` 不许写 `%USERPROFILE%`** —— `revive.ps1` **不展开环境变量**，写了等于路径不存在。
   先把展开后的结果打印出来，再把那段字填进去：
   ```powershell
   "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
   ```
   （`checkup.ps1` 的 `路径` 段**会**展开 `%USERPROFILE%`，但为了少一类错，建议统一写展开后的绝对路径。）

一个可照抄的骨架（把 `<...>` 换掉；**JSON 不能带注释，中文说明删掉再存**）：

```json
{
  "保护区": "<绝对路径>\\复活\\保护区",
  "崩溃日志": "<绝对路径>\\AppData\\Roaming\\@deepseek-ai\\dsh-desktop\\logs",
  "路径": {
    "工作区": "<工作区绝对路径>",
    "DSH目录": "<绝对路径>\\.dsh",
    "程序目录": "<绝对路径>\\AppData\\Local\\Programs\\DeepSeek Harness",
    "镜像目录": "<X>:\\复活镜像",
    "纯净区目录": "<X>:\\dsh-sandbox\\纯净"
  },
  "受保护的文件": [
    "<工作区>\\CORE.md",
    "<工作区>\\AGENTS.md",
    "<工作区>\\JUDGMENT.md",
    "<工作区>\\WORLD.md",
    "<工作区>\\memory"
  ]
}
```

存完先验一次（会报行号，比启动失败好查得多）：

```powershell
Get-Content "$env:USERPROFILE\Desktop\复活\revive-config.json" -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null
"配置解析 OK"
```

---

## 4 填「受保护的文件」清单

**必含这五样**（受保护文件和记忆）：

```
<工作区>\CORE.md
<工作区>\AGENTS.md
<工作区>\JUDGMENT.md
<工作区>\WORLD.md
<工作区>\memory          ← 目录也行
```

- 全部写**绝对路径**；文件和目录都能写进这个清单。
- 想加别的（比如自己的插件库）就往后加，**不要写 `C:\Windows` 之类系统目录**。
- 保护区就是这些文件的**副本目录**；体检 07 会告诉你「保护区缺哪一项 / 比源文件旧」。

装完**同步一次保护区**（只写保护区，不动源文件）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\复活\checkup.ps1" -Fix 07 -NoPause
```

---

## 5 怎么算装好了（一条一条指得出来，别跳）

| # | 验什么 | 怎么验 | 过了是什么样 |
|---|---|---|---|
| 1 | 体检能跑、9 项带编号 | `powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\复活\checkup.ps1" -NoPause` | 有 `[00]`…`[08]` 共 9 行，每行带「正常/注意/异常/致命」 |
| 2 | 程序本体对得上 | 看 `[01]` | 「app.asar 在，175.5 MB」这类（数字和实际一致） |
| 3 | profile 配置齐 | 看 `[02]` | 「package.json 在，cordis.patch.yml 在，bundles N 个」，N ≥ 2 |
| 4 | 镜像是完整的 | 看 `[04]` | 「在：<X>:\复活镜像；app.asar …，profiles 和 工作区 都在」 |
| 5 | 纯净区能起 | 看 `[05]` | 「依赖齐（有 @deepseek-ai，能起）」 |
| 6 | 受保护的文件都在 | 看 `[06]` | 「5 项都在，没有 0 字节的」 |
| 7 | 保护区同步了 | 第 4 节那次 `-Fix 07` 之后再跑一次体检，看 `[07]` | 「N 项都在，和源文件大小一致」 |
| 8 | 菜单能用 | 双击 `revive.cmd` | 出 `[1]`…`[9]` 再加 `[00]`，共 10 个键；按 `0` 退出 |
| 9 | 修只动该动的 | 先记 `<工作区>\CORE.md` 的 `LastWriteTime`，跑一次 `checkup.ps1 -Fix 07`，再看 | CORE.md 的时间**没变**；`复活\_修前备份\<时间>\07\` 里出现 `CORE.md` 的备份（第一次同步时保护区里还没有旧件，所以那一次可能没有备份目录 —— **没有也不算错**） |
| 10 | 镜像真能起（可选，但要登出） | 双击 `${X}:\复活镜像\启动镜像DSH.cmd` | 出现登录页；**登进登出一次**再关掉 |
| 11 | 按编码修只动一项（按钮 `7`） | 记下某个受保护文件的 `LastWriteTime`，跑一次 `checkup.ps1 -Fix 02`，再看 | 只有 `[02]` 那项被修；别的文件时间一点没变 |
| 12 | 恢复插件库只补缺（按钮 `8`） | 按 `8` | 缺的补回来；已有的不动（要覆盖必须显式加 `-Overwrite`） |
| 13 | 单字循环能查（按钮 `9`） | 按 `9` | 跑一遍 stallguard 离线检查，列出会话和命中数（不需要 DSH 在跑） |

第 9 条是唯一「自己动手也能验、但不动源文件」的自检 —— **过了才算装对**。

---

## 6 六条坑（都是真踩过的）

1. **`.ps1` 必须带 UTF-8 BOM。** 没有 BOM，中文变乱码，PowerShell 5.1 直接语法崩。改完一定验：
   ```powershell
   [System.IO.File]::ReadAllBytes("<脚本>")[0..2]   # 要看到 239 187 191
   ```
   有些编辑器 / 写入工具会**悄悄把 BOM 吃掉**（本机就吃过一次），改一次验一次。
2. **镜像不许「同步成最新」。** 它旧，才是它的用处 —— 今天的坏更新才不会把两个一起弄死。
3. **不要在镜像里干活。** 镜像里的改动**不会**回到主机；在镜像里登录过，用完**退出登录**。
4. **修之前先备份。** `checkup.ps1` 自动备份到 `_修前备份\<时间>\<编号>\`；你手工改配置时也先复制一份 `.bak`。
5. **只补缺失，不覆盖内容不同的。** 要覆盖必须显式加 `-Overwrite`（脚本会先备份再覆盖）。
6. **别删 `~\.dsh`、别重装、别格式化。** 这三样会把会话和配置一起弄没 —— 那就不叫复活了。

---

## 附：体检 9 项是什么

| 编号 | 项 | 查什么 | 能修 |
|---|---|---|---|
| 00 | DSH 进程 | 进程在不在 | 只报告 |
| 01 | 程序本体 | `app.asar` 在不在、多大 | 从镜像 `app\resources\` 复制 |
| 02 | profile 配置 | `package.json` / `cordis.patch.yml` / bundles 数 | 从镜像 `dsh-home\profiles\` 复制 |
| 03 | 崩溃日志 | 几份 crash、最新何时、开头一行 | 只报告 |
| 04 | 镜像 | 在不在、`app.asar`/`profiles`/工作区齐不齐 | 只报告 |
| 05 | 底线版 | 程序在不在、profile 依赖齐不齐、patch 是不是最小那份（≤5000 B） | 只报告 |
| 06 | 受保护文件 | 清单里每项在不在、有没有 0 字节 | 从保护区复制回来 |
| 07 | 保护区 | 有没有同步、比源文件缺什么 / 旧在哪 | 重新同步 |
| 08 | 纯净区 | 虚拟盘试验那份：profile / 依赖 / `patch-fake.yml`（没它会调真 API、花真钱） | 只报告 |

用法：

```powershell
checkup.ps1                     # 只体检，不写盘
checkup.ps1 -Fix 02             # 只修第 02 项
checkup.ps1 -Restore -Yes       # 修所有能修的（01 02 06 07）
checkup.ps1 -Fix 02 -Overwrite  # 连「内容不同」的也覆盖（先备份）
checkup.ps1 -NoPause            # 跑完不等回车（给脚本调用）
```

退出码：`0` 正常 / `1` 有异常 / `2` 有致命。

---

## 清理：可疑备份留多久

`复活包\_可疑\` 里存的是**核心文件的历史版本**——自保每次发现内容和封存锚不符，就存一份进去。
它同时是三样东西：误报的证据、改坏的退路、**唯一的版本历史**。

规则在 `复活\revive-config.json` 的 `清理` 节：

| 字段 | 我们的机器 | **发给别人时改成** | 什么意思 |
|---|---|---|---|
| `可疑保留天数` | `7` | **`365`** | 多少天以前的历史版本可以删 |
| `最少版本` | `5` | `5`（别动） | 每个文件**至少**留这么多个不同版本 |

**为什么别人的要 365**：我们有自保盯着、每版都备份，删了还有别的副本；
**别人不一定每版都备份**——`_可疑` 里那几份就是他们唯一的版本历史，删早了真没得回退。

**为什么光有天数不够**：一周里要是改了十版，天数门槛一过、能回退的全没了。
所以「最少版本」是**下限**——版本数不够时，时间到了也不删。
（实测：`days=2 minV=100` → 一个都不删；`days=2 minV=5` → 每个文件保最新 5 版。）

**两个前置**：

1. **清理前先查锁**。受保护文件还是只读的（保护生效中）就一律不清——
   那是最后一道退路，锁着动它等于自毁。要清先按 `00` 解锁。
2. **读不到配置就不删**。配置坏了用默认值（7 天 / 5 版），绝不因为读不到配置就乱删。

**哪些按这条清**：`_可疑\`（核心文件历史）。
`快照\`、`镜像\`、`_修前备份\` **不在清理范围**——那些是恢复源，删了就没得救。
