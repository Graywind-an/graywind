// 消化系统 · 统一配置
//
// 为什么有这个文件（2026-10-31 问的）：
//   「你确定这些配套脚本在其他人的电脑有作用？」
//   —— 不能。镜像检查和排泄里原来全是绝对路径，绑死一台机器。
//
// 口径：
//   · **能猜对的就猜**（胃、通道、已装清单都在 DSH_HOME 下，谁都一样）
//   · **猜不对的就不猜**（镜像根、插件库、工作区），返回 null 并说明后果——功能自动降级，不许假装有
//   · 覆盖顺序：环境变量 > ~/.dsh/notes/消化系统.json > 猜的默认值
//
// 环境变量：
//   消化_胃          胃在哪（暂存区）
//   消化_镜像根      镜像 DSH 的根（没有就不填，镜像检查会跳过并说明）
//   消化_工作区      memory\ 所在的工作区
//   消化_插件库      插件源码库（只有开发者才有）
//   消化_内核        镜像里那个 dsh 的 bin.js

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const 家 = os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(家, '.dsh')

function 读用户配置() {
  const p = path.join(DSH_HOME, 'notes', '消化系统.json')
  try {
    return { 读到: true, 路径: p, 值: JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) }
  } catch (e) {
    return { 读到: false, 路径: p, 原因: e.code === 'ENOENT' ? '没填（正常）' : (e.code || e.message), 值: {} }
  }
}

const 用户 = 读用户配置().值 ?? {}

function 取(键, 环境名, 猜) {
  const 环境 = process.env[环境名]
  if (环境 && String(环境).trim()) return { 值: String(环境).trim(), 源: '环境变量 ' + 环境名 }
  if (用户[键] && String(用户[键]).trim()) return { 值: String(用户[键]).trim(), 源: '配置文件' }
  if (猜) return { 值: 猜, 源: '猜的默认值' }
  return { 值: null, 源: '没设' }
}

// ---- 镜像根：猜不对，没有就是没有 ----
const 镜像根 = 取('镜像根', '消化_镜像根', null)

// ---- 胃：2026-10-31 定「胃默认设置在虚拟盘」----
// 所以顺序是：显式配置 > 镜像根下的「胃」> 退回 DSH_HOME 下的「胃」。
// 有镜像就用虚拟盘（脏东西先落不心疼的地方）；没有镜像的人，退回 DSH_HOME/hên 也能用。
const 胃 = (() => {
  const 显式 = 取('胃', '消化_胃', null)
  if (显式.值) return 显式
  if (镜像根.值) return { 值: path.join(镜像根.值, '胃'), 源: '跟着镜像根（虚拟盘）' }
  return { 值: path.join(DSH_HOME, '胃'), 源: '没有镜像，退回 DSH_HOME' }
})()

// ---- 通道：标准位置，别人也一样 ----
const 通道 = path.join(DSH_HOME, 'notes', '饱腹感.jsonl')

// ---- 已装清单：从 profiles 读，别人也一样 ----
const 已装根 = path.join(DSH_HOME, 'profiles')

// ---- 工作区：默认当前目录，但只在那真的像个工作区时才认 ----
function 猜工作区() {
  const 候选 = [process.cwd()]
  for (const c of 候选) {
    if (fs.existsSync(path.join(c, 'memory', 'check.mjs')) || fs.existsSync(path.join(c, 'memory', '字典.json'))) return c
  }
  return null
}
const 工作区 = 取('工作区', '消化_工作区', 猜工作区())

// ---- 插件库：只有开发者才有 ----
const 插件库 = 取('插件库', '消化_插件库', null)

// ---- 镜像内核 ----
const 内核 = 取('内核', '消化_内核', null)

export const 配置 = {
  DSH_HOME,
  家,
  胃: 胃.值,
  胃源: 胃.源,
  通道,
  已装根,
  镜像根: 镜像根.值,
  镜像根源: 镜像根.源,
  工作区: 工作区.值,
  工作区源: 工作区.源,
  插件库: 插件库.值,
  插件库源: 插件库.源,
  内核: 内核.值,
  内核源: 内核.源,
  用户配置: { 读到: 用户.读到 ?? false, 路径: path.join(DSH_HOME, 'notes', '消化系统.json') },
}

// 降级说明：哪些功能因为缺配置而不能用。**这必须说出来**，不能静默跳过。
export function 缺什么() {
  const 缺 = []
  if (!配置.镜像根) 缺.push({ 项: '镜像检查', 因: '没有镜像根（设 消化_镜像根 或在 消化系统.json 里填「镜像根」）', 后果: '「先在镜像装一遍再复制到本体」这一步做不了，只能靠用户自己找地方验' })
  if (!配置.内核) 缺.push({ 项: '镜像检查的运行时部分', 因: '没有镜像内核路径（设 消化_内核）', 后果: '镜像能不能起、注入通不通，验不了' })
  if (!配置.工作区) 缺.push({ 项: '镜像里的检查脚本', 因: '没找到工作区（memory\\ 目录）', 后果: '镜像里的 self-check 跑不了' })
  if (!配置.插件库) 缺.push({ 项: '工具名冲突检测', 因: '没有插件库路径（设 消化_插件库）', 后果: '查不出「装上去会盖掉谁的工具」' })
  return 缺
}

// 一眼看全配置是怎么定的（每行都带来源，免得"以为它能用其实没配"）
export function 打配置() {
  const 行 = []
  行.push('配置（来源写在后面）：')
  行.push('  DSH_HOME      ' + 配置.DSH_HOME)
  行.push('  胃            ' + 配置.胃 + '   ← ' + 配置.胃源)
  行.push('  通道          ' + 配置.通道)
  行.push('  已装清单      ' + 配置.已装根)
  行.push('  镜像根        ' + (配置.镜像根 ?? '(没设)') + '   ← ' + 配置.镜像根源)
  行.push('  镜像内核      ' + (配置.内核 ?? '(没设)') + '   ← ' + 配置.内核源)
  行.push('  工作区        ' + (配置.工作区 ?? '(没找到)') + '   ← ' + 配置.工作区源)
  行.push('  插件库        ' + (配置.插件库 ?? '(没设)') + '   ← ' + 配置.插件库源)
  const 缺 = 缺什么()
  if (缺.length) {
    行.push('')
    行.push('因为缺配置，这些功能现在是降级状态（不是"没事"，是"做不了"）：')
    for (const x of 缺) 行.push('  △ ' + x.项 + '：' + x.因 + ' → ' + x.后果)
  }
  return 行
}
