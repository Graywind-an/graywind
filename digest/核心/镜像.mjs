// 镜像检查：镜像装完之后，看**全局**有没有功能报红。
//
// 只回答一句：**「现在这个镜像能不能复制到本体？」**
//
// 查七项：骨架 · 配置合成 · 插件解析 · 假模型 · 真跑一句 · 注入痕迹 · 镜像里的检查脚本。
// **它不修东西。** 报出来的都是"要会话去解决"的条目。
//
// 和原来（memory\镜像检查.mjs）的区别：路径全部走 核心/配置.mjs。
// 没配镜像根 → 这一整个器官降级，并明说做不了什么（不许假装跑过）。

import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { 配置 } from './配置.mjs'

const 假端口 = 18999
const 测试profile = 'desktop-r5'

async function 等端口(端口, 毫秒 = 8000) {
  const 起 = Date.now()
  while (Date.now() - 起 < 毫秒) {
    try {
      const r = await fetch('http://127.0.0.1:' + 端口, { method: 'POST', body: '{"messages":[]}', signal: AbortSignal.timeout(1500) })
      if (r.ok) return true
    } catch { /* 还没起 */ }
    await new Promise((s) => setTimeout(s, 400))
  }
  return false
}

/**
 * 跑一次镜像检查。
 * @param {{快?:boolean}} 选
 * @returns {{结:Array, 红:number, 黄:number, 能复制:boolean, 说明?:string}}
 */
