// 排泄：把"吃完了、装好了、用不着了"的东西排出去。
//
// 判据（2026-10-31 提的）：
//   · 只有**能说出它是什么、谁产生的、多久没动**的东西才排
//   · 说不出的一律不动 —— 宁可留垃圾，不删不知道是什么的
//   · 默认只预演；真删要两道开关
//
// 和原来（memory\排泄.mjs）的区别：路径全部走 核心/配置.mjs，别人的电脑上也能用。
// 这个文件**没有顶层副作用**——它是被 import 的器官，不是脚本。

import fs from 'node:fs'
import path from 'node:path'
import { 配置 } from './配置.mjs'

function 大小(p) {
  let 总 = 0
  const 走 = (d, 深) => {
    if (深 > 8) return
    let 项
    try { 项 = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const x of 项) {
      const q = path.join(d, x.name)
      if (x.isDirectory()) { 走(q, 深 + 1); continue }
      try { 总 += fs.statSync(q).size } catch { /* 读不到就算 */ }
    }
  }
  走(p, 0)
  return 总
}

function 人读(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB'
  return n + ' B'
}

// 已装的包名（判断"胃里这个东西是不是已经在身体里了"）
function 读已装(已装根) {
  const 集 = new Set()
  const 走 = (d, 深) => {
    if (深 > 3) return
    let 项
    try { 项 = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const x of 项) {
      if (x.name !== 'node_modules') { if (x.isDirectory()) 走(path.join(d, x.name), 深 + 1); continue }
      const nm = path.join(d, 'node_modules')
      let 包
      try { 包 = fs.readdirSync(nm, { withFileTypes: true }) } catch { continue }
      for (const p of 包) {
        if (p.name.startsWith('@')) {
          let 子
          try { 子 = fs.readdirSync(path.join(nm, p.name)) } catch { continue }
          for (const s of 子) 集.add(p.name + '/' + s)
        } else 集.add(p.name)
      }
    }
  }
  走(已装根, 0)
  return 集
}

/**
 * 跑一次排泄。
 * @param {{真排?:boolean, 天数?:number, 确认?:boolean}} 选
 * @returns {{要排:Array, 不动:Array, 字节:number, 已排:number, 失败:number, 记账:string|null}}
 */
export function 跑排泄(选 = {}) {
  const 天数 = Number(选.天数 ?? 14) || 14
  const 真排 = Boolean(选.真排) && Boolean(选.确认)
  const 要排 = []
  const 不动 = []

  // 没有胃就不排（别人的电脑上可能还没建）
  if (!配置.胃 || !fs.existsSync(配置.胃)) {
    return { 要排, 不动, 字节: 0, 已排: 0, 失败: 0, 记账: null, 说明: '没有胃（' + (配置.胃 ?? '没配') + '），没东西可排' }
  }

  const 已装 = 读已装(配置.已装根)

  // ---------- 1. 胃里的目录 ----------
  for (const x of fs.readdirSync(配置.胃, { withFileTypes: true })) {
    if (!x.isDirectory()) continue
    const p = path.join(配置.胃, x.name)
    let 包名 = null
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
      包名 = pj.name
    } catch { /* 没有 package.json */ }
    const 消化过 = fs.existsSync(path.join(p, '.已消化.json'))
    const 装上了 = 包名 ? 已装.has(包名) : false
    const 字节 = 大小(p)
    if (装上了 && 消化过) {
      要排.push({ 类: '胃里·已装成功且消化过', 路: p, 字节, 因: 包名 + ' 已经在身体里了（' + 人读(字节) + '），胃里这份是垃圾' })
    } else {
      不动.push({ 路: p, 因: !消化过 ? '没消化过（不是垃圾，是还没处理）' : (包名 ? '没装上（' + 包名 + ' 不在已装清单里）' : '读不出包名，不敢判') })
    }
  }

  // ---------- 2. 下载残留 ----------
  for (const x of fs.readdirSync(配置.胃, { withFileTypes: true })) {
    if (!x.isFile()) continue
    if (!/\.(zip|7z|tar|tgz|gz|rar)$/i.test(x.name)) continue
    const p = path.join(配置.胃, x.name)
    let st
    try { st = fs.statSync(p) } catch { continue }
    const 天 = (Date.now() - st.mtimeMs) / 86400000
    要排.push({ 类: '下载残留', 路: p, 字节: st.size, 因: x.name + ' 压缩包，解压完就没用了（' + 天.toFixed(0) + ' 天没动）' })
  }

  // ---------- 3. 临时区超期 ----------
  for (const [标, 根] of [['工作区 _tmp', 配置.工作区 ? path.join(配置.工作区, '_tmp') : null], ['DSH tmp', path.join(配置.DSH_HOME, 'tmp')]]) {
    if (!根 || !fs.existsSync(根)) continue
    let 项
    try { 项 = fs.readdirSync(根, { withFileTypes: true }) } catch { continue }
    for (const x of 项) {
      const p = path.join(根, x.name)
      let st
      try { st = fs.statSync(p) } catch { continue }
      const 天 = (Date.now() - st.mtimeMs) / 86400000
      if (天 < 天数) continue
      要排.push({ 类: '临时区超期·' + 标, 路: p, 字节: x.isDirectory() ? 大小(p) : st.size, 因: x.name + ' 已 ' + 天.toFixed(0) + ' 天没动（阈值 ' + 天数 + ' 天）' })
    }
  }

  const 字节 = 要排.reduce((s, x) => s + (x.字节 ?? 0), 0)
  let 已排 = 0
  let 失败 = 0
  let 记账 = null

  if (真排) {
    for (const x of 要排) {
      try { fs.rmSync(x.路, { recursive: true, force: true }); 已排 += 1 } catch { 失败 += 1 }
    }
    try {
      const 账 = path.join(配置.DSH_HOME, 'notes', '排泄账.jsonl')
      fs.mkdirSync(path.dirname(账), { recursive: true })
      fs.appendFileSync(账, JSON.stringify({ at: new Date().toISOString(), 排掉: 已排, 失败, 字节 }) + '\n', 'utf8')
      记账 = 账
    } catch (e) {
      记账 = '写不进去：' + (e.code || e.message)
    }
  }

  return { 要排, 不动, 字节, 已排, 失败, 记账, 真排, 人读字节: 人读(字节) }
}

/** 给人看的几行 */
export function 渲染排泄(r) {
  const L = []
  if (r.说明) { L.push(r.说明); return L }
  L.push('可排：' + r.要排.length + ' 项 / ' + (r.人读字节 ?? 人读(r.字节)))
  for (const x of r.要排) { L.push('  - [' + x.类 + '] ' + x.路); L.push('      ' + x.因) }
  if (r.不动.length) {
    L.push('不动：' + r.不动.length + ' 项（说不出是什么，或还没处理完）')
    for (const x of r.不动.slice(0, 8)) L.push('  · ' + x.路 + '  ← ' + x.因)
  }
  if (r.真排) {
    L.push('')
    L.push('排掉 ' + r.已排 + ' 项 / 失败 ' + r.失败 + ' 项')
    if (r.记账) L.push('记账：' + r.记账)
  } else {
    L.push('')
    L.push('预演结束，一个字节没删。真排要两个开关：真排 + 确认。')
  }
  return L
}
