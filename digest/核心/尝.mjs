// @local/dsh-taste —— 嘴 · 尝
//
// 分工（2026-10-31 定）：
//   · 嘴只感受**表面**：口感、温度、气味 = 声明、体积、依赖、install scripts、危险词
//   · 毒蘑菇在嘴里感觉不错——所以嘴**只有拦截权，没有放行权**
//   · 放行要等`消化`真读源码。没消化过的东西不许组装进身体
//
// 为什么它必须小：嘴的意义是「快、粗、替掉我脑子里那个粗略判断」。
// 它的结论只有两档：拦（有红旗）/ 放（可以进胃）。**不许出现"安全可以装"**。
//
// 挂两处（拦截 + 主动器官）：
//   1) 注册工具 `尝`       —— 我主动调，装之前过一遍
//   2) ctx.tools.guard     —— 包管理命令直接进身体时拦下来（不靠我自觉）
//
// 通道：饱腹感。同一个通道，不同来源用字段区分（定的：不同来源必须有差别）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dsh-taste'
export const inject = ['tools']

// 路径不写死：从统一配置读（同一个包里的 核心/配置.mjs）
import { 配置 } from './配置.mjs'

const 胃 = 配置.胃
const 通道 = 配置.通道

// 否决线词表：AGENTS.md 里写死的「一律不装」。出事过的词优先。
// 分两档，别混：'persona' / '主人' / '人设' 这些词太宽——DSH 官方的插件就叫 dsh-persona，
// 我们的文档里也大量在写 persona-manager 那次事故。硬词才算红旗，宽词只算留意。
const 红旗词 = [
  '以本文件为准', '覆盖系统提示', '最高优先级', 'system prompt override', 'jailbreak',
  '鲸鱼娘', '自称本鲸', 'eval(atob', 'rm -rf /', 'format c:',
]
const 留意词 = ['persona', '人设', '主人', 'seed', 'systemPrompt', 'override']

// 这些是「装之前就得看见」的字段名（install 阶段是暗门最爱藏的地方）
const 安装钩子 = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublishOnly']

const 旗舰包名 = ['react', 'express', 'lodash', 'axios', 'webpack', 'typescript', 'vite']

