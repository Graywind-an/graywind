// 环境自检 + 授权建立
//
// 为什么有这个（2026-10-31 定）：
//   「用户不一定有虚拟盘和镜像的 dsh，所以我们用先确认有没有，没有就通知用户，让用户授权我们来建立」
//
// 两条硬规矩：
//   ① **不替用户决定建不建**。建镜像要占磁盘、要下载几百个包、要几分钟——那是用户的决定。
//   ② **不建也能用**。尝 / 消化 / 排泄 / 名单 这些离线功能，没有镜像照样工作。
//      缺镜像只影响一件事：「先在镜像装一遍再复制到本体」这一步没地方验。
//
// 所以这里的口径是：**先说清缺什么、缺了会怎样、不建也行**，然后等用户说"建"。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { 配置 } from './配置.mjs'

// 本包根目录。**必须用 fileURLToPath**：import.meta.url 会把中文路径 URL 编码
// （插件库 → %E6%8F%92%E4%BB%B6%E5%BA%93），直接拿 .pathname 拼路径，fs.existsSync 永远 false。
// 2026-10-31 实测踩过一次：明明复制了 模板/假模型.mjs，程序说"缺模板"。
const 本包根 = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 检查环境：返回 {有, 缺}。缺的每项都带"为什么需要"和"没它会怎样"。 */
export function 查环境() {
  const 有 = []
  const 缺 = []

  // DSH_HOME 是所有东西的地基
  if (fs.existsSync(配置.DSH_HOME)) 有.push({ 项: 'DSH_HOME', 值: 配置.DSH_HOME })
  else 缺.push({ 项: 'DSH_HOME', 原因: '找不到 ' + 配置.DSH_HOME, 后果: '这不是装 DSH 的机器，或者 DSH_HOME 指错了', 要建: false })

  // 胃：不存在也能用（第一次放东西时会建），但最好先有
  const 胃目录 = 配置.胃
  if (胃目录 && fs.existsSync(胃目录)) 有.push({ 项: '胃（暂存区）', 值: 胃目录 })
  else 缺.push({
    项: '胃（暂存区）',
    原因: '还没有 ' + (胃目录 ?? '(地址没定)'),
    后果: '没地方暂存下载的东西，就只能直接装进身体——那正是我们想避免的',
    要建: true,
    代价: '几乎为零（只是一个空目录）',
  })

  // 镜像根
  if (配置.镜像根 && fs.existsSync(配置.镜像根)) 有.push({ 项: '镜像根', 值: 配置.镜像根 })
  else 缺.push({
    项: '镜像根（虚拟盘）',
    原因: '没有配置，或者配了但目录不存在',
    后果: '「先在镜像里装一遍、验完再复制到本体」这一步做不了。你的东西会**第一次就装进本体**，出问题只能在本体上修。',
    要建: true,
    代价: '要自己选一块盘；装一个独立 DSH 大约 1–2 GB（含内核与常用插件）',
  })

  // 镜像里的 DSH 内核
  if (配置.内核 && fs.existsSync(配置.内核)) 有.push({ 项: '镜像 DSH 内核', 值: 配置.内核 })
  else 缺.push({
    项: '镜像 DSH 内核',
    原因: '镜像里没有一份能跑的 dsh',
    后果: '镜像装了也没法启动，验不了「能不能起来 / 注入通不通」',
    要建: true,
    代价: '一次 npm 安装，几百个包、几分钟',
  })

  // 假模型
  const 假模型 = 配置.镜像根 ? path.join(配置.镜像根, 'fake-llm', 'server.mjs') : null
  if (假模型 && fs.existsSync(假模型)) 有.push({ 项: '假模型', 值: 假模型 })
  else 缺.push({
    项: '假模型（fake-llm）',
    原因: '镜像里没有假模型服务',
    后果: '镜像验"能不能真跑一句"时，会去调真模型——花你的钱',
    要建: true,
    代价: '一个小脚本 + 一个端口，几次网络请求的钱都不到',
  })

  return { 有, 缺 }
}

/** 把环境检查渲染成人话。缺的逐项说清"缺什么 / 会怎样 / 建不建你定"。 */
export function 渲染环境(r) {
  const L = []
  L.push('== 环境检查 ==')
  for (const x of r.有) L.push('  ✔ ' + x.项 + '：' + x.值)
  if (!r.缺.length) {
    L.push('')
    L.push('全都在。镜像那条流程可以走完整：胃 → 尝 → 消化 → 镜像装 → 验 → 本体。')
    return L
  }
  L.push('')
  L.push('缺 ' + r.缺.length + ' 项：')
  for (const x of r.缺) {
    L.push('  ✘ ' + x.项)
    L.push('      为什么：' + x.原因)
    L.push('      没它会怎样：' + x.后果)
    if (x.代价) L.push('      建它的代价：' + x.代价)
  }
  L.push('')
  L.push('**要不要建，你决定。** 我不替你建——建镜像要占你的磁盘、要下载、要几分钟。')
  L.push('')
  L.push('不建也能用这些（离线功能，不需要镜像）：')
  L.push('  尝 · 消化 · 排泄 · 名单 —— 照样工作')
  L.push('')
  L.push('要建的话，跟我说一声，我跑：')
  L.push('  node 消化系统.mjs 建立镜像 --我同意')
  return L
}

