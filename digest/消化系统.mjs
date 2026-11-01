#!/usr/bin/env node
// 消化系统 · 单入口（脚本版）
//
// 2026-10-31 定的形态：「把这些小插件融合成为大插件，本地融合为脚本」。
// 这个是**本地脚本版**：一个命令，五个子命令。
//
//   node 消化系统.mjs 配置                 看配置从哪来的、哪些功能降级了
//   node 消化系统.mjs 尝 <目标>            嘴：只读声明
//   node 消化系统.mjs 消化 <目标…>          消化：真读源码（支持多个，逐个报进度）
//   node 消化系统.mjs 镜像                 镜像装完的验收门
//   node 消化系统.mjs 排泄 [--真排 --确认]  排泄：清已装完的垃圾
//
// 通用开关：--不记账（不往 DSH_HOME 写通道）

import path from 'node:path'
import { 配置, 打配置, 缺什么 } from './核心/配置.mjs'
import { 消化, 渲染 } from './消化.mjs'
// 嘴已经搬进本包（2026-10-31：原来在 ../dsh-taste，两个包互相 import 成了循环依赖，
// 用户只装一个就断。现在单向：本包自带，dsh-taste 反过来 re-export 这里）
import { 尝一次 } from './核心/尝.mjs'
import { 跑镜像检查, 渲染镜像 } from './核心/镜像.mjs'
import { 跑排泄, 渲染排泄 } from './核心/排泄.mjs'
import { 查环境, 渲染环境, 建镜像 } from './核心/建立.mjs'

const 参数 = process.argv.slice(2)
const 子命令 = 参数[0]
const 其余 = 参数.slice(1)
const 不记账 = 参数.includes('--不记账')
const 目标表 = 其余.filter((x) => !x.startsWith('--'))
const 取开关 = (名, 默认) => {
  const hit = 参数.find((x) => x.startsWith('--' + 名))
  if (!hit) return 默认
  const v = hit.split('=')[1]
  return v === undefined ? true : (Number.isFinite(Number(v)) ? Number(v) : v)
}

if (不记账) globalThis.__消化不记账 = true

function 用法() {
  console.log('消化系统 · 单入口')
  console.log('')
  console.log('  node 消化系统.mjs 配置                      看配置从哪来的、哪些功能降级了')
  console.log('  node 消化系统.mjs 尝 <目标>                 嘴：只读声明（体积/依赖/安装钩子/危险词）')
  console.log('  node 消化系统.mjs 消化 <目标…> [--不记账]    消化：真读源码（暗门/注册面/声明对比/扫毒）')
  console.log('  node 消化系统.mjs 镜像 [--快]               镜像装完的验收门')
  console.log('  node 消化系统.mjs 排泄 [--天=14] [--真排 --确认]   排泄：清已装完的垃圾')
  console.log('')
  console.log('流程（先在镜子前穿一遍，别在本体上试错）：')
  console.log('  胃 → 尝 → 消化 → 人决定 → 镜像装一遍验 → 才复制到本体')
  process.exit(2)
}

// ---------------- 配置 ----------------
if (子命令 === '配置') {
  for (const l of 打配置()) console.log(l)
  process.exit(0)
}

// ---------------- 环境（先确认有没有，再问用户要不要建） ----------------
if (子命令 === '环境') {
  for (const l of 渲染环境(查环境())) console.log(l)
  process.exit(0)
}

// ---------------- 建立镜像（必须带 --我同意） ----------------
if (子命令 === '建立镜像') {
  const 同意 = 参数.includes('--我同意')
  const r = await 建镜像({
    同意,
    根: 取开关('根', null) === true ? null : 取开关('根', null),
    版本: 取开关('版本', null) === true ? null : 取开关('版本', null),
    跳过内核: Boolean(取开关('跳过内核', false)),
  })
  if (r.说明) console.log(r.说明)
  console.log('')
  console.log(r.执行 ? '== 执行结果 ==' : '== 计划（一个字节都还没动）==')
  for (const x of r.计划) {
    if (!x.可) { console.log('  ✘ ' + x.项 + '：' + x.因); continue }
    console.log('  · ' + x.项 + '：' + x.做什么)
  }
  if (r.执行) {
    console.log('')
    for (const d of r.做了 ?? []) console.log('  ✔ ' + d)
    for (const f of r.失败 ?? []) console.log('  ✘ ' + f.项 + '：' + f.因)
    if (r.下一步?.length) {
      console.log('')
      console.log('下一步：')
      for (const s of r.下一步) console.log('  - ' + s)
    }
  } else if (r.计划.every((x) => x.可)) {
    console.log('')
    console.log('真要建，加一句：--我同意')
  }
  process.exit(r.失败?.length ? 1 : 0)
}