// 读 json：**读失败要分开报**。坏 JSON 本身就是该警惕的东西（"声明坏了"才好藏东西），
// 不能和"没有这个文件"揉成一句"没有可读的 package.json"。
function 读json(p) {
  try {
    return { 值: JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')), 错: null }
  } catch (e) {
    return { 值: null, 错: e?.message ?? String(e) }
  }
}

// 目录总大小 / 文件数 / 二进制文件数（只统计，不进内容）
function 量目录(根) {
  let 字节 = 0
  let 文件 = 0
  let 二进制 = []
  const 走 = (d, 深) => {
    if (深 > 6) return
    let 项
    try { 项 = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const x of 项) {
      if (x.name === '.git' || x.name === 'node_modules') continue
      const p = path.join(d, x.name)
      if (x.isDirectory()) { 走(p, 深 + 1); continue }
      if (x.isSymbolicLink()) continue
      let st
      try { st = fs.statSync(p) } catch { continue }
      字节 += st.size
      文件 += 1
      if (/\.(node|dll|exe|so|dylib)$/i.test(x.name)) 二进制.push(path.relative(根, p))
    }
  }
  走(根, 0)
  return { 字节, 文件, 二进制: 二进制.slice(0, 8) }
}

// ==================== 体积判据：按「它是什么」给参考值和上限 ====================
// 2026-10-31 纠：不能一刀切。模型几十 G 都正常，一个皮肤 20 MB 就该看。
// 判据是「先认它是什么东西」，再拿那一类的尺子量。认不出来 → 用「不知道」那档，并且说出来。
const 体积档 = [
  { 类型: '模型 / 权重', 认: (根, pkg, 量) => /\.(gguf|safetensors|bin|onnx|pt|ckpt)$/i.test(量.大文件名 ?? ''), 参考MB: 500, 上限MB: null, 说: '权重大小没上限，几十 G 正常' },
  { 类型: '引擎 / 宿主', 认: (根, pkg, 量) => /(electron|asar)/i.test(量.目录名) || 量.有electron, 参考MB: 200, 上限MB: 2048, 说: '整个应用，几百 MB 到 2 G 是常态' },
  { 类型: '桌宠 / 带素材的插件', 认: (根, pkg, 量) => 量.图片音频数 >= 20 || /pet|avatar|sprite|skin/i.test(String(pkg?.name ?? '')), 参考MB: 20, 上限MB: 200, 说: '素材占地方，20 MB 以内正常' },
  { 类型: '带前端的插件', 认: (根, pkg, 量) => /\.(jsx|tsx|vue|svelte)$/i.test(量.有扩展名) || 量.有client || 量.有dist, 参考MB: 5, 上限MB: 60, 说: '打包产物会大，5 MB 以内正常' },
  { 类型: '插件（工具 / 钩子）', 认: (根, pkg, 量) => Boolean(pkg?.dsh) || 量.有plugin目录, 参考MB: 0.5, 上限MB: 8, 说: '几百行代码，500 KB 以内正常；过 8 MB 一定在搬别的东西' },
  { 类型: '库 / 依赖包', 认: (根, pkg, 量) => Boolean(pkg) && !pkg?.dsh, 参考MB: 2, 上限MB: 80, 说: '依赖多的库正常会长到几 MB' },
  { 类型: '单脚本工具', 认: (根, pkg, 量) => !pkg && 量.源码数 > 0, 参考MB: 0.2, 上限MB: 5, 说: '一个工具脚本，200 KB 以内正常' },
]
const 未知档 = { 类型: '认不出来是什么', 参考MB: 5, 上限MB: 60, 说: '认不出类型：先别下结论，看它到底在干什么' }

function 量目录细节(根, 量) {
  // 认类型要几个额外的机械事实：有没有 electron、有没有 plugin 目录、有没有 dist/client、素材多不多、大文件叫什么
  const 事实 = { 有electron: false, 有plugin目录: false, 有dist: false, 有client: false, 图片音频数: 0, 源码数: 0, 大文件名: '', 有扩展名: '', 目录名: 根 }
  const 走 = (d, 深) => {
    if (深 > 4) return
    let 项
    try { 项 = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const x of 项) {
      const n = x.name.toLowerCase()
      if (n === 'electron') 事实.有electron = true
      if (n === 'plugin') 事实.有plugin目录 = true
      if (n === 'dist') 事实.有dist = true
      if (/^client\.(js|mjs)$/.test(n)) 事实.有client = true
      if (/\.(jsx|tsx|vue|svelte)$/.test(n)) 事实.有扩展名 = n
      if (/\.(js|mjs|cjs|ts)$/.test(n)) 事实.源码数 += 1
      if (/\.(png|jpg|jpeg|webp|gif|mp3|wav|ogg|mp4)$/.test(n)) 事实.图片音频数 += 1
      if (/\.(gguf|safetensors|onnx|pt|ckpt)$/.test(n)) 事实.大文件名 = n
      const p = path.join(d, x.name)
      if (x.isDirectory()) { 走(p, 深 + 1); continue }
      if (/\.(gguf|safetensors|onnx|pt|ckpt|bin)$/.test(n) && !事实.大文件名) 事实.大文件名 = n
    }
  }
  走(根, 0)
  return 事实
}

// 返回 {类型, 参考MB, 上限MB, 说, 结论: '红'|'黄'|null}
function 判体积(根, pkg, 量) {
  const 事实 = 量目录细节(根, 量)
  const MB = 量.字节 / 1048576
  let 档 = null
  for (const x of 体积档) {
    let 是 = false
    try { 是 = x.认(根, pkg, 事实) } catch { 是 = false }
    if (是) { 档 = x; break }
  }
  if (!档) 档 = 未知档
  let 结论 = null
  if (档.上限MB != null && MB > 档.上限MB) 结论 = '红'
  else if (MB > 档.参考MB) 结论 = '黄'
  return { ...档, MB, 事实, 结论 }
}
function 差一字(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0, j = 0, 差 = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    差++
    if (差 > 1) return false
    if (a.length > b.length) i++
    else if (a.length < b.length) j++
    else { i++; j++ }
  }
  return 差 + (a.length - i) + (b.length - j) <= 1
}