export async function 跑镜像检查(选 = {}) {
  const 根 = 配置.镜像根
  if (!根) {
    return {
      结: [],
      红: 0,
      黄: 1,
      能复制: false,
      说明: '没有配置镜像根（设 消化_镜像根 环境变量，或在 ' + 配置.DSH_HOME + '\\notes\\消化系统.json 里填「镜像根」）。' +
        '这一整套检查做不了——**「先在镜像装一遍再复制到本体」这一步现在没地方验**。',
    }
  }
  if (!fs.existsSync(根)) {
    return { 结: [], 红: 1, 黄: 0, 能复制: false, 说明: '镜像根不存在：' + 根 }
  }

  const 家 = path.join(根, 'home')
  const 工作 = path.join(根, 'ws')
  const 假模型 = path.join(根, 'fake-llm', 'server.mjs')
  const 内核 = 配置.内核

  const 结 = []
  const 记 = (名, 级, 说, 修) => 结.push({ 名, 级, 说, 修 })

  // ---------- 1. 骨架 ----------
  for (const [名, p] of [
    ['home（DSH_HOME 镜像）', 家],
    ['ws（工作区镜像）', 工作],
    ['fake-llm（假模型）', path.join(根, 'fake-llm')],
  ]) {
    if (fs.existsSync(p)) 记(名, '绿', '在')
    else 记(名, '红', '不在：' + p, '先跑一次同步把镜像补齐')
  }
  if (内核 && fs.existsSync(内核)) 记('镜像内核', '绿', 内核)
  else 记('镜像内核', 内核 ? '红' : '黄', 内核 ? '配了但不存在：' + 内核 : '没配（设 消化_内核）', '镜像能不能起、注入通不通，验不了')

  // ---------- 2. 配置合成：静默失效 ----------
  if (内核 && fs.existsSync(内核) && fs.existsSync(家)) {
    process.env.DSH_HOME = 家
    const r = spawnSync(process.execPath, [内核, '--profile', 测试profile, '--dump-config'], {
      encoding: 'utf8', timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    })
    const 出 = String(r.stdout ?? '') + '\n' + String(r.stderr ?? '')
    const 没找到 = [...出.matchAll(/patch:\s*entry\s+["']?([\w@/.-]+)["']?\s+not found/g)].map((m) => m[1])
    const 跳过 = [...出.matchAll(/skipping profile bundle\s+["']?([^"':\n]+)["']?/g)].map((m) => m[1].trim())
    const entry数 = (出.match(/^- id:/gm) ?? []).length

    if (!entry数) {
      记('配置合成', '红', 'dump 出来 0 个 entry —— 内核没起来或 profile 坏了', '看 dump 的 stderr；确认「' + 测试profile + '」这个 profile 在不在镜像里')
    } else if (没找到.length) {
      记('配置合成', '红', 没找到.length + ' 条 patch 的 entry 在新版树里不存在（**静默失效**）：' + 没找到.join(', '), '改 id 或删掉那条')
    } else {
      记('配置合成', '绿', '合成出 ' + entry数 + ' 个 entry，没有 entry not found')
    }
    if (跳过.length) {
      记('插件解析', 跳过.some((x) => /版本|incompatible/i.test(出)) ? '红' : '黄',
        跳过.length + ' 个 bundle 没解析到：' + 跳过.slice(0, 6).join(', ') + (跳过.length > 6 ? ' …' : ''),
        '看是「cannot resolve」（没装）还是「incompatible」（版本钉死）——后者要跟着升')
    } else {
      记('插件解析', '绿', '所有 bundle 都解析到了')
    }
  }

  // ---------- 3+4. 假模型 + 真跑一句 ----------
  async function 真跑() {
    if (!fs.existsSync(假模型)) { 记('真跑一句', '黄', '没有 fake-llm，跳过', ''); return }
    if (!内核 || !fs.existsSync(内核)) { 记('真跑一句', '黄', '没有镜像内核，跳过', ''); return }
    let 子 = null
    const 已起 = await 等端口(假端口, 1500)
    if (!已起) {
      子 = spawn(process.execPath, [假模型], { cwd: path.join(根, 'fake-llm'), stdio: 'ignore', windowsHide: true })
      if (!(await 等端口(假端口, 10000))) {
        记('假模型', '红', '起不来（10 秒没监听 ' + 假端口 + '）', '手动跑一下看报什么')
        try { 子.kill() } catch { /* 已死 */ }
        return
      }
      记('假模型', '绿', '起在 127.0.0.1:' + 假端口)
    } else {
      记('假模型', '绿', '已经在跑')
    }

    const patch = path.join(根, 'patch-probe.yml')
    const 用patch = fs.existsSync(patch)
    process.env.DSH_HOME = 家
    process.env.JIAN_FAKE_KEY = 'sandbox-key'
    const args = [内核, '--profile', 'headless']
    if (用patch) args.push('--patch', patch)
    args.push('说 ok')
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    const 出 = String(r.stdout ?? '')
    const 错 = String(r.stderr ?? '')
    if (/\bok\b/.test(出)) {
      记('真跑一句', '绿', 'headless 起得来、假模型回了 ok' + (用patch ? '（带 patch-probe）' : '（没带 patch）'))
      const m = /step#\d+\s+inject\s+at=(\d+)\s*\(claimed=(\d+),\s*total=(\d+)\)/.exec(错)
      if (m) 记('注入痕迹', '绿', 'pre-step 注入进去了：at=' + m[1] + ' claimed=' + m[2] + ' total=' + m[3])
    } else {
      记('真跑一句', '红', '没回 ok。退出码 ' + r.status + '；stderr 尾部：' + 错.split('\n').slice(-3).join(' / ').slice(0, 260), '镜像起不来就没法验，先修它')
    }
    if (子) { try { 子.kill() } catch { /* 已退出 */ } }
  }

  // ---------- 5. 镜像里的检查脚本能不能跑 ----------
  function 检查脚本() {
    const 脚本 = 配置.工作区 ? path.join(工作, 'memory', '契约测试.mjs') : null
    if (!脚本 || !fs.existsSync(脚本)) {
      记('镜像里的检查脚本', '黄', '镜像 ws\\memory 里没有契约测试.mjs', '同步一遍 ws 层')
      return
    }
    const r = spawnSync(process.execPath, [脚本], { encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    const 出 = String(r.stdout ?? '') + String(r.stderr ?? '')
    const m = /全绿：(\d+)\s*条/.exec(出)
    if (m) 记('镜像里的检查脚本', '绿', '契约测试在镜像里跑通：全绿 ' + m[1] + ' 条（镜像的 ws 是活的，不是死文件）')
    else 记('镜像里的检查脚本', '黄', '契约测试没跑绿：' + 出.split('\n').slice(-3).join(' / ').slice(0, 200), '镜像的 ws 可能是旧的')
  }

  if (选.快) 记('真跑一句', '黄', '你用了「快」，这一步没跑（**没查 ≠ 通过**）', '要验运行时就去掉快再跑一次')
  else await 真跑()
  检查脚本()

  const 红 = 结.filter((x) => x.级 === '红').length
  const 黄 = 结.filter((x) => x.级 === '黄').length
  return { 结, 红, 黄, 能复制: 红 === 0 }
}

/** 给人看的几行 */
export function 渲染镜像(r) {
  const L = []
  if (r.说明) { L.push(r.说明); return L }
  const 图标 = { 绿: '✔', 黄: '△', 红: '✘' }
  L.push('== 镜像检查 ==')
  for (const x of r.结) {
    L.push('  ' + 图标[x.级] + ' [' + x.级 + '] ' + x.名 + '：' + x.说)
    if (x.修 && x.级 !== '绿') L.push('        → ' + x.修)
  }
  L.push('')
  if (r.红) {
    L.push('结论：✘ 不能复制到本体。有 ' + r.红 + ' 项红：' + r.结.filter((x) => x.级 === '红').map((x) => x.名).join('、'))
    L.push('      这些交给会话去解决；**不要在本体上试错**——本体不是第一个修它的地方。')
  } else if (r.黄) {
    L.push('结论：△ 没有红，但有 ' + r.黄 + ' 项黄。要不要复制到本体，你决定。')
  } else {
    L.push('结论：✔ 全绿。镜像验过了，可以复制到本体。')
    L.push('      复制完记得跑一次排泄，把胃里已装的副本清掉。')
  }
  return L
}