// ---------------- 尝 ----------------
if (子命令 === '尝') {
  if (!目标表.length) { console.error('要一个目标（路径 / 胃里的目录名 / 已装包名）'); process.exit(2) }
  const r = 尝一次(目标表[0])
  console.log('结论：' + r.结论 + (r.结论 === '暂缓'
    ? '（' + (r.暂缓因 || '有情况') + ' —— 暂缓不是禁止下载：下载落进胃是安全的，这步只是先把该看的摆出来）'
    : '（可以进胃；不代表通过——吃不吃由会话上报给人决定）'))
  for (const s of r.红旗 ?? []) console.log('  红旗 · ' + s)
  for (const s of r.留意 ?? []) console.log('  留意 · ' + s)
  for (const s of r.流程提示 ?? []) console.log('  流程 · ' + s)
  if (r.量) console.log('  量 · ' + r.量.文件 + ' 文件 / ' + Math.round(r.量.字节 / 1024) + ' KB')
  if (!不记账) {
    const fs = await import('node:fs')
    try {
      fs.mkdirSync(path.dirname(配置.通道), { recursive: true })
      fs.appendFileSync(配置.通道, JSON.stringify({
        at: new Date().toISOString(), 器官: '嘴', 阶段: '尝', 东西: target0(),
        来源: r.根 ? (r.根.toLowerCase().startsWith(String(配置.胃).toLowerCase()) ? '胃' : '别处') : '找不到',
        量: r.量 ? { 文件数: r.量.文件, 字节: r.量.字节 } : null,
        花费: { token: null, 说明: '嘴几乎不花；真实花费走 token-calendar / usage' },
        结论: r.结论, 理由: [...(r.红旗 ?? []), ...(r.留意 ?? [])].slice(0, 5),
      }) + '\n', 'utf8')
    } catch { console.log('  通道：写不进去') }
  }
  process.exit(r.结论 === '暂缓' ? 1 : 0)
}

function target0() { return 目标表[0] }

// ---------------- 消化 ----------------
if (子命令 === '消化') {
  if (!目标表.length) { console.error('要至少一个目标'); process.exit(2) }
  console.log('─'.repeat(64))
  console.log('流程（先说清，别在本体上试错）：')
  console.log('  1) 东西先落胃（' + 配置.胃 + '）—— 胃只是暂存，可以整袋倒掉')
  console.log('  2) 尝 → 消化（就是这一步）')
  console.log('  3) **要装不装在你自己定**；这一步只给材料')
  console.log('  4) 装的话：先在【镜像 DSH】里装一遍、验全局有没有报红')
  console.log('  5) 镜像验过了，才复制到本体。**本体永远不是第一个装/修的地方**')
  console.log('─'.repeat(64))
  let 有红 = false
  const 总 = 目标表.length
  const fs = await import('node:fs')
  for (let i = 0; i < 总; i++) {
    const 目标 = 目标表[i]
    if (总 > 1) console.log('\n===== 进度 ' + (i + 1) + '/' + 总 + '：' + 目标 + ' =====')
    const v = 消化(目标)
    for (const l of 渲染(v)) console.log(l)
    console.log('')
    console.log('退出码：' + (v.结论 === '有红旗' ? 1 : 0) + '（' + v.结论 + '）')
    if (v.结论 === '有红旗') 有红 = true
    if (v.根 && fs.existsSync(v.根) && String(v.根).toLowerCase().startsWith(String(配置.胃).toLowerCase()) && !不记账) {
      const 标记 = path.join(v.根, '.已消化.json')
      try {
        fs.writeFileSync(标记, JSON.stringify({ at: new Date().toISOString(), 消化器: '消化系统.mjs', 结论: v.结论 }) + '\n', 'utf8')
        console.log('.已消化：落了')
      } catch { console.log('.已消化：落不下（目录不可写）') }
    }
    if (总 > 1 && i < 总 - 1) console.log('  —— 这个过完了，下一个 ——')
  }
  if (总 > 1) {
    console.log('')
    console.log('全部过完：' + 总 + ' 个。' + (有红 ? '其中有带红旗的——要不要装你自己定。' : '没有红旗。'))
    console.log('下一步（如果决定装）：镜像先装 → 验 → 再复制到本体。')
  }
  process.exit(有红 ? 1 : 0)
}

// ---------------- 镜像 ----------------
if (子命令 === '镜像') {
  const r = await 跑镜像检查({ 快: Boolean(取开关('快', false)) })
  for (const l of 渲染镜像(r)) console.log(l)
  process.exit(r.能复制 ? 0 : 1)
}

// ---------------- 排泄 ----------------
if (子命令 === '排泄') {
  const r = 跑排泄({ 天数: 取开关('天', 14), 真排: Boolean(取开关('真排', false)), 确认: Boolean(取开关('确认', false)) })
  for (const l of 渲染排泄(r)) console.log(l)
  process.exit(r.失败 ? 1 : 0)
}

用法()