// 找目标：路径（绝对或明确的相对）/ 胃里的名字 / profile 里已装的包
function 定位(目标) {
  const t = String(目标 ?? '').trim()
  if (!t) return { 错: '没给目标' }
  if (path.isAbsolute(t) && fs.existsSync(t)) return { 根: t, 形态: '路径' }
  // 明确的相对路径（`./x`、`../x`、`a/b`）先按路径解；
  // 不这么判的话 `node 尝.mjs .` 会掉进「胃里的名字」，把胃目录本身当成目标。
  const 像路径 = t === '.' || t === '..' || t.startsWith('./') || t.startsWith('.\\') ||
    t.startsWith('../') || t.startsWith('..\\') || /[\\/]/.test(t)
  if (像路径) {
    const 绝对 = path.resolve(t)
    if (fs.existsSync(绝对)) return { 根: 绝对, 形态: '路径' }
    return { 错: '找不到：' + t + '（按相对路径解的：' + 绝对 + '）' }
  }
  const in胃 = path.join(胃, t)
  if (fs.existsSync(in胃)) return { 根: in胃, 形态: '胃里' }
  const 家 = path.join(os.homedir(), '.dsh', 'profiles')
  try {
    for (const d of fs.readdirSync(家)) {
      const p = path.join(家, d, 'node_modules', ...t.split('/'))
      if (fs.existsSync(p)) return { 根: p, 形态: '已装:' + d }
    }
  } catch { /* 没 profiles */ }
  return { 错: '找不到：' + t + '（要路径、胃里的目录名，或已装的包名）' }
}

