// _smoke.mjs —— 冒烟测试：不装进 DSH，用假 ctx 把插件壳跑一遍。
//
//   node _smoke.mjs
//
// 验的是「壳有没有接上」：五个工具注册了没有、拦截钩子会不会拦、
// 每个 execute 能不能返回、render 会不会炸。
// 不验判据准不准（那是 消化.mjs 自己的事）。

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from './plugin/index.js'
import { 判扫毒输出 } from './消化.mjs'

const 包根 = path.dirname(fileURLToPath(import.meta.url))
let 过 = 0
let 败 = 0

function 断言(名, 条件, 细节 = '') {
  if (条件) {
    过++
    console.log('  ok   ' + 名)
  } else {
    败++
    console.log('  FAIL ' + 名 + (细节 ? '  ← ' + 细节 : ''))
  }
}

const 工具 = new Map()
const 钩子 = []
const ctx = {
  tools: {
    register(t) {
      if (!t?.name) throw new Error('register 缺 name')
      if (工具.has(t.name)) throw new Error('工具名重复：' + t.name)
      工具.set(t.name, t)
    },
    guard(f) {
      钩子.push(f)
    },
  },
}

apply(ctx)

// 扫毒判定：这段的 bug 只在「杀软真能跑」的机器上才出现，所以必须单测。
console.log('\n扫毒判定')
const 干净输出 = 'Scan starting...\nScan finished.\nScanning C:/x/plugin found no threats.'
断言('found no threats → 扫了·干净', 判扫毒输出(干净输出, 0).结果 === '扫了·干净', 判扫毒输出(干净输出, 0).结果)
const 有毒输出 = 'Scanning C:/x\nThreat detected: EICAR-Test-File'
断言('Threat detected → 扫了·有毒', 判扫毒输出(有毒输出, 2).结果 === '扫了·有毒', 判扫毒输出(有毒输出, 2).结果)
断言('threats found → 扫了·有毒', 判扫毒输出('Scanning x found 1 threats', 2).结果 === '扫了·有毒')
断言('无威胁字样 + 返回 0 → 干净', 判扫毒输出('Scan complete', 0).结果 === '扫了·干净')
断言('非 0 且看不出 → 没扫成', 判扫毒输出('Scan complete', 3).结果 === '没扫成', 判扫毒输出('Scan complete', 3).结果)

console.log('\n注册面')
断言('五个工具都注册了', 工具.size === 5, '实际 ' + 工具.size + '：' + [...工具.keys()].join(','))
for (const n of ['digest_taste', 'digest_run', 'digest_env', 'digest_purge', 'digest_mirror']) {
  断言('有 ' + n, 工具.has(n))
}
断言('工具名都是 ASCII', [...工具.keys()].every((n) => /^[a-zA-Z0-9_-]+$/.test(n)))
for (const [n, t] of 工具) {
  断言(n + ' 有 execute', typeof t.execute === 'function')
  断言(n + ' 有 output.render', typeof t.output?.render === 'function')
}
断言('拦截钩子注册了', 钩子.length === 1, '实际 ' + 钩子.length)

console.log('\n拦截钩子')
const 钩 = 钩子[0]
const 拦 = (name, cmd) => 钩({ name, arguments: { command: cmd } })
断言('pnpm add 被拦', typeof 拦('pwsh', 'pnpm add left-pad') === 'string')
断言('npm install 被拦', typeof 拦('pwsh', 'npm install left-pad') === 'string')
断言('dsh plugin add 被拦', typeof 拦('pwsh', 'dsh plugin add some-plugin') === 'string')
断言('加 --我知道 不再放行（会被转给 pnpm 报错）', typeof 拦('pwsh', 'pnpm add left-pad --我知道') === 'string')
process.env.DSH_DIGEST_ALLOW = '1'
断言('环境变量 DSH_DIGEST_ALLOW=1 放行', 拦('pwsh', 'pnpm add left-pad') === undefined)
delete process.env.DSH_DIGEST_ALLOW
断言('清掉环境变量后又拦', typeof 拦('pwsh', 'pnpm add left-pad') === 'string')
断言('装进胃放行', 拦('pwsh', 'pnpm add left-pad --prefix E:\\sandbox\\胃') === undefined)
断言('非装东西命令不管', 拦('pwsh', 'node build.mjs') === undefined)
断言('别的工具不管', 拦('read', 'pnpm add left-pad') === undefined)
断言('空命令不管', 拦('pwsh', '') === undefined)

console.log('\n各工具 execute')
const 目标 = path.join(包根, 'plugin')

{
  const v = await 工具.get('digest_taste').execute({ 目标 })
  断言('digest_taste 出结论', typeof v.结论 === 'string' && v.结论.length > 0, JSON.stringify(v).slice(0, 120))
  const 行 = 工具.get('digest_taste').output.render({}, v)
  断言('digest_taste render 出文本块', Array.isArray(行) && 行[0]?.type === 'text' && 行[0].text.length > 0)
}

{
  const v = await 工具.get('digest_run').execute({ 目标 })
  断言('digest_run 出结论', typeof v.结论 === 'string' && v.结论.length > 0, JSON.stringify(v).slice(0, 120))
  断言('digest_run 有行数统计', typeof v.红 === 'number' && typeof v.黄 === 'number')
  const 行 = 工具.get('digest_run').output.render({}, v)
  断言('digest_run render 出文本块', Array.isArray(行) && 行[0]?.type === 'text' && 行[0].text.length > 0)
}

{
  const v = await 工具.get('digest_env').execute({})
  断言('digest_env 出有/缺计数', typeof v.有 === 'number' && typeof v.缺 === 'number', JSON.stringify(v))
  const 行 = 工具.get('digest_env').output.render({}, v)
  断言('digest_env render 出文本块', Array.isArray(行) && 行[0]?.type === 'text')
}

{
  // 默认预演：不许真删
  const v = await 工具.get('digest_purge').execute({})
  断言('digest_purge 默认不真排', v.已排 === 0, JSON.stringify(v))
  const 行 = 工具.get('digest_purge').output.render({}, v)
  断言('digest_purge render 出文本块', Array.isArray(行) && 行[0]?.type === 'text')
}

{
  const v = await 工具.get('digest_mirror').execute({})
  断言('digest_mirror 给的是终端命令', typeof v.命令 === 'string' && v.命令.includes('消化系统.mjs'))
  断言('digest_mirror 指向本包（不是别人的工作区）', v.命令.includes(包根))
}

console.log('\n结果：' + 过 + ' 过 / ' + 败 + ' 败')
process.exit(败 === 0 ? 0 : 1)
