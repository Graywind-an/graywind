// 本地假模型服务 —— Anthropic Messages 风格 SSE，固定回复。
//
// 目的有两个，都不是"模拟模型"：
//  1) **让整条链路真跑通**（不缺 key、不出网），这样 pre-step / agent/request /
//     注入 / 改动账 才有东西可验；
//  2) **把收到的请求体原样存盘** —— "我的注入到底进没进上下文"这件事，
//     从请求体里直接读，不靠猜、不看日志转述。
//
// 只监听 127.0.0.1，只在隔离沙箱里用。

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const OUT = path.join(ROOT, 'requests')
const PORT = Number(process.env.JIAN_FAKE_PORT || 18999)
const REPLY = process.env.JIAN_FAKE_REPLY || 'ok'
// 可选：第一次请求返回一个 tool_use，让内核真的去调一次工具（验"改动账"要用）
const TOOL = process.env.JIAN_FAKE_TOOL || ''
const TOOL_PATH = process.env.JIAN_FAKE_TOOL_PATH || ''
// 2026-10-31：加一条 —— 允许直接给工具参数 JSON（原来固定发 {file_path}，
// 我们的 尝 / 消化 参数名是「目标」，测的时候永远报「没给目标」，验不出真扫描）。
const TOOL_ARGS = process.env.JIAN_FAKE_TOOL_ARGS || ''

fs.mkdirSync(OUT, { recursive: true })

let seq = 0
let round = 0

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    seq += 1
    let parsed
    try { parsed = JSON.parse(raw) } catch { parsed = raw }
    const file = path.join(OUT, `req-${String(seq).padStart(3, '0')}.json`)
    fs.writeFileSync(file, JSON.stringify({ seq, url: req.url, method: req.method, body: parsed }, null, 2), 'utf8')
    console.error(`[fake-llm] #${seq} ${req.method} ${req.url} bytes=${raw.length} -> ${path.basename(file)}`)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    round += 1
    send('message_start', { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } })
    if (TOOL && round === 1) {
      // 参数解析失败不许把整个响应搞没（2026-10-31 踩过：传了带 \U 的 Windows 路径，
      // JSON.parse 抛错 → 响应根本没发出去 → 看起来像「工具没被调用」，其实是假模型崩了）。
      let 参数 = { file_path: TOOL_PATH }
      if (TOOL_ARGS) {
        try { 参数 = JSON.parse(TOOL_ARGS) } catch (e) { console.error('[fake-llm] TOOL_ARGS 不是合法 JSON，回退 file_path：' + e.message) }
      }
      // 让内核执行一次工具调用（Anthropic Messages 的 tool_use 形状）
      send('content_block_start', {
        type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'toolu_jian_1', name: TOOL, input: {} },
      })
      send('content_block_delta', {
        type: 'content_block_delta', index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(参数) },
      })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })
      send('message_stop', { type: 'message_stop' })
      console.error(`[fake-llm] #${seq} -> tool_use ${TOOL} ${TOOL_PATH}`)
      res.end()
      return
    }
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY } })
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
    send('message_stop', { type: 'message_stop' })
    res.end()
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[fake-llm] listening on http://127.0.0.1:${PORT}  out=${OUT}`)
})