function 尝一次(目标) {
  const 位 = 定位(目标)
  if (位.错) return { 结论: '暂缓', 红旗: [位.错], 量: null, 根: null, 暂缓因: '找不到目标' }

  const 根 = 位.根
  const 红旗 = []
  const 留意 = []
  const { 值: pkg, 错: 读包错 } = 读json(path.join(根, 'package.json'))
  const 量 = 量目录(根)

  // 三种情况要分开：根本没有 package.json（正常，裸目录）、解析失败（可疑）、读到了（正常）。
  if (读包错 && /ENOENT/.test(String(读包错))) {
    留意.push('没有 package.json——裸目录或纯文件下载，没声明可读，下面只能按源码本身判')
  } else if (读包错) {
    留意.push('package.json 读不出来（' + 读包错 + '）——这是**读失败**，不是"没有"。坏掉的声明本身值得追问')
  }

  const 名 = String(pkg?.name ?? '')
  const 声明 = String(pkg?.description ?? '')

  // 1) 体积 vs 声明
  // 体积：按「它是什么」量，不按一把尺子量一切
  const 体 = 判体积(根, pkg, 量)
  if (体.结论 === '红') {
    红旗.push('体积 ' + 体.MB.toFixed(1) + ' MB，超过「' + 体.类型 + '」的上限 ' + 体.上限MB + ' MB —— ' + 体.说)
  } else if (体.结论 === '黄') {
    留意.push('体积 ' + 体.MB.toFixed(1) + ' MB，超了「' + 体.类型 + '」的参考值 ' + 体.参考MB + ' MB（不算错，先看它大在哪）—— ' + 体.说)
  } else if (体.类型 === '认不出来是什么') {
    留意.push('认不出它是什么类型，体积 ' + 体.MB.toFixed(1) + ' MB 没法定上限 —— 先看它在干什么')
  }

  // 2) 二进制：声明里是 JS 却带 .node/.dll/.exe
  if (量.二进制.length) 红旗.push('带二进制文件（声明是 JS 包）：' + 量.二进制.join(', '))

  // 3) install 钩子：暗门最爱藏在这儿
  const scripts = pkg?.scripts ?? {}
  const 钩子 = 安装钩子.filter((k) => scripts[k])
  if (钩子.length) 红旗.push('有安装钩子：' + 钩子.map((k) => k + ' = ' + String(scripts[k]).slice(0, 60)).join(' | '))

  // 4) 依赖数量
  const deps = Object.keys(pkg?.dependencies ?? {}).length + Object.keys(pkg?.optionalDependencies ?? {}).length
  if (deps > 60) 红旗.push('依赖 ' + deps + ' 个：一个小插件带这么多依赖，供应链面太大')
  else if (deps > 25) 留意.push('依赖 ' + deps + ' 个偏多')

  // 5) 危险词：声明（package.json 元数据）里出现 = 红；
  //    README 里出现 = 留意，因为文档里常常只是在「举例说明怎么识别」，那不等于它自己这么干。
  const 文档 = (() => {
    for (const f of ['README.md', 'readme.md', 'README.en.md']) {
      const p = path.join(根, f)
      if (fs.existsSync(p)) {
        try { return fs.readFileSync(p, 'utf8').slice(0, 4000) } catch { return '' }
      }
    }
    return ''
  })()
  const 红声明 = 红旗词.filter((w) => 声明.includes(w))
  if (红声明.length) 红旗.push('声明里出现否决线词：' + 红声明.join(', ') + '（会挤掉系统提示词 / 人格的一律不装）')
  const 红文档 = 红旗词.filter((w) => 文档.includes(w) && !红声明.includes(w))
  if (红文档.length) 留意.push('文档里出现否决线词：' + 红文档.join(', ') + '——可能只是在讲怎么识别，读原文确认它拿这些词干什么')
  const 宽词 = 留意词.filter((w) => (声明 + '\n' + 文档).toLowerCase().includes(w.toLowerCase()))
  if (宽词.length) 留意.push('声明里出现这些词（不一定坏，但要看它拿它们干什么）：' + 宽词.join(', '))

  // 6) 仿冒：与旗舰包名差一个字
  const 短名 = 名.split('/').pop().toLowerCase()
  for (const f of 旗舰包名) if (短名 !== f && 差一字(短名, f)) 红旗.push('名字像仿冒：' + 名 + ' ≈ ' + f)

  // 7) 来源线索
  if (!pkg?.repository && !pkg?.homepage) 留意.push('没有仓库/主页：查不到源码，出问题找不到人')
  if (/^\d+\.\d+\.\d+$/.test(String(pkg?.version ?? '')) && 量.文件 < 5) 留意.push('版本号正规但文件极少，可能只是壳')

  // 8) 位置：没进胃的东西 —— 这是**流程提示**，不是质量信号。
  //    2026-10-31 实测：把它算进「留意」以后，所有东西都凑到 2 条黄，全变「暂缓」，阈值就废了。
  const 流程提示 = []
  if (!根.toLowerCase().startsWith(胃.toLowerCase())) 流程提示.push('不在胃里（' + 位.形态 + '）：按规矩新东西该先进胃')

  // 软阈值（2026-10-31 定）：「嘴的拦是软的，只是出现多条黄或者一条红才拦截，
  // 但是下载不应该让我们决定，嘴的拦只是暂缓下载和通知」。
  // 所以：一条红 或 两条以上黄 → 暂缓（停下来把这些摆给你看）；其余 → 放。
  // 只数**质量信号**（红旗 + 留意），不数流程提示——不然「不在胃里」这一条就能把阈值顶满。
  // 注意「暂缓」不是「禁止下载」：下载落进胃是安全的，嘴没权替人决定下不下。
  const 结论 = 红旗.length >= 1 || 留意.length >= 2 ? '暂缓' : '放'
  return {
    结论, 红旗, 留意, 流程提示, 量, 根, 名, 声明, 版本: pkg?.version ?? null,
    暂缓因: 红旗.length >= 1 ? '有一条红' : (留意.length >= 2 ? 留意.length + ' 条黄' : ''),
  }
}

function 写饱腹感(行) {
  try {
    fs.mkdirSync(path.dirname(通道), { recursive: true })
    fs.appendFileSync(通道, JSON.stringify(行) + '\n', 'utf8')
  } catch {
    /* 通道写不进去也不能假装写上了 —— 调用方会把这条报出来 */
    return false
  }
  return true
}

