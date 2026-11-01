// @local/dsh-digest —— 插件壳
//
// 2026-10-31 定的形态：「把这些小插件融合成为大插件」。
// 所以这个壳把整个消化系统都注册成工具，而不是只有一个 `消化`。
//
// 逻辑全在 ../消化.mjs 与 ../核心/*.mjs，壳只做"把函数包成工具"这一件事。
// 往这里加逻辑 = 两个版本开始分叉，那就白拆了。
//
// 一条取舍：`镜像` 那个工具没注册成插件工具——它要起一个 DSH 内核、跑几十秒到几分钟，
// 塞进工具调用里会卡住整轮。插件里改成给一句"去终端跑"，把长活留在终端。

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { 消化, 渲染 } from '../消化.mjs'
import { 尝一次 } from '../核心/尝.mjs'
import { 跑排泄, 渲染排泄 } from '../核心/排泄.mjs'
import { 查环境, 渲染环境 } from '../核心/建立.mjs'
import { 配置 } from '../核心/配置.mjs'

export const name = 'dsh-digest'
export const inject = ['tools']

function 文本(s) { return [{ type: 'text', text: s }] }

export function apply(ctx, config = {}) {
  // ---------- 尝 ----------
  ctx.tools.register({
    // 2026-11-01：工具名必须是 ASCII。DeepSeek 接口校验 `^[a-zA-Z0-9_-]+$`，
    // 中文名会被整轮拒掉（Invalid 'tools[n].name'），表现就是「每一轮都失败」。
    // 中文留给 description，名字只当调用键。
    name: 'digest_taste',
    description: '吃东西之前先在嘴里过一遍：只读**声明**（体积按类型比 / 依赖 / install 钩子 / 危险词 / 仿冒 / 二进制），出「暂缓」或「放」。只有拦截权，没有放行权——放行要等消化。',
    parameters: { type: 'object', properties: { 目标: { type: 'string', description: '绝对路径 / 胃里的目录名 / 已装包名' } }, required: ['目标'] },
    output: {
      schema: { type: 'object', properties: { 结论: { type: 'string' }, 红旗: { type: 'array', items: { type: 'string' } }, 留意: { type: 'array', items: { type: 'string' } } }, required: ['结论'], additionalProperties: true },
      render: (_a, v) => {
        const L = [v.结论 === '暂缓' ? '暂缓（' + (v.暂缓因 || '有情况') + '）—— 暂缓不是禁止下载' : '可以进胃；不代表通过']
        for (const s of v.红旗 ?? []) L.push('  红旗 · ' + s)
        for (const s of v.留意 ?? []) L.push('  留意 · ' + s)
        for (const s of v.流程提示 ?? []) L.push('  流程 · ' + s)
        return 文本(L.join('\n'))
      },
    },
    execute: async (args) => {
      const r = 尝一次(args?.目标)
      return { 结论: r.结论, 红旗: r.红旗 ?? [], 留意: r.留意 ?? [], 流程提示: r.流程提示 ?? [], 暂缓因: r.暂缓因 ?? '' }
    },
  })

  // ---------- 消化 ----------
  ctx.tools.register({
    name: 'digest_run',
    description: '把进了胃的东西真读一遍：暗门（动态执行/混淆/外连/读凭证/写系统位置/提权/破甲/改提示词）、注册面、声明与实际对不对得上、它能干什么、蛋白质候选、扫毒（外包给用户的杀软）。**不做放行判断，也不决定吃不吃**——报告交给会话，会话上报给人拍板。',
    parameters: { type: 'object', properties: { 目标: { type: 'string', description: '胃里的目录名，或绝对路径' } }, required: ['目标'] },
    output: {
      schema: { type: 'object', properties: { 结论: { type: 'string' }, 红: { type: 'number' }, 黄: { type: 'number' }, 工具数: { type: 'number' } }, required: ['结论'], additionalProperties: true },
      render: (_a, v) => 文本((v.__行 ?? ['消化结论：' + (v.结论 ?? '?')]).join('\n')),
    },
    execute: async (args) => {
      const v = 消化(args?.目标)
      const 行 = 渲染(v)
      return {
        结论: v.结论,
        红: (v.危险项 ?? []).filter((x) => x.级 === '红').length,
        黄: (v.危险项 ?? []).filter((x) => x.级 === '黄').length,
        工具数: v.功能?.工具?.length ?? 0,
        __行: 行,
      }
    },
  })

  // ---------- 环境 ----------
  ctx.tools.register({
    name: 'digest_env',
    description: '先确认有没有虚拟盘/镜像/胃/假模型。缺什么、缺了会怎样、建它要什么代价，一并说清。**建不建由用户决定**——我们只报，不替人建。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'object', properties: { 有: { type: 'number' }, 缺: { type: 'number' } }, required: ['有', '缺'], additionalProperties: true },
      render: (_a, v) => 文本((v.__行 ?? []).join('\n')),
    },
    execute: async () => {
      const r = 查环境()
      return { 有: r.有.length, 缺: r.缺.length, __行: 渲染环境(r) }
    },
  })

  // ---------- 排泄 ----------
  ctx.tools.register({
    name: 'digest_purge',
    description: '清掉"吃完了、装好了、用不着了"的东西：胃里已装成功且消化过的副本、下载残留、超期临时文件。**默认只预演**；真排要 真排=true 且 确认=true 两道开关。说不出是什么的一律不动。',
    parameters: {
      type: 'object',
      properties: {
        天数: { type: 'number', description: '临时文件超过几天算超期，默认 14' },
        真排: { type: 'boolean', description: '真的删（还要 确认=true 才生效）' },
        确认: { type: 'boolean', description: '第二个开关：确认我知道在删什么' },
      },
      required: [],
    },
    output: {
      schema: { type: 'object', properties: { 可排: { type: 'number' }, 已排: { type: 'number' } }, required: ['可排'], additionalProperties: true },
      render: (_a, v) => 文本((v.__行 ?? []).join('\n')),
    },
    execute: async (args) => {
      const r = 跑排泄({ 天数: Number(args?.天数 ?? 14) || 14, 真排: Boolean(args?.真排), 确认: Boolean(args?.确认) })
      return { 可排: r.要排.length, 已排: r.已排, __行: 渲染排泄(r) }
    },
  })

  // ---------- 镜像：只给指路，不在工具里跑 ----------
  ctx.tools.register({
    name: 'digest_mirror',
    description: '镜像装完的验收门：查骨架 / 配置合成 / 插件解析 / 假模型 / 真跑一句 / 注入痕迹，回答"能不能复制到本体"。**这个工具只在终端跑**——它要起一个 DSH 内核，几十秒到几分钟，塞进工具调用会卡住整轮。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'object', properties: { 命令: { type: 'string' } }, required: ['命令'], additionalProperties: true },
      render: (_a, v) => 文本(v.命令),
    },
    execute: async () => ({
      命令: '这一步请到终端跑（它要起内核，跑得久）：\n  node "' + path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '消化系统.mjs') + '" 镜像',
    }),
  })

  // ---------- 拦截：装东西跳过流程时提醒一下 ----------
  // 2026-10-31 从 dsh-taste 搬进来的。原来它在兼容壳里，而那个壳已经被舍弃了；
  // **拦截不能跟着壳一起消失** —— 它是"不靠我记着"的那一半。
  ctx.tools.guard((exec) => {
    const tool = String(exec?.name ?? '')
    if (tool !== 'pwsh' && tool !== 'bash') return
    const cmd = String(exec?.arguments?.command ?? '')
    if (!cmd) return
    const 是装 = /\b(pnpm\s+add|pnpm\s+i|npm\s+i|npm\s+install|yarn\s+add)\b/.test(cmd) ||
      /\bdsh\s+plugin\b[^\n]*\b(add|install|i)\b/.test(cmd)
    if (!是装) return
    if (cmd.includes('胃') || cmd.toLowerCase().includes('dsh-sandbox')) return
    if (cmd.includes('--prefix') || cmd.includes('-g')) return
    // 2026-11-02：放行口改成环境变量。`dsh plugin add <pkg> --我知道` 会把参数原样
    // 转给 pnpm，pnpm 报 `Unknown option: '我知道'` —— 那条通道上的放行口根本不可用（实测）。
    if (String(process.env.DSH_DIGEST_ALLOW ?? '') === '1') return
    return (
      '停一下（不是禁止你装）：这条命令会把它直接放进身体，但你还没走过嘴和消化。' +
      '没走过的，你看不见它是什么、会往身体里挂什么、会不会动人设。' +
      '建议：先下载到胃（' + 配置.胃 + '）→ `尝` → `消化` → 看过报告再决定。' +
      '如果你已经知道自己在装什么、就是要装：先设 `$env:DSH_DIGEST_ALLOW=1` 再跑（别往命令行里塞参数，`dsh plugin` 会转给 pnpm 然后报错）。'
    )
  })
}
