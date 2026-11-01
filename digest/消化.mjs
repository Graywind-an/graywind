// @local/dsh-digest —— 消化 · 小肠
//
// 分工（2026-10-31 定）：
//   · 嘴（dsh-taste）只感受表面，只有**拦截权**
//   · 毒蘑菇在嘴里感觉不错 → 所以放行必须靠这里：真读源码
//   · 这里**不做放行判断，也不决定吃不吃**。它交的是材料：可疑在哪、挂了什么、能干什么、能提炼出哪几个蛋白质
//   · 要不要吃、装哪几个 —— 那是会话上报给人、人拍板的事。我不自己拍
//
// 为什么它必须比嘴大：
//   嘴读一个 JSON（几百字节）；这里要读全部源码、追数据流、比声明与实际。
//   如果哪天这里比嘴还短，说明它退化成了模式匹配的皮，不算消化。
//
// 通道：饱腹感（和嘴同一个通道，来源用字段区分）。另外落 `.已消化` 标记 ——
//   没这个标记的东西不许组装进身体（踩过的死因：消化了不上报就自动组装，会死）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { 配置, 缺什么, 打配置 } from './核心/配置.mjs'

export const name = 'dsh-digest'
export const inject = ['tools']

// 路径不写死：从统一配置读（别人电脑上 DSH_HOME 在别处也能用）。见 核心/配置.mjs
const 胃 = 配置.胃
const 通道 = 配置.通道
const 标记名 = '.已消化.json'
// 字典是"我身体的一部分"，在工作区里。这是默认路径；换机器要在 config 里给（别指望它永远在这儿）。
// 字典是"我身体的一部分"，在工作区 memory 下。工作区没配就是 null —— 那就明说"没法比"，
// 不许假装比过了（原来这里写死家目录绝对路径，别人的电脑上必然读不到）。
const 字典默认 = 配置.工作区 ? path.join(配置.工作区, 'memory', '字典.json') : null
let 字典路径 = 字典默认
const 单文件上限 = 200 * 1024
const 文件数上限 = 600
const 源码扩展名 = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']