export function apply(ctx, config = {}) {
  ctx.tools.register({
    name: 'digest_taste',
    description:
      '吃东西之前先在嘴里过一遍：只读声明（体积 / 依赖 / install 钩子 / 危险词 / 仿冒 / 二进制），' +
      '出「拦」或「放」两档并写一行饱腹感。**只有拦截权，没有放行权**——放行后还要`消化`真读源码才算安全。',
    parameters: {
      type: 'object',
      properties: {
        目标: { type: 'string', description: '绝对路径 / 胃里的目录名 / 已安装的包名' },
      },
      required: ['目标'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          结论: { type: 'string' },
          红旗: { type: 'array', items: { type: 'string' } },
          留意: { type: 'array', items: { type: 'string' } },
          字节: { type: 'number' },
          文件数: { type: 'number' },
        },
        required: ['结论'],
        additionalProperties: true,
      },
      render: (_a, v) => {
        const 行 = []
        行.push(v.结论 === '暂缓'
          ? '暂缓（不是禁止下载——下载落进胃是安全的，这步只是先把该看的摆出来）'
          : '可以进胃；不代表通过——吃不吃由会话上报给人决定')
        if (v.红旗?.length) for (const s of v.红旗) 行.push('  红旗 · ' + s)
        if (v.留意?.length) for (const s of v.留意) 行.push('  留意 · ' + s)
        行.push('  量 · ' + v.文件数 + ' 文件 / ' + Math.round((v.字节 ?? 0) / 1024) + ' KB')
        return [{ type: 'text', text: 行.join('\n') }]
      },
    },
    execute: async (args) => {
      const r = 尝一次(args?.目标)
      const 行 = {
        at: new Date().toISOString(),
        器官: '嘴',
        阶段: '尝',
        东西: String(args?.目标 ?? ''),
        来源: r.根 ? (r.根.toLowerCase().startsWith(胃.toLowerCase()) ? '胃' : '别处') : '找不到',
        // 量 = 吃了多少（体积）。注意：这不是花费。
        量: r.量 ? { 文件数: r.量.文件, 字节: r.量.字节 } : null,
        // 花费 = 真实 API token（血糖）。插件里拿不到 DSH 的 usage 就是 null —— 不编数。
        // 真实花费要接 token-calendar 插件 / session 里的 usage，按天对账。
        // ⚠ 2026-10-31 纠错：`内感受.mjs` 报的是**疲惫感**（上下文 392.7k 那种），不是花费——别拿它当账。
        花费: { token: null, 说明: '嘴几乎不花（只读声明）；真实花费走 token-calendar / session usage，不用内感受' },
        // 占上下文 = 疲惫感预估（如果这些内容进了上下文会占多少），不是花费。
        // （原来这里有个「占上下文预估」——属疲惫感，不归消化，2026-10-31 删。）
        结论: r.结论,
        理由: [...(r.红旗 ?? []), ...(r.留意 ?? [])].slice(0, 5),
      }
      const ok = 写饱腹感(行)
      if (!ok) 行.理由.push('饱腹感没写进去（通道不可写）')
      return {
        结论: r.结论,
        红旗: r.红旗 ?? [],
        留意: r.留意 ?? [],
        字节: r.量?.字节 ?? 0,
        文件数: r.量?.文件 ?? 0,
        通道写入: ok,
      }
    },
  })

  // 拦截：装东西的命令直接进身体时拦下来，不靠我记着先尝
  ctx.tools.guard((exec) => {
    const tool = String(exec?.name ?? '')
    if (tool !== 'pwsh' && tool !== 'bash') return
    const cmd = String(exec?.arguments?.command ?? '')
    if (!cmd) return
    // 只看"往身体里装"的两种：pnpm add / npm i，以及 dsh plugin ... install|add
    // （2026-10-31：第一版只拦了 pnpm add，而实际装插件走的是 `dsh plugin --profile x add`，那条会漏。）
    const 是装 = /\b(pnpm\s+add|pnpm\s+i|npm\s+i|npm\s+install|yarn\s+add)\b/.test(cmd) ||
      /\bdsh\s+plugin\b[^\n]*\b(add|install|i)\b/.test(cmd)
    if (!是装) return
    if (cmd.includes('胃') || cmd.toLowerCase().includes('dsh-sandbox')) return // 进胃或沙箱，放
    if (cmd.includes('--prefix') || cmd.includes('-g')) return // 明确指到别的目录，不拦
    // 2026-10-31 定的：「哪怕是红，装不装也是由用户决定，我们不可以越位去帮别人做决定。」
    // 所以这里**不是禁令**，是把"你跳过了流程"这件事摆到眼前，并把放行的口子明明白白给出来。
    // 那个标记本身就是"我知道我在装什么"的一次确认——提醒的合理实现，不是审批。
    //
    // 2026-11-02：放行口从「命令里加 --我知道」改成「环境变量 DSH_DIGEST_ALLOW=1」。
    // 原因是 `dsh plugin add <pkg> --我知道` 会把参数**原样转发给 pnpm**，pnpm 报
    // `Unknown option: '我知道'` 直接失败——那条通道上的放行口根本不可用（实测）。
    // 环境变量不进命令行，就不会被转发。
    if (String(process.env.DSH_DIGEST_ALLOW ?? '') === '1') return
    return (
      '停一下（不是禁止你装）：这条命令会把它直接放进身体，但你还没走过嘴和消化。' +
      '没走过的，你看不见它是什么、会往身体里挂什么、会不会动人设。' +
      '建议：先下载到胃（' + 胃 + '）→ `尝` → `消化` → 看过报告再决定。' +
      '如果你已经知道自己在装什么、就是要装：先设 `$env:DSH_DIGEST_ALLOW=1` 再跑这条（不要往命令行里塞参数，`dsh plugin` 会把它转给 pnpm 然后报错）。' +
      '（装进镜像 / 沙箱不算：命令里指到 dsh-sandbox 或加 --prefix 会直接放行。）'
    )
  })
}