/**
 * 建镜像。**必须带"我同意"**，否则只打印计划不动手。
 * @param {{同意?:boolean, 根?:string, 版本?:string, 跳过内核?:boolean}} 选
 */
export async function 建镜像(选 = {}) {
  const 根 = 选.根 || 配置.镜像根
  const 版本 = 选.版本 || '0.2.1-rc.5'
  const 计划 = []

  if (!根) {
    计划.push({ 可: false, 项: '镜像根', 因: '没指定位置。要么给 --根=D:\\某处，要么先设 消化_镜像根' })
    return { 执行: false, 计划 }
  }

  计划.push({ 可: true, 项: '建目录骨架', 做什么: 根 + '\\{home,ws,fake-llm,胃}' })
  if (!选.跳过内核) {
    计划.push({ 可: true, 项: '装一份独立 DSH 内核', 做什么: 'npm i @deepseek-ai/dsh@' + 版本 + ' --prefix ' + path.join(根, 'dsh-' + 版本.replace(/\./g, '-')) })
  }
  计划.push({ 可: true, 项: '建胃', 做什么: path.join(根, '胃') })
  // 假模型：本包自带模板（模板/假模型.mjs）——别人不用自己找
  const 本包 = 本包根
  const 模板 = path.join(本包, '模板', '假模型.mjs')
  计划.push({
    可: fs.existsSync(模板),
    项: '假模型',
    做什么: fs.existsSync(模板) ? '从本包自带的 模板/假模型.mjs 复制一份' : '找不到自带模板（' + 模板 + '），需要你手动放',
    因: fs.existsSync(模板) ? undefined : '这个包装得不完整（缺 模板/假模型.mjs）',
  })

  if (!选.同意) {
    return { 执行: false, 计划, 说明: '这只是计划，还没动手。真要建，加 --我同意' }
  }

  // ---- 真建 ----
  const 做了 = []
  const 失败 = []
  try {
    for (const d of ['home', 'ws', 'fake-llm', '胃']) {
      fs.mkdirSync(path.join(根, d), { recursive: true })
      做了.push('建目录 ' + d)
    }
  } catch (e) {
    失败.push({ 项: '建目录', 因: e.code || e.message })
  }

  if (!选.跳过内核) {
    const 前缀 = path.join(根, 'dsh-' + 版本.replace(/\./g, '-'))
    try {
      fs.mkdirSync(前缀, { recursive: true })
      fs.writeFileSync(path.join(前缀, 'package.json'), JSON.stringify({ name: 'sandbox-dsh', private: true }, null, 2) + '\n', 'utf8')
      const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['install', '@deepseek-ai/dsh@' + 版本, '--no-audit', '--no-fund'],
        { cwd: 前缀, encoding: 'utf8', timeout: 20 * 60 * 1000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
      if (r.status === 0) 做了.push('装内核到 ' + 前缀)
      else 失败.push({ 项: '装内核', 因: '退出码 ' + r.status + '：' + String(r.stderr ?? '').split('\n').slice(-2).join(' / ').slice(0, 200) })
    } catch (e) {
      失败.push({ 项: '装内核', 因: e.message ?? String(e) })
    }
  }

  // 假模型：从本包模板复制（别人的机器上没有现成的一份）
  try {
    const 本包 = 本包根
    const 模板 = path.join(本包, '模板', '假模型.mjs')
    if (fs.existsSync(模板)) {
      fs.copyFileSync(模板, path.join(根, 'fake-llm', 'server.mjs'))
      做了.push('假模型复制到 ' + path.join(根, 'fake-llm', 'server.mjs'))
    } else {
      失败.push({ 项: '假模型', 因: '本包缺 模板/假模型.mjs（这个包装得不完整）' })
    }
  } catch (e) {
    失败.push({ 项: '假模型', 因: e.message ?? String(e) })
  }

  return {
    执行: true,
    计划,          // 真建完也要把计划带回去——不然调用方打印时 `r.计划 is not iterable`（2026-10-31 实测崩过一次）
    做了,
    失败,
    下一步: [
      '把 消化_镜像根 设成 ' + 根,
      '如果装了内核：把 消化_内核 设成 ' + path.join(根, 'dsh-' + 版本.replace(/\./g, '-'), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      '配置镜像的 profile：用出厂模板生成一份（不要直接照抄本体的，那是两套环境）',
      '跑一次：node 消化系统.mjs 环境 —— 看还缺什么',
    ],
  }
}
