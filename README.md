# graywind

**解决 DeepSeek Harness 在日常使用中出现的常见崩溃问题，以及预防措施和一键复活脚本。**

**Solves the common crash problems that show up in daily DeepSeek Harness use — plus prevention, and a one-click rescue kit.**

三个独立的工具，对着三个不同的时机：装之前、跑的时候、坏了之后。

Three independent tools, each for a different moment: before you install something, while it runs, and after the host is already broken.

## 三个东西 / The three pieces

| 目录 / Dir | 时机 / When | 一句话 / In one line |
|---|---|---|
| `digest/` | 装之前 / before install | 读声明、读源码，出报告。不替你决定。 / Reads declarations and source, hands you a report. Never decides for you. |
| `stallguard/` | 跑的时候 / while running | 模型原地打转时，在流里切断并拨回来。 / Cuts the stream when the model loops, and steers it back. |
| `revive/` | 坏了之后 / after it breaks | DSH 起不来时的一条梯子。 / A ladder for when DSH won't start. |

每个目录里都有它自己的说明书。

Each directory carries its own manual.

| 项目 / Project | 说明书 / Manual |
|---|---|
| digest | `digest/README.md`、`digest/README.en.md` |
| stallguard | `stallguard/README.md` |
| revive | `revive/给人的说明书.md`、`revive/给AI的说明书.md` |

## 共同的规矩 / The shared rule

**工具出报告，人拍板。** 不自动装、不静默修、不写「放心，没事」。

**The tool reports; the human decides.** No auto-install, no silent fix, no "trust me, it's fine".

三个都只做一件事：把「现在是什么状态」说清楚，然后停在那儿。

All three do one thing: say what is actually going on, then stop.

## 从哪开始 / Where to start

三件互相独立，不需要一起上。

They are independent — you don't need all three.

- 只是烦模型转圈 → `stallguard/`　／　Just tired of the model looping → `stallguard/`
- 想先看看再装东西 → `digest/`　／　Want to look before you install → `digest/`
- DSH 已经起不来了 → `revive/`　／　DSH already won't start → `revive/`

## 边界（说实话）/ Boundaries (honest)

**`stallguard` 的流内切断只在假模型上验过。** 真实模型下的效果还需要更多观察。

**The in-stream cut has only been verified against a fake model.** Real-model behaviour needs more observation.

**`revive` 是照一台机器的故障史长出来的。** 路径运行时解析，缺前提的步骤会拒绝执行；它在一台全新用户的 Windows 云电脑上整套跑通过一次，但那台机器没有镜像也没有底线版，所以那两个按钮只验到「找不到 = 正确」。

**`revive` grew out of one machine's failure history.** Paths resolve at runtime and steps refuse to run when a precondition is missing. It has run end to end on one fresh-user Windows cloud desktop — but that machine had no mirror and no floor build, so those two buttons only verified "not found = correct".

**`digest` 出的是报告，它不是杀毒软件。** 病毒分析外包给你自己的杀软，工具只负责说清「这一步有没有做成」。

**`digest` produces a report; it is not a virus scanner.** Malware analysis is delegated to your own antivirus; the tool only says whether that delegation happened.

三个都只在这两版 DSH 上跑过：`0.2.1-rc.3`（本机）、`0.2.1-rc.5`（全新用户的云电脑）。

All three have only been run against two DSH versions: `0.2.1-rc.3` (local) and `0.2.1-rc.5` (fresh-user cloud desktop).

包名是 `@local/...`，不在 npm 上，没有 `npm install` 这条路。

Package names are `@local/...`, not on npm. There is no `npm install` path.

## 许可 / License

MIT。请支持作者；传播途中务必标明出处——这是作者更新的动力。

MIT. Please support the author. Whenever you pass this on, always credit the source — that is what keeps it updated.