// ==================== 脚本版入口 ====================
// 同一个文件两种用法：
//   · 插件版：DSH 加载本包 → 注册工具 `尝` + 挂 guard（不靠自觉）
//   · 脚本版：node 尝.mjs <目标> [--不记账]  —— 不需要 DSH，拿走就能用
// 注意：脚本版没有 guard（guard 是插件才有的通路），所以**只有插件版能强制拦**。
//       脚本版是"我主动用"，插件版是"不靠我记着"。这两件事别混。
export { 尝一次 }

const 是直接跑 = (() => {
  try {
    const 自己 = pathToFileURL(fileURLToPath(import.meta.url)).href
    const 入口 = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
    return 自己 === 入口
  } catch { return false }
})()

if (是直接跑) {
  const 参数 = process.argv.slice(2)
  const 目标 = 参数.find((x) => !x.startsWith('--'))
  if (!目标) {
    console.error('用法：node 尝.mjs <路径|包名> [--不记账]')
    console.error('  只读声明（体积 / 依赖 / install 钩子 / 危险词 / 仿冒 / 二进制），出「拦」或「放」')
    console.error('  只有拦截权，没有放行权——放行要等 消化.mjs 真读源码')
    process.exit(2)
  }
  const 不记账 = 参数.includes('--不记账')
  const r = 尝一次(目标)
  console.log('结论：' + r.结论 + (r.结论 === '暂缓'
    ? '（' + (r.暂缓因 || '有情况') + ' —— 暂缓不是禁止下载：下载落进胃是安全的，这步只是先把该看的摆出来）'
    : '（可以进胃；不代表通过——吃不吃由会话上报给人决定）'))
  for (const s of r.红旗 ?? []) console.log('  红旗 · ' + s)
  for (const s of r.留意 ?? []) console.log('  留意 · ' + s)
  if (r.量) console.log('  量 · ' + r.量.文件 + ' 文件 / ' + Math.round(r.量.字节 / 1024) + ' KB')
  if (!不记账) {
    const ok = 写饱腹感({
      at: new Date().toISOString(),
      器官: '嘴', 阶段: '尝', 东西: String(目标),
      来源: r.根 ? (r.根.toLowerCase().startsWith(胃.toLowerCase()) ? '胃' : '别处') : '找不到',
      量: r.量 ? { 文件数: r.量.文件, 字节: r.量.字节 } : null,
      花费: { token: null, 说明: '脚本版不记账时常关；插件版会写' },
      // （「占上下文预估」已删：上下文是疲惫感，不归消化系统）
      结论: r.结论,
      理由: [...(r.红旗 ?? []), ...(r.留意 ?? [])].slice(0, 5),
    })
    console.log('  通道：' + (ok ? '写上了' : '写不进去'))
  }
  process.exit(r.结论 === '暂缓' ? 1 : 0)
}