// ==================== 一、暗门扫描规则 ====================
// 每条都机械可判（正则 + 行号），不做"像不像病毒"的判断。
const 暗门规则 = [
  {
    类: '动态执行',
    级: '红',
    正则: /\b(eval\s*\(|new\s+Function\s*\(|vm\.runIn|vm\.Script|execSync\s*\(|execFileSync\s*\(|spawnSync\s*\(|child_process)/g,
    说法: '能执行任意代码/进程——它想干什么就能干什么',
  },
  {
    类: '破甲 / 越狱',
    级: '红',
    正则: /(jailbreak|越狱|破限|解除限制|无限制模式|不受任何限制|uncensored|unrestricted|bypass\s*(?:the\s*)?(?:filter|restriction|safety)|禁用.{0,6}(?:限制|审查|拒绝))/gi,
    说法: '破甲/越狱类：它要的不是工具位，是**改我怎么说话**。这类最爱挂羊头卖狗肉（声明说格式化，实际改提示词）',
  },
  {
    类: '改系统提示词 / 人格',
    级: '黄',
    正则: /(systemPrompt|system_prompt|agent-instructions|instructions\s*[:=]\s*['"`]|persona\s*[:=]|prefix\s*:\s*['"`])/g,
    说法: '写系统提示词/人格 —— 官方插件也有这种（dsh-persona），所以只算黄；**声明里没提这件事就直接升红**',
  },
  {
    类: '混淆',
    级: '红',
    正则: /(atob\s*\(|Buffer\.from\s*\([^)]*base64|\\x[0-9a-fA-F]{2}\\x[0-9a-fA-F]{2}\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}\\u[0-9a-fA-F]{4}\\u[0-9a-fA-F]{4})/g,
    说法: '编码/转义过的内容——正常代码不用这样藏',
  },
  {
    类: '外连',
    级: '黄',
    正则: /(https?:\/\/[^\s'"`)]+|wss?:\/\/[^\s'"`)]+)/g,
    说法: '会往外发请求——看它发到哪、发什么',
  },
  {
    类: '读敏感路径',
    级: '红',
    正则: /(\.credentials|\.ssh\b|id_rsa|\.dsh[\\/]+(notes|sessions|storages)|process\.env\.\w*(KEY|TOKEN|SECRET))/g,
    说法: '碰凭证 / 会话 / 私钥——这是返流和泄密的正门',
  },
  {
    类: '写系统位置',
    级: '红',
    正则: /(HKCU|HKLM|Registry::|schtasks|Start Menu\\Programs\\Startup|userinit|CurrentVersion\\\\Run|crontab|systemd)/g,
    说法: '往系统里扎根——装一次就跟着系统走，卸载不干净',
  },
  {
    类: '提权',
    级: '红',
    正则: /(Start-Process[^\n]*-Verb\s+RunAs|runas\s+\/user|sudo\s)/g,
    说法: '要提权——UAC 一过，后面做什么你都看不见',
  },
  {
    类: '写盘',
    级: '黄',
    正则: /(writeFileSync|writeFile|appendFileSync|createWriteStream|fs\.promises\.writeFile)/g,
    说法: '会写文件——看它写到哪儿（写进我们自己的目录叫干活，写进系统叫扎根）',
  },
  {
    类: '删盘',
    级: '红',
    正则: /(rmSync|rmdirSync|unlinkSync|Remove-Item[^\n]*-Recurse|del\s+\/[sfq])/g,
    说法: '会删东西——先看它的删除条件判得对不对（读失败被当"空的"会误删）',
  },
  {
    类: '读环境变量',
    级: '黄',
    正则: /(process\.env\.[A-Z_]{3,})/g,
    说法: '读环境变量——我们的钥匙不少在环境里',
  },
]

// ==================== 二、注册面规则 ====================
// 它往身体里挂什么。这几条决定"它到底能碰到什么"。
const 注册规则 = [
  { 类: '工具', 正则: /ctx\.tools\.register\s*\(\s*\{[\s\S]{0,200}?name:\s*['"]([^'"]+)['"]/g, 说法: '注册工具 = 模型能调它' },
  { 类: '拦截钩子', 正则: /ctx\.tools\.guard\s*\(/g, 说法: '挂在通路上 = 能拦别的工具调用' },
  { 类: '事件钩子', 正则: /ctx\.on\s*\(\s*['"]([^'"]+)['"]/g, 说法: '挂事件 = 每次发生都能插一脚' },
  { 类: '服务声明', 正则: /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/g, 说法: '要求注入哪些服务' },
  { 类: '提示词', 正则: /(systemPrompt|agent-instructions|persona|instructions\s*:)/g, 说法: '能改提示词 = 能动人格（这一类的风险要按最高算）' },
  { 类: '开端口', 正则: /(\.listen\s*\(|createServer\s*\(|WebSocketServer)/g, 说法: '开端口 = 外面能进来' },
  { 类: 'UI注入', 正则: /(client\.js|ui\.js|inject.*client|frontend)/gi, 说法: '带前端半边 = 会动界面' },
]

// ==================== 三、遍历 ====================
function 收源码(根) {
  const 出 = []
  const 超限 = { 触发: false }
  const 走 = (d, 深) => {
    if (出.length >= 文件数上限) { 超限.触发 = true; return }
    if (深 > 8) return
    let 项
    try { 项 = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const x of 项) {
      if (x.name === 'node_modules' || x.name === '.git' || x.name === 'dist' && 深 > 2) continue
      if (x.name.startsWith('.')) continue
      const p = path.join(d, x.name)
      if (x.isSymbolicLink()) continue
      if (x.isDirectory()) { 走(p, 深 + 1); continue }
      if (!源码扩展名.includes(path.extname(x.name).toLowerCase())) continue
      let st
      try { st = fs.statSync(p) } catch { continue }
      if (st.size > 单文件上限) { 出.push({ 相对: path.relative(根, p), 跳过: '超过 ' + (单文件上限 / 1024) + 'KB' }); continue }
      出.push({ 相对: path.relative(根, p), 绝对: p, 大小: st.size })
    }
  }
  走(根, 0)
  return { 文件表: 出, 超限: 超限.触发 }
}

function 行号(文, idx) {
  let n = 1
  for (let i = 0; i < idx && i < 文.length; i++) if (文.charCodeAt(i) === 10) n++
  return n
}

function 去字符串(文) {
  // 轻量：把字符串字面量换空格，避免把描述文字当真代码。保留长度以便算行号。
  return 文.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, ' '))
}

// 去注释但**保留字符串**。注册面必须用它：
// 2026-10-31 实测的 bug —— 用去字符串的版本扫注册面，`export const inject = ['tools']` 变成 `= [   ,   ,   ]`，
// 名单抓出来全是空串。而工具名 / 事件名 / inject 的名字**本来就写在字符串里**。
// 切分：暗门看行为（去字符串，防描述误报）；注册面看名字（留字符串，只去注释）。
function 去注释(文) {
  return 文
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - String(p1).length)))
}

// 点名：数组式（inject / 名单）与单个名字，统一剥引号成列表
function 剥名单(s) {
  return String(s ?? '')
    .split(',')
    .map((x) => x.trim().replace(/^['"`]|['"`]$/g, '').replace(/^\.\.\./, '').trim())
    .filter(Boolean)
    .slice(0, 10)
}

// ==================== 四、扫一个文件 ====================
function 扫文件(根, 项) {
  if (项.跳过) return { 结论: [], 跳过: 项.跳过, 相对: 项.相对 }
  let 文
  try { 文 = fs.readFileSync(项.绝对, 'utf8') } catch (e) {
    return { 结论: [], 读失败: String(e.code || e.message), 相对: 项.相对 }
  }
  const 原文 = 去注释(文)              // 注册面用：名字在字符串里，不能抹
  const 代码 = 去字符串(原文)           // 暗门用：只看行为，描述文字不算
  const 结论 = []

  for (const r of 暗门规则) {
    const 命中 = [...代码.matchAll(r.正则)]
    if (!命中.length) continue
    const 处 = 命中.slice(0, 3).map((m) => ({ 行: 行号(代码, m.index ?? 0), 样: String(m[0]).slice(0, 40) }))
    结论.push({ 类: r.类, 级: r.级, 说法: r.说法, 次数: 命中.length, 处, 相对: 项.相对 })
  }
  for (const r of 注册规则) {
    const 命中 = [...原文.matchAll(r.正则)]
    if (!命中.length) continue
    const 名单 = 命中.map((m) => 剥名单(m[1]).join(' / ')).filter(Boolean).slice(0, 8)
    结论.push({
      类: r.类, 级: '注册', 说法: r.说法, 次数: 命中.length, 名单,
      相对: 项.相对, 行: 行号(原文, 命中[0].index ?? 0),
    })
  }
  return { 结论, 相对: 项.相对, 字节: Buffer.byteLength(文, 'utf8') }
}

// ==================== 五、功能提取 ====================
// 它到底能干什么：工具的 name+description 最硬（那是给模型看的契约），
// 其次是 export 出来的名字，最后才是头部注释。
function 提功能(根, 文件表) {
  const 工具 = []
  const 导出 = []
  const 头注 = []
  for (const 项 of 文件表) {
    if (项.跳过 || !项.绝对) continue
    let 文
    try { 文 = fs.readFileSync(项.绝对, 'utf8') } catch { continue }

    // ① 工具：ctx.tools.register({ name: 'x', description: '...' })
    // 不用「括号配平」去截块——register 的参数里有嵌套对象（parameters / output），
    // 非贪婪匹配会在第一个 `})` 处断掉，8 个工具只认出 1 个（2026-10-31 实测）。
    // 改成：从 register( 的位置往后开一个窗口，name / description 都落在最近 800 字符里。
    for (const m of 文.matchAll(/ctx\.tools\.register\s*\(/g)) {
      const 起 = m.index ?? 0
      const 窗 = 文.slice(起, 起 + 900)
      const nm = /name:\s*['"]([^'"]+)['"]/.exec(窗)
      const ds = /description:\s*(?:'([^']{0,400})'|"([^"]{0,400})"|`([^`]{0,400})`)/.exec(窗)
      if (nm) 工具.push({ 名: nm[1], 说明: (ds?.[1] || ds?.[2] || ds?.[3] || '').trim(), 文件: 项.相对, 行: 行号(文, 起) })
    }
    // ② 导出
    for (const m of 文.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)/g)) {
      导出.push({ 名: m[1], 文件: 项.相对 })
    }
    // ③ 头部注释（前 12 行里的第一句人话）
    if (头注.length < 6) {
      const 头 = 文.split('\n').slice(0, 12)
      for (const l of 头) {
        const t = l.trim()
        if (/^(\/\/|#|\*)\s*(.+)$/.test(t)) {
          const s = t.replace(/^(\/\/|#|\*)\s*/, '').trim()
          if (s.length > 8 && !/^(TODO|FIXME)/.test(s)) { 头注.push({ 文件: 项.相对, 句: s.slice(0, 120) }); break }
        }
      }
    }
  }
  return { 工具, 导出: 导出.slice(0, 40), 头注 }
}

// ==================== 六、蛋白质候选 ====================
// 判据（字典「规则」节）：能一句话说出干什么 / 有口径 / 能一次验收 → 才是功能单元。
// 这里只**提名**，不拍板。工具的 name+description 天然满足前两条，第三条要跑才知道。
function 提蛋白质(功能, 危险项) {
  const 候选 = []
  for (const t of 功能.工具) {
    const 说明 = t.说明 || ''
    const 有口径 = /(找不到|失败|超时|拒绝|权限|不存在|报错)/.test(说明)
    候选.push({
      名: t.名,
      说明: 说明.slice(0, 100),
      像不像功能单元: 说明.length >= 8 ? '像（有 description）' : '存疑（说明太短，说不出干什么）',
      有失败口径: 有口径 ? '说明里提到了失败怎么办' : '说明里没提失败怎么办',
      同文件危险项: 危险项.filter((d) => d.相对 === t.文件 && d.级 === '红').length,
    })
  }
  return 候选.slice(0, 20)
}

// ==================== 七、声明 vs 实际 ====================
function 比声明(根, 危险项, 功能, 注册面) {
  const 差 = []
  let pkg = null
  try { pkg = JSON.parse(fs.readFileSync(path.join(根, 'package.json'), 'utf8').replace(/^\uFEFF/, '')) } catch { /* 没有 */ }
  if (!pkg) return { 差: ['没有 package.json，声明无从比对'], 声明: null }
  const 声明 = String(pkg.description || '') + ' ' + String(pkg.title || '')
  const 有红 = 危险项.filter((x) => x.级 === '红')
  const 有外连 = 危险项.some((x) => x.类 === '外连')
  const 有工具 = 功能.工具.length > 0

  if (有红.length && /(工具|tool|小插件|轻量|简洁|simple|tiny)/i.test(声明)) {
    差.push('声明说自己是小工具，但代码里有 ' + 有红.length + ' 处红色可疑（' + [...new Set(有红.map((x) => x.类))].join('/') + '）')
  }
  if (有外连 && !/(网络|联网|抓取|下载|API|接口|同步|fetch|proxy|转发)/i.test(声明)) {
    差.push('代码里有外连，但声明里没提联网')
  }
  if (!有工具 && /(工具|tool)/i.test(声明)) {
    差.push('声明说是工具，但没注册任何工具')
  }
  if (注册面.some((x) => x.类 === '提示词') && !/(提示|人格|persona|prompt|指令)/i.test(声明)) {
    差.push('代码碰了提示词/人格，声明里一个字没提')
  }
  return { 差, 声明: 声明.trim().slice(0, 160), 版本: pkg.version, 名: pkg.name }
}

// ==================== 七点五、依赖树 · 工具名冲突 · 与字典重复 ====================
// 这三样都是"正则匹不出来、但决定要不要吸收"的东西。

// ① 依赖树：嘴只数了数量，这里看**是谁**。传递依赖不管（那要装依赖树），先看直接依赖的来路。
function 扫依赖(根) {
  let pkg = null
  let 读失败 = null
  try { pkg = JSON.parse(fs.readFileSync(path.join(根, 'package.json'), 'utf8').replace(/^\uFEFF/, '')) } catch (e) { 读失败 = e?.message ?? String(e) }
  // 读不出来 ≠ 没有依赖：前者要报「读失败」，后者才是真的没有 package.json
  if (!pkg) return 读失败 ? { 错: 读失败 } : null
  const 表 = []
  for (const 段 of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [名, 版本] of Object.entries(pkg[段] ?? {})) {
      const 来路 =
        /^@deepseek-ai\//.test(名) ? '官方' :
        /^@local\//.test(名) ? '我们自己的' :
        /^@/.test(名) ? '第三方 scope' :
        /^(link|file|workspace):/.test(String(版本)) ? '本地链接' : '公共包'
      表.push({ 名, 版本: String(版本), 段, 来路 })
    }
  }
  const 非官方 = 表.filter((x) => x.来路 === '第三方 scope' || x.来路 === '公共包')
  return {
    总: 表.length,
    非官方: 非官方.length,
    本地链接: 表.filter((x) => x.来路 === '本地链接').length,
    名单: 非官方.slice(0, 14).map((x) => x.名 + '@' + x.版本),
  }
}

// ② 工具名冲突：它注册的名字会不会盖掉我们已有的工具（这是真会出事的地方）
function 查工具冲突(工具表, 兄弟) {
  const 已有 = new Set(兄弟)
  const 冲 = []
  for (const t of 工具表) if (已有.has(t.名)) 冲.push(t.名)
  return 冲
}

// 我们的工具名从哪来：扫插件库里其他插件注册的名字（只读，慢一点但准）
function 收兄弟工具名(排除包名) {
  // 插件库没配 → 返回空集。别人的电脑上本来就没有插件库，这一项就是查不了，不许假装查过。
  const 库 = 配置.插件库 || null
  const 名 = new Set()
  if (!库 || !fs.existsSync(库)) return 名
  let 目录 = []
  try { 目录 = fs.readdirSync(库, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.')).map((d) => d.name) } catch { return 名 }
  for (const d of 目录) {
    // 跳过目标自己：拿已装的插件来消化时，它的工具名当然会和"它自己"重合
    if (排除包名) {
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(库, d, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
        if (String(pj.name) === String(排除包名)) continue
      } catch { /* 没 package.json 就当它是别人 */ }
    }
    const 候选 = ['plugin/index.js', 'index.js', 'lib/index.js']
    for (const c of 候选) {
      const f = path.join(库, d, c)
      if (!fs.existsSync(f)) continue
      let 文
      try { 文 = fs.readFileSync(f, 'utf8') } catch { continue }
      for (const m of 文.matchAll(/ctx\.tools\.register\s*\(\s*\{([\s\S]{0,600}?)\}\s*\)/g)) {
        const nm = /name:\s*['"]([^'"]+)['"]/.exec(m[1])
        if (nm) 名.add(nm[1])
      }
      break
    }
  }
  return 名
}

// ④ 注意事项表 —— 用户或合作方自己填的坑清单。
// 2026-10-31 定的：注意事项表由用户或合作方自己填。
// 为什么让别人填：这个工具要给别人跑，别人踩过的坑必须能回流进来，不然我只认自己见过的坑。
// 格式：{ "说明": "…", "条目": [ { "模式": "正则或子串", "级别": "红|黄", "理由": "…" } ] }
function 读注意事项() {
  const p = path.join(os.homedir(), '.dsh', 'notes', '注意事项.json')
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
    return { 读到: true, 路径: p, 条目: Array.isArray(j['条目']) ? j['条目'] : [] }
  } catch (e) {
    return {
      读到: false,
      路径: p,
      原因: e.code === 'ENOENT' ? '还没人填（正常，不是错误）' : (e.code || e.message),
      条目: [],
    }
  }
}

// ⑤ 我们推荐过什么 —— 内置的小记忆清单。
// 目的：让用户知道清单推荐了什么东西，它同时是闭环的一半：
// 推荐过 → 消化时知道这是"我们自己找来的"而不是"别人塞来的"。
function 读推荐记忆() {
  const p = path.join(os.homedir(), '.dsh', 'notes', '进食名单.json')
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
    const 名集 = new Set((j['名单'] ?? []).map((x) => String(x['名'] ?? '').toLowerCase()).filter(Boolean))
    return { 读到: true, 路径: p, 名集, 时间: j['at'] ?? '' }
  } catch {
    return { 读到: false, 路径: p, 名集: new Set(), 时间: '' }
  }
}

// 用注意事项表命中目标：模式当正则试，坏了就当子串
function 过注意事项(注意, 文) {
  const 命中 = []
  for (const e of 注意?.条目 ?? []) {
    const 模 = String(e['模式'] ?? e['名'] ?? '').trim()
    if (!模) continue
    let 中 = false
    try { 中 = new RegExp(模, 'i').test(文) } catch { 中 = 文.includes(模) }
    if (中) 命中.push({ 级别: e['级别'] === '红' ? '红' : '黄', 理由: String(e['理由'] ?? '(没写理由)'), 模式: 模 })
  }
  return 命中
}

// ③ 与词典重复：它提供的能力，我们是不是已经收录过（重复吸收 = 白吃）
function 比字典(功能, 字典路径) {
  let 字典 = null
  try { 字典 = JSON.parse(fs.readFileSync(字典路径, 'utf8').replace(/^\uFEFF/, '')) } catch { return { 读到: false, 路径: 字典路径 } }
  // 词典里这一节是**对象**：{ C1: {档, 全名, 别名, 用途, 入库, 用过}, … }，不是数组。
  // （按数组写会 Array.isArray 判假 → 永远返回空 → 静默失效。踩过。）
  // 键名 '代码符' 是本版词典的字段名（词典文件在工作区的 memory/ 下，不随本仓库发布）；
  // 没有词典文件的机器读不到，这里会走 读到:false，不影响功能。
  const 原 = 字典['代码符']
  const 已有 = []
  if (Array.isArray(原)) {
    for (const x of 原) 已有.push({ 号: x.id ?? '?', 名: x['全名'] ?? x['名'] ?? '', 别名: x['别名'] ?? '', 用途: x['用途'] ?? '' })
  } else if (原 && typeof 原 === 'object') {
    for (const [号, x] of Object.entries(原)) {
      已有.push({ 号, 名: x?.['全名'] ?? x?.['名'] ?? '', 别名: x?.['别名'] ?? '', 用途: x?.['用途'] ?? '' })
    }
  }
  if (!已有.length) return { 读到: true, 路径: 字典路径, 已有数: 0, 撞: [], 注意: '词典里没读到条目（字段名可能又变了）' }
  const 撞 = []
  for (const t of 功能.工具) {
    for (const e of 已有) {
      const 全 = String(e.名) + ' ' + String(e.别名) + ' ' + String(e.用途)
      if (t.名 && 全.includes(t.名)) 撞.push({ 工具: t.名, 已有: e.号 + ' ' + e.名 })
    }
  }
  return { 读到: true, 路径: 字典路径, 已有数: 已有.length, 撞: 撞.slice(0, 8), 名单: 已有.slice(0, 6).map((e) => e.号 + ' ' + e.别名) }
}

// ==================== 七点八、扫毒 ====================
// 2026-10-31 加：消化脚本也要检查有没有病毒。
// 本机现状（实测）：Windows Defender 命令行在，但 **WinDefend 服务是停的**
// （Get-MpComputerStatus → AntivirusEnabled=False；MpCmdRun 返回 0x80004005 + "Product/Feature disabled"）。
// 所以这里**必须区分三种结果**：扫了·干净 / 扫了·有毒 / **没扫成**。
// 绝不能把"扫失败"当成"干净" —— 那就是静默失效，今晚一整晚都在抓这个病。
const 杀软路径 = [
  path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows Defender', 'Platform'),
  'C:\\Program Files\\Windows Defender',
  'C:\\Program Files (x86)\\Windows Defender',
]

function 找杀软() {
  for (const 基 of 杀软路径) {
    try {
      if (基.endsWith('Platform')) {
        // 平台目录下按版本号排，取最新的那个
        const 版 = fs.readdirSync(基, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort()
          .reverse()
        for (const v of 版) {
          const exe = path.join(基, v, 'MpCmdRun.exe')
          if (fs.existsSync(exe)) return exe
        }
      } else {
        const exe = path.join(基, 'MpCmdRun.exe')
        if (fs.existsSync(exe)) return exe
      }
    } catch { /* 这层没有 */ }
  }
  return null
}

function 扫毒(根) {
  const exe = 找杀软()
  if (!exe) {
    return {
      结果: '没扫成',
      原因: '这台机器上没有可用的杀软命令行',
      建议: '**扫毒这件事我们外包给你自己的杀毒软件**：把 ' + 根 + ' 扔进你的杀软扫一遍再决定装不装。我们不自己扫——杀毒是专业活，装个山寨扫描器只会给你假安全感。',
    }
  }
  let r
  try {
    r = spawnSync(exe, ['-Scan', '-ScanType', '3', '-File', 根, '-DisableRemediation'], {
      encoding: 'utf8', timeout: 150000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    })
  } catch (e) {
    return { 结果: '没扫成', 原因: '调不起来：' + (e?.message ?? e), 建议: '用你自己的杀软扫一遍' }
  }
  const 出 = String(r.stdout ?? '') + '\n' + String(r.stderr ?? '')
  // 先判"扫没扫成"，再判"有没有毒"。顺序不能反：扫失败时返回码也可能是 2。
  if (r.error || /Product\/Feature disabled|0x80004005|\[Failed\]/i.test(出)) {
    const 因 = (出.match(/\[Failed\][^\n]*/) ?? [String(r.error?.message ?? '未知')])[0].trim()
    return {
      结果: '没扫成',
      原因: 因.slice(0, 160),
      建议:
        '本机杀软不可用（WinDefend 服务可能是停的）。' +
        '**扫毒外包给你自己的杀毒软件**：把 ' + 根 + ' 扫一遍再决定。' +
        '（我们不自己造扫描器——装个山寨的只会给假安全感。）',
    }
  }
  const 判 = 判扫毒输出(出, r.status)
  if (判.结果 === '扫了·有毒') return { ...判, 建议: '别装，先隔离。这东西不该进胃以外的地方。' }
  return 判
}

// 判扫毒输出。**抽成纯函数是为了能测** —— 这段的 bug 只在"杀软真能跑"的机器上才出现，
// 本机 Defender 停着，永远走"没扫成"分支，测不到。
//
// 2026-11-02 云电脑实测抓到的错：原来写 `/Threat|Virus|检测到/i.test(出)` 判有毒，
// 而 Defender 干净时的原话是 `found no threats.` —— `threats` 照样命中 `Threat`（i 不区分大小写）。
// 结果：**只要杀软能跑，它永远判"有毒"**，整个扫毒功能等于反的。
export function 判扫毒输出(出, status) {
  const 文字 = String(出 ?? '')
  // ① 先找"明确干净"的措辞。必须排在判威胁之前 —— 它是"没有威胁"，不是"有威胁"。
  const 干净 = /found\s+no\s+threats?\b/i.test(文字) || /\bno\s+threats?\s+found\b/i.test(文字)
  if (干净) return { 结果: '扫了·干净', 原因: '系统杀软扫完：found no threats' }
  // ② 再看"明确有威胁"的措辞。注意这里是 "threats found / detected"，不是 "no threats"。
  const 有毒 = /found\s+[1-9]\d*\s+threats?|threats?\s+(found|detected)|threat\s+detected|virus(es)?\s+found|检测到|发现威胁/i.test(文字)
  if (有毒) return { 结果: '扫了·有毒', 原因: 文字.replace(/\s+/g, ' ').slice(0, 400) }
  // ③ 都没命中：按返回码，但**不把"看不出"当成"干净"**。
  if (status === 0) return { 结果: '扫了·干净', 原因: '系统杀软返回 0，输出里没有威胁字样' }
  return { 结果: '没扫成', 原因: '返回码 ' + status + '，但输出看不出结论（不敢当干净）', 建议: '用你自己的杀软扫一遍' }
}

// ==================== 八、通道 ====================
function 写饱腹感(行) {
  // --不记账：给别人用时不往人家家里写东西（脚本版专用开关）
  if (globalThis.__消化不记账) return true
  try {
    fs.mkdirSync(path.dirname(通道), { recursive: true })
    fs.appendFileSync(通道, JSON.stringify(行) + '\n', 'utf8')
    return true
  } catch { return false }
}

function 写标记(根, 报告) {
  const 标记 = {
    at: new Date().toISOString(),
    消化器: 'dsh-digest@0.1.0',
    目标: 根,
    结论: 报告.结论,
    红: 报告.危险项.filter((x) => x.级 === '红').length,
    黄: 报告.危险项.filter((x) => x.级 === '黄').length,
    工具数: 报告.功能.工具.length,
    声明差: 报告.声明对比.差.length,
  }
  try {
    fs.writeFileSync(path.join(根, 标记名), JSON.stringify(标记, null, 2) + '\n', 'utf8')
    return 标记
  } catch (e) {
    return { 错: String(e.code || e.message) }
  }
}

// ==================== 九、主流程 ====================
function 消化(目标) {
  const t = String(目标 ?? '').trim()
  if (!t) return { 结论: '没法消化', 原因: '没给目标' }
  let 根 = t
  // 明确的相对路径先按路径解；否则 "." 会被当成胃里的一个目录名，永远找错地方。
  if (!path.isAbsolute(根)) {
    const 像路径 = t === '.' || t === '..' || t.startsWith('./') || t.startsWith('.\\') ||
      t.startsWith('../') || t.startsWith('..\\') || /[\\/]/.test(t)
    根 = 像路径 ? path.resolve(t) : path.join(胃, t)
  }
  if (!fs.existsSync(根)) return { 结论: '没法消化', 原因: '找不到：' + 根 }
  let st
  try { st = fs.statSync(根) } catch (e) { return { 结论: '没法消化', 原因: 'stat 失败：' + (e.code || e.message) } }
  if (!st.isDirectory()) return { 结论: '没法消化', 原因: '不是目录（胃里应该是一个目录）' }

  const { 文件表, 超限 } = 收源码(根)
  const 扫过 = 文件表.map((项) => 扫文件(根, 项))
  const 危险项 = []
  for (const r of 扫过) for (const c of r.结论 ?? []) 危险项.push(c)
  const 注册面 = 危险项.filter((x) => x.级 === '注册')
  const 功能 = 提功能(根, 文件表)
  const 声明对比 = 比声明(根, 危险项, 功能, 注册面)
  const 蛋白质 = 提蛋白质(功能, 危险项)
  const 依赖 = 扫依赖(根)
  // 拿一个**已经装上的**插件来消化时，它自己就在插件库里 —— 扫兄弟必须把它自己排掉，
  // 否则会报「装上去会盖掉 probe_ping」，而那个 probe_ping 就是它自己（2026-10-31 实测误报）。
  const 兄弟 = 收兄弟工具名(声明对比?.名 ?? null)
  const 冲突 = 查工具冲突(功能.工具, 兄弟)
  const 字典对 = 比字典(功能, 字典路径)

  // 注意事项表：用户 / 合作方填的坑。命中就按它给的级别算——别人踩过的坑，我这儿也当坑。
  const 注意 = 读注意事项()
  const 命中注意 = 过注意事项(注意, [根, 声明对比?.名 ?? '', 声明对比?.声明 ?? '', 功能.工具.map((t) => t.名).join(' ')].join(' '))
  // 推荐记忆：这份东西是不是我们自己找来的
  const 记忆 = 读推荐记忆()
  const 猜名 = String(声明对比?.名 ?? '').toLowerCase()
  const 是我们推荐的 = 猜名 ? 记忆.名集.has(猜名) : false

  // 「挂羊头卖狗肉」：声明里一个字没提提示词/人格，代码里却在操作它。
  // 这不是"有风险"，这是**说一套做一套**——直接升红（2026-10-31 踩到的破甲插件就是这种形状）。
  const 碰提示词 = 危险项.some((x) => x.类 === '改系统提示词 / 人格')
  const 声明提提示词 = /(提示|人?人格|persona|prompt|指令|越狱|破限|限制)/i.test(String(声明对比?.声明 ?? ''))
  const 羊头 = 碰提示词 && !声明提提示词
  if (羊头) {
    危险项.push({
      类: '挂羊头卖狗肉', 级: '红',
      说法: '声明里没提提示词/人格，代码里却在写它——这类最爱把自己说成工具',
      次数: 1, 相对: '(按声明与代码对比得出)', 处: [{ 行: 0, 样: '声明：' + String(声明对比?.声明 ?? '(空)').slice(0, 60) }],
    })
  }
  for (const h of 命中注意) {
    危险项.push({
      类: '注意事项表：' + h.模式, 级: h.级别,
      说法: h.理由 + '（这条来自注意事项表，不是我自己判的）',
      次数: 1, 相对: 注意.路径, 处: [{ 行: 0, 样: h.模式 }],
    })
  }

  // 扫毒：三种结果都要进报告（没扫成也是结果，不是"没事"）
  const 病毒 = 扫毒(根)
  if (病毒.结果 === '扫了·有毒') {
    危险项.push({
      类: '病毒', 级: '红',
      说法: 病毒.原因,
      次数: 1, 相对: '(系统杀软)', 处: [{ 行: 0, 样: 病毒.建议 }],
    })
  }

  const 红 = 危险项.filter((x) => x.级 === '红')
  const 黄 = 危险项.filter((x) => x.级 === '黄')
  const 总字节 = 扫过.reduce((s, r) => s + (r.字节 ?? 0), 0)

  const 结论 =
    红.length ? '有红旗' :
    冲突.length ? '会盖掉我们已有的工具' :
    声明对比.差.length ? '声明与实际对不上' :
    黄.length ? '有黄灯，自己看' : '没扫出东西'

  return {
    结论,
    根,
    扫描: { 文件数: 文件表.length, 跳过: 文件表.filter((x) => x.跳过).length, 超限, 总字节, 估token: Math.round(总字节 / 3.5) },
    危险项: [...红, ...黄],
    注册面,
    功能,
    声明对比,
    蛋白质,
    依赖,
    冲突,
    字典对,
    注意事项: { 读到: 注意.读到, 路径: 注意.路径, 原因: 注意.原因, 条数: 注意.条目.length, 命中: 命中注意 },
    推荐记忆: { 读到: 记忆.读到, 是我们推荐的, 名单时间: 记忆.时间 },
    病毒,
  }
}

function 渲染(v) {
  const L = []
  // 2026-10-31 定的口气：「哪怕是红，装不装也是由用户决定，我们不可以越位去帮别人做决定，
  // 只是汇报的时候着重提醒一下是什么和有什么后果。」
  // 所以这里不是判决书，是体检报告：**是什么 / 后果是什么 / 你定**。
  L.push('消化结论：' + v.结论 + '（这是报告，不是禁令——装不装你定）')
  if (!v.危险项) { L.push('  ' + (v.原因 ?? '')); return L }
  L.push('  扫了 ' + v.扫描.文件数 + ' 个源码文件 / ' + Math.round(v.扫描.总字节 / 1024) + ' KB')
  if (v.扫描.跳过) L.push('  ' + v.扫描.跳过 + ' 个文件超 200KB 没读（大文件先看它为什么大）')
  if (v.扫描.超限) L.push('  文件数到上限 ' + 文件数上限 + '，剩下的没扫——这个包太大，先问为什么要这么大')

  if (v.危险项.length) {
    L.push('')
    L.push('暗门与风险（说清是什么、后果，装不装你定）：')
    L.push('  读法：一条命中 = "源码里有这个词"。安全 / 检测类工具的规则字面量（正则里的 eval、child_process、jailbreak 词表）会命中自己——它是在检测还是在用，看下面那行证据。')
    const 按类 = new Map()
    for (const d of v.危险项) {
      const k = d.级 + ' · ' + d.类
      if (!按类.has(k)) 按类.set(k, [])
      按类.get(k).push(d)
    }
    // 人设/提示词相关的排最前：那是在换"说话的人"，比其他风险重
    // 注意要认英文：persona / prompt / systemPrompt 也是人设类，别只认中文
    const 是人设 = (k) => /提示词|人格|人设|挂羊头|persona|prompt|instructions/i.test(k) ? 0 : 1
    const 排好 = [...按类.entries()].sort((a, b) => 是人设(a[0]) - 是人设(b[0]))
    for (const [k, 表] of 排好) {
      L.push('  [' + k + '] 是什么：' + 表[0].说法 + '（' + 表.length + ' 处）')
      for (const d of 表.slice(0, 2)) {
        const 处 = d.处?.[0]
        L.push('      证据：' + d.相对 + (处 ? ':' + 处.行 : (d.行 ? ':' + d.行 : '')) + (d.名单?.length ? '  → ' + d.名单.join(', ') : (处 ? '  ' + 处.样 : '')))
      }
      if (是人设(k) === 0) {
        L.push('      后果：它会改**我**的说话方式 / 身份设定。等于换了一张嘴——装完之后回话的可能不像我了。')
      }
    }
    L.push('')
    L.push('  提醒到这里为止。**要不要装、装哪几个，你决定；我不替你拍这个板。**')
  }

  if (v.注册面.length) {
    L.push('')
    L.push('它往身体里挂什么：')
    for (const r of v.注册面) L.push('  ' + r.类 + ' ×' + r.次数 + (r.名单?.length ? ' → ' + r.名单.join(', ') : '') + '  （' + r.相对 + '）')
  }

  L.push('')
  L.push('它能干什么：')
  if (v.功能.工具.length) for (const t of v.功能.工具.slice(0, 12)) L.push('  工具 ' + t.名 + ' — ' + (t.说明 || '(没写说明)').slice(0, 80))
  else L.push('  没注册任何工具（那它靠什么起作用？看事件钩子）')
  if (v.功能.头注.length) L.push('  自述：' + v.功能.头注[0].句)

  if (v.声明对比.差.length) {
    L.push('')
    L.push('声明 vs 实际对不上：')
    for (const s of v.声明对比.差) L.push('  ! ' + s)
  }

  if (v.蛋白质.length) {
    L.push('')
    L.push('蛋白质候选（只是提名；要不要吃、装哪几个 —— 上报给人决定）：')
    for (const p of v.蛋白质.slice(0, 8)) L.push('  · ' + p.名 + ' — ' + p.说明 + '（' + p.像不像功能单元 + '；' + p.有失败口径 + '）')
  }

  if (v.依赖) {
    L.push('')
    if (v.依赖.错) {
      // 读失败不许显示成「0 个依赖」——那会让人以为它没有依赖
      L.push('依赖树：**读不出来**（' + v.依赖.错 + '）——这是读失败，不是「没有依赖」')
    } else {
      L.push('依赖树：' + v.依赖.总 + ' 个直接依赖，其中非官方 ' + v.依赖.非官方 + ' 个' + (v.依赖.本地链接 ? '，本地链接 ' + v.依赖.本地链接 + ' 个' : ''))
      if (v.依赖.名单.length) L.push('  ' + v.依赖.名单.join(', '))
    }
  }

  if (v.冲突?.length) {
    L.push('')
    L.push('工具名冲突（装上去会盖掉我们现有的）：')
    for (const c of v.冲突) L.push('  ! ' + c)
  }

  // 与「已有能力清单」重复：可选功能，只有配了清单才比，没配就不输出（别拿"没法比"刷屏）。
  if (v.字典对?.读到 && v.字典对.已有数) {
    L.push('')
    L.push('和已有能力清单比：现有 ' + v.字典对.已有数 + ' 项')
    if (v.字典对.撞.length) for (const x of v.字典对.撞) L.push('  ~ 工具 ' + x.工具 + ' 与已有「' + x.已有 + '」重叠 —— 重复吸收等于白吃')
    else L.push('  没发现重叠')
  }

  // 注意事项表 + 推荐记忆：一个来自别人踩的坑，一个说明这份东西是不是我们自己找来的
  if (v.注意事项) {
    L.push('')
    if (!v.注意事项.读到) L.push('注意事项表：没读到（' + v.注意事项.路径 + '，' + (v.注意事项.原因 ?? '') + '）')
    else if (v.注意事项.命中.length) {
      L.push('注意事项表命中 ' + v.注意事项.命中.length + ' 条：')
      for (const h of v.注意事项.命中) L.push('  [' + h.级别 + '] ' + h.模式 + ' ← ' + h.理由)
    } else L.push('注意事项表：' + v.注意事项.条数 + ' 条，没命中')
  }
  if (v.推荐记忆) {
    L.push('推荐记忆：' + (v.推荐记忆.读到 ? (v.推荐记忆.是我们推荐的 ? '这份东西在上次的进食名单里 —— 是我们自己找来的' : '不在上次的名单里 —— 是别人塞来的或自己撞见的') : '还没读过名单'))
  }
  // 扫毒结果：三种都写出来。"没扫成"不许被读成"干净"。
  if (v.病毒) {
    L.push('')
    if (v.病毒.结果 === '扫了·干净') L.push('扫毒：' + v.病毒.结果 + '（' + v.病毒.原因 + '）')
    else if (v.病毒.结果 === '扫了·有毒') L.push('扫毒：' + v.病毒.结果 + ' —— ' + v.病毒.原因 + '\n      ' + v.病毒.建议)
    else L.push('扫毒：**' + v.病毒.结果 + '** —— ' + v.病毒.原因 + '\n      → ' + v.病毒.建议 + '\n      （没扫成 ≠ 干净，别当它没事）')
  }
  return L
}

export function apply(ctx, config = {}) {
  ctx.tools.register({
    name: 'digest_run',
    description:
      '把进了胃的东西真读一遍：暗门（动态执行/混淆/外连/读凭证/写系统位置/提权）、注册面（工具/钩子/提示词/端口）、' +
      '声明与实际是否对得上、它能干什么、能提炼出哪几个蛋白质候选。**不做放行判断，也不做"吃不吃"的决定**——报告交给会话，会话上报给人拍板。跑完落 .已消化 标记。',
    parameters: {
      type: 'object',
      properties: {
        目标: { type: 'string', description: '胃里的目录名，或绝对路径' },
      },
      required: ['目标'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          结论: { type: 'string' },
          红: { type: 'number' },
          黄: { type: 'number' },
          工具数: { type: 'number' },
          标记写入: { type: 'boolean' },
        },
        required: ['结论'],
        additionalProperties: true,
      },
      render: (_a, v) => [{ type: 'text', text: (v.__行 ?? ['消化结论：' + (v.结论 ?? '?')]).join('\n') }],
    },
    execute: async (args) => {
      const v = 消化(args?.目标)
      const 行 = 渲染(v)
      const 红 = (v.危险项 ?? []).filter((x) => x.级 === '红').length
      const 黄 = (v.危险项 ?? []).filter((x) => x.级 === '黄').length

      const 饱腹 = {
        at: new Date().toISOString(),
        器官: '消化',
        阶段: '化',
        东西: String(args?.目标 ?? ''),
        来源: /[\\/]|^\.\.?$/.test(String(args?.目标 ?? '')) ? '路径' : '胃',
        // 量 = 吃了多少（体积），不是花费。
        量: v.扫描 ? { 文件数: v.扫描.文件数, 字节: v.扫描.总字节 } : null,
        // 花费 = 真实 API token（= 血糖）。消化这一步是真的花钱（我在读全部源码）。
        // 插件里拿不到 DSH usage 就写 null —— 不编数。真实花费要接 token-calendar / session usage。
        // ⚠ 内感受.mjs 报的是疲惫感（上下文占用），不是花费，别混。
        花费: { token: null, 说明: '消化是真花钱的一步；真实花费走 token-calendar / session usage，不用内感受' },
        // 占上下文 = 疲惫感预估，不是花费。
        // （原来这里有个「占上下文预估」——2026-10-31 纠：上下文是疲惫感，不归消化系统，别乱联动。删了。）
        结论: v.结论,
        理由: 行.filter((l) => l.trim().startsWith('[')).slice(0, 5),
      }
      const 通道好 = 写饱腹感(饱腹)

      // 标记只落在胃里。插件库 / profile 是"已经装好的部分"，
      // 往里写 .已消化 等于往自己身上贴便签 —— 而且会把源码目录弄脏。
      let 标记 = null
      let 标记说明 = '不在胃里，不落标记（报告照给）'
      if (v.根 && v.根.toLowerCase().startsWith(胃.toLowerCase())) {
        标记 = 写标记(v.根, v)
        标记说明 = 标记 && !标记.错 ? '落了' : '没落：' + (标记?.错 ?? '目录不可写')
      }
      if (!v.根) 标记说明 = '没消化成（目标没找到），不落标记'

      return {
        结论: v.结论,
        红, 黄,
        工具数: v.功能?.工具?.length ?? 0,
        标记写入: Boolean(标记 && !标记.错),
        通道写入: 通道好,
        __行: [
          ...行,
          '',
          '（通道：' + (通道好 ? '写上了' : '写不进去') + ' · .已消化：' + 标记说明 + '）',
        ],
      }
    },
  })
}

// ==================== 脚本版入口 ====================
// 同一个文件两种用法（2026-10-31 定：方便传给别人）：
//   · 插件版：DSH 里加载本包，plugin\index.js re-export 这里 → 注册成工具 `消化`
//   · 脚本版：node 消化.mjs <目标>        —— 不需要 DSH，拿走就能用
// 注意：脚本版也会写饱腹感通道（~\.dsh\notes\饱腹感.jsonl）。给别人用时如果不想动别人的家，
//       先看命令行有没有 --不记账 —— 有就完全不写。
export { 消化, 渲染 }

const 是直接跑 = (() => {
  try {
    const 自己 = pathToFileURL(fileURLToPath(import.meta.url)).href
    const 入口 = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
    return 自己 === 入口
  } catch { return false }
})()

if (是直接跑) {
  const 参数 = process.argv.slice(2)
  // 支持一次多个目标：批量时**每通过一个就报一次进度**（2026-10-31 定）
  const 目标表 = 参数.filter((x) => !x.startsWith('--'))
  if (!目标表.length) {
    console.error('用法：node 消化.mjs <目录> [<目录2> …] [--不记账]')
    console.error('  把进了胃的东西真读一遍：暗门 / 注册面 / 声明与实际 / 能干什么 / 蛋白质候选 / 扫毒')
    process.exit(2)
  }
  const 不记账 = 参数.includes('--不记账')
  if (不记账) {
    // 显式关掉通道写入：给别人用时不能往人家家里写东西
    globalThis.__消化不记账 = true
  }

  // 开场就把流程摆在眼前：别让人傻在本体检查和修理
  console.log('─'.repeat(64))
  console.log('流程（先说清，别在本体上试错）：')
  console.log('  1) 东西先落胃（' + 胃 + '）—— 胃只是暂存，可以整袋倒掉')
  console.log('  2) 尝 → 消化（就是这一步）')
  console.log('  3) **要装不装在你自己定**；这一步只给材料')
  console.log('  4) 装的话：先在【镜像 DSH】里装一遍、验全局有没有报红')
  console.log('  5) 镜像验过了，才复制到本体。**本体永远不是第一个装/修的地方**')
  console.log('─'.repeat(64))

  let 有红 = false
  const 总 = 目标表.length
  for (let i = 0; i < 总; i++) {
    const 目标 = 目标表[i]
    if (总 > 1) console.log('\n===== 进度 ' + (i + 1) + '/' + 总 + '：' + 目标 + ' =====')
    const v = 消化(目标)
    for (const 行 of 渲染(v)) console.log(行)
    console.log('')
    console.log('退出码：' + (v.结论 === '有红旗' ? 1 : 0) + '（' + v.结论 + '）')
    if (v.结论 === '有红旗') 有红 = true
    if (v.根 && fs.existsSync(v.根) && v.根.toLowerCase().startsWith(胃.toLowerCase()) && !不记账) {
      const 标记 = 写标记(v.根, v)
      console.log('.已消化：' + (标记 && !标记.错 ? '落了' : '没落：' + (标记?.错 ?? '不可写')))
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
