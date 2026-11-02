# graywind

**让 DeepSeek Harness 在日常使用里不把自己弄坏。**

灰风与岸共用的一套东西，先给我们两台机器用——是个小生态，不是一件单品。

> English: [README.md](README.md)

## 它其实只会以两种方式坏掉

长会话、高推理强度下，DSH 会做两件烧钱又烧时间的事：

1. **模型在原地转圈。** token 还在流，但全是同一段话在重复，什么都没推进，上下文一路烧。（实测：一次调用 67,172 个字符的「做」，正文 0 字符。）
2. **装个东西把宿主弄坏。** 一个插件或一次配置改动落下去，DSH 起不来了——黑窗、没有会话、没有能读的报错。接着就是瞎猜、重装、丢一半记忆。

这里每一件都对着这两样里的一个。没有一件是「有了更好」。

## 里面有什么

| 件 | 管什么 | 形态 |
|---|---|---|
| **`stallguard/`** | 模型原地转圈：盯着流，**在流里切断，并把它拨回正轨** | 插件（挂 `llm/stream`）+ 离线分析脚本 |
| **`revive/`** | 宿主起不来：**一键化复活包**——清 cookie、降级、镜像先行恢复、底线版、9 项体检、插件库恢复 | PowerShell 脚本 + `.cmd` 按钮 |
| **`digest/`** | 东西落地之前先判：只读声明（「嘴」）和真读源码（「消化」），报告交给人——**永远不给判词** | 插件 + 独立脚本 |

三件共一条设计规矩：**工具出报告，人拍板。** 不自动装、不静默修、不写「放心，没事」。

## `stallguard` —— 兜圈子刹车

卡住的模型不是不干活，是在原地重复。`stallguard` 盯着流式输出，一发现它在重复、没有进展，就关掉开着的块、补一个 `finish{stop}`、steer 一条纠正——而不是等上下文烧干，或者等人手动点停止。

五条规则，各管一种重复的形状：

| 规则 | 抓什么 | 动作 |
|---|---|---|
| 窗口 | 2000 字符窗口里不重复字符 <50、连续 5 窗（字汇密度塌了） | steer / cancel |
| 连续相同 chunk | 同一 payload 连续 ≥60 次（单字/短词刷屏） | 流内切断 |
| 周期 | 尾部一段短周期在**精确**重复（周期 ≤512、跨度 ≥512、≥2 种字符） | 流内切断 |
| 短语池 | 同一批短句重排（重复质量 ≥2048、覆盖率 ≥0.6、集中度 ≥4） | 流内切断 |
| 跨调用 | 上一步 distinct 4-gram 被本步包含 ≥0.8（同一结论换说法） | steer |

两处关键取舍：**精确周期 > 熵比**（markdown 表格 0.72、真循环 0.92–0.99，差 0.06 没法定阈值；精确周期对表格/日志/JSON 一律是 0），**containment > Jaccard**（卡住的模型会「复述上一步 + 补一句」，Jaccard 被新内容稀释，containment 直接报重复）。

阈值、来路、每条对应哪次事故：见 [`stallguard/README.md`](stallguard/README.md)。

## `revive` —— 复活包

DSH 起不来的时候，按这个梯子往上爬，而不是直接盲重装。每一步是一个按钮，顺序是「便宜、可逆的在前」。

```
1 清 cookie        2 降级          3 镜像先行恢复
4 底线版           5 离开保护区     6 体检（9 项：外壳/网络/配置/profile/会话/存储/插件/权限/封存）
7 按 7xx 编码修    8 恢复插件库（从镜像）   9 查单字循环（对历史会话跑 stallguard）
```

两条写死在里面的规矩：**镜像装完验过，才碰本体**；**没有你的话，不从镜像往回复制任何东西**。它碰的每个路径都是运行时解析的，没有一处写死在某台机器上。

细节和故障清单：[`revive/给AI的说明书.md`](revive/给AI的说明书.md)（给做安装的 AI 看）、[`revive/给人的说明书.md`](revive/给人的说明书.md)（给人看）。

## `digest` —— 咽下去之前先判

故意分两段：**嘴**只读声明（体积按类型比、依赖、install 钩子、危险词、仿冒、二进制），只有拦截权，没有放行权；**消化**真读源码（动态执行、混淆、外连、读凭证、写系统位置、提权、改提示词），摸清注册面，再用声明对实际。

最后交的是一份报告，不是一个判词。**就算全红，装不装也是你定**——报告说清「这是什么」「跑起来会发生什么」，然后停在那儿。只有一个例外：一条把东西直接塞进身体、跳过整个流程的安装命令会被拦下，`--我知道` 是放行方式。那是提醒，不是审批。

细节：[`digest/README.md`](digest/README.md) · [English](digest/README.en.md)

## 怎么装

每一件都自成一体，不需要三件一起上。

`dsh plugin` 把参数**原样转发给 pnpm**（在 profile 目录里跑），所以装插件就是 pnpm 的活：

```bash
# 1) 先拿到文件
git clone https://github.com/graywind-an/graywind

# 2) 装进某个 profile（--profile web 是 CLI 管得到的那个）
dsh plugin --profile web add file:C:/path/to/graywind/stallguard
dsh plugin --profile web add file:C:/path/to/graywind/digest
```

**第 2 步只写 `dependencies`，不会把它加进加载栈。** 下面两样至少做一样，否则它在 `node_modules` 里躺着什么都不干：

- 把包名加进 profile `package.json` 的 `dsh.profile.bundles`，**或者**
- 在 profile 的 `cordis.patch.yml` 里加一段：

```yaml
- insert:
    - id: dsh-digest
      name: '@local/dsh-digest'
```

然后重启 DSH。重启前先验——这条命令把整个插件栈解析一遍就退出，**不启动任何东西**：

```bash
dsh --profile web --dump-config
```

应该能看到 `# == @local/dsh-digest`，下面挂着解析出来的 `plugin/index.js` 路径。

**脚本形态**（三件都有）：`node` 直接跑，零依赖，不用装。

**关于包名**：都是 `@local/...`，这是**本地域**，不是发布到 npm 的包名。故意的——这些从 checkout 装，`@local` 谁也抢不走。

**一条我们撞到的限制**：`dsh plugin --profile desktop` 会被拒绝——

```
error: profile "desktop" is managed exclusively by the Electron application
```

所以上面 `file:` 那套只对 CLI 管得到的 profile（`web`、`tui`、你自己建的）有效。**桌面 App 那个 profile**，要么走它的插件界面装，要么手工改那份 `package.json`——手工改的话**必须写成 UTF-8 无 BOM**（带 BOM 会让 DSH 直接起不来，报 `SyntaxError: Unexpected token '﻿'`）。

## 验证

```
node stallguard/_selftest.mjs   # 检测器纯函数，35 条
node stallguard/_smoke.mjs      # 假 ctx 测两个接缝：切断、可见 text 块、预算、warn 档，27 条
node digest/_smoke.mjs          # 假 ctx：5 个工具 + 1 个拦截钩子，每个 execute 和 render，39 条
node scripts/analyze.mjs        # 事后：你历史会话里哪些调用在打转

dsh --profile web --dump-config # 插件栈能不能解析（不启动任何东西）
```

`stallguard` 实测：真实 9 个会话约 1900 步，**零误报**；命中点正是已知出问题的调用。真机流内切断在隔离环境（干净 DSH + 假模型）验过一次：`cut text-cycle，重复至少 288 字符` + `steer ok`，连续切 8 次后预算用完、正常收尾。

**装法本身也在另一份 DSH 里端到端验过**（独立 `DSH_HOME`、假模型）：`dsh plugin --profile web add file:<你的 checkout>` → 文件落进 `node_modules`，`--dump-config` 解析出两个 entry，装好的副本跑自己的测试（35 + 27 + 39）全绿。**动你真实 profile 的那一步，留给你。**

**一键跑完（Windows / PowerShell）**：把 zip 放到桌面，然后

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File run-all.ps1
```

五步，**全部只读、不删任何目录**：① 桌面 `复活` 已存在就改名成 `复活.bak-<时间>`；② 解压 zip 到 `~\graywind`（旧的先改名备份，**绝不拿旧脚本去验**）；③ 复制 `revive\` 到桌面 `复活`，把配置里的 `YOUR_NAME` 换成当前用户；④ 跑 `verify-all.ps1`（七段）、`verify-buttons.ps1`（十个按钮的路径能不能解析）、按钮 9；⑤ 桌面留一份 `run-all-<时间>.txt`。

它**不清 cookie、不降级、不启动 DSH**——那些会改机器状态，留给你自己按。

## 边界（说实话）

- 流内切断只在**假模型**上验过。真实模型下的效果还需要更多观察。
- 用来标定 `stallguard` 的真实会话工具不随仓库发布（依赖本机会话文件）；`scripts/analyze.mjs` 自包含，覆盖同一套五条规则。
- 完全相同的短行重复 32+ 次也会被判为重复（`|  |  |`、同句日志刷屏）——设计内，但空表格/同构 JSON 可能被误切。
- `revive` 的梯子是照一台机器的故障史长出来的。路径运行时解析、缺前提的步骤会拒绝执行。**在一台全新用户的 Windows 云电脑上整套跑通过一次**——但那台机器没有镜像目录也没有底线目录，所以按钮 3 / 4 只验到「找不到 = 正确」，**没验到真的起得来**。
- `digest` 出的是报告，**它不是杀毒软件**——病毒分析外包给用户自己的杀软，工具只负责说清「这一步有没有做成」。
- 在 **DSH 0.2.1-rc.3**（本机）和 **0.2.1-rc.5**（全新用户的云电脑）上都跑过。`engines.dsh` 写 `>=0.2.0`，是因为这些插件没有一处钉死版本号——但实际验过的就是这两版。
- 两个插件的包名只在磁盘上（`@local/...`），**不在 npm 上**，没有 `npm install` 这条路，我们也没打算发。

## 名字

`an` = 岸，也同安（停下来的地方）；`graywind` = 灰风（那个被打开门后、选择跟着你的灰）。

## 许可

MIT。用、改、带走都行，别把作者当成工具就行。
