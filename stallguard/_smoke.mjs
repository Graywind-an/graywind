// dsh-reasoning-guard 接缝自测（不用加载 DSH）：node _smoke.mjs
//
// 假 ctx 故意照着真 cordis 的语义做：`ctx.on` 返回真能注销的函数，
// `ctx.effect` 的 body 立刻执行、返回值当卸载函数。
// 这样「一加载就把自己注销了」这类错误才会在这里现形。
//
// v0.2 两个接缝都测：
//   agent/assistant-stream（窗口规则 → cancel）
//   llm/stream（周期规则 → 关块 + finish{stop} + steer）
import { apply } from './plugin/index.js';
import { readFileSync } from 'node:fs';
import os from 'node:os';

const NOTE = `${os.homedir().replace(/\\/g, '/')}/.dsh/notes/reasoning-guard.log`;
const CANCEL_MARK = '已 cancel';

let pass = 0,
  fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) {
    pass++;
    console.log('✓ ' + name);
  } else {
    fail++;
    console.log('✗ ' + name + (detail ? '  ' + detail : ''));
  }
};

function lines() {
  try {
    return readFileSync(NOTE, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
const mark = () => lines().length;
const since = (n) => lines().slice(n);

function fakeCtx(warns) {
  const handlers = [];
  let disposers = 0;
  const agents = { get: () => undefined };
  return {
    handlers,
    get disposers() {
      return disposers;
    },
    agents,
    logger: { warn: (m) => warns.push(m), debug: () => {}, info: () => {} },
    on: (ev, fn) => {
      handlers.push([ev, fn]);
      return () => {
        disposers++;
        const i = handlers.findIndex((h) => h[1] === fn);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    effect: (fn) => {
      fn();
    },
  };
}

// 只喂 agent/assistant-stream 的监听（llm/stream 的签名不同）
const feedReasoning = (ctx, agent, attemptId, text) => {
  for (const [ev, fn] of ctx.handlers) {
    if (ev !== 'agent/assistant-stream') continue;
    fn({ agent, frame: { type: 'chunk', attemptId, chunk: { type: 'reasoning-delta', text } } });
  }
};

// 模拟一次 llm/stream 调用：next() 返回 chunk 生成器，收集 wrapped 的全部产出。
async function runStream(ctx, sessionId, chunks) {
  const fn = ctx.handlers.find((h) => h[0] === 'llm/stream')?.[1];
  if (!fn) return { error: '没有 llm/stream handler' };
  ctx.agents.get = () => ctx._agent;
  const options = { sessionId };
  const next = () =>
    (async function* () {
      for (const c of chunks) yield c;
    })();
  const out = [];
  try {
    for await (const c of fn(options, next)) out.push(c);
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
  return { out };
}

// ---- 用例 1：加载后三个监听都在，没被注销 ----
{
  const warns = [];
  const ctx = fakeCtx(warns);
  apply(ctx, { dryRun: false, barrenWindows: 5 });
  const evs = ctx.handlers.map((h) => h[0]).sort();
  ok(
    evs.filter((e) => e === 'agent/assistant-stream').length === 2,
    '① agent/assistant-stream 监听 = 2（chunk + end）',
    evs.join(',')
  );
  ok(evs.includes('llm/stream'), '② llm/stream 监听在');
  ok(ctx.disposers === 0, '③ 加载时没被注销', `注销 ${ctx.disposers} 次`);
}

// ---- 用例 2：窗口规则触发（escalate=cancel 时），缺 cancel 时诚实报告 ----
{
  const warns = [];
  const ctx = fakeCtx(warns);
  const from = mark();
  apply(ctx, { dryRun: false, barrenWindows: 5, escalate: 'cancel' });
  feedReasoning(ctx, { id: 'smoke' }, 'smoke:1', '重'.repeat(12000));
  const tail = since(from);
  ok(tail.some((l) => l.includes('applied') && l.includes('v0.2')), '④ 自证日志写了（v0.2）');
  ok(tail.some((l) => l.includes('tripped')), '⑤ 窗口规则触发');
  ok(tail.some((l) => l.includes('cancel 没执行')), '⑥ 缺 cancel 时诚实报告');
  ok(!tail.some((l) => l.includes(CANCEL_MARK)), '⑦ 缺 cancel 时不谎报已刹车');
}

// ---- 用例 3：窗口规则在 escalate=cancel 时真调用 cancel（对象 cause，只一次） ----
{
  const warns = [];
  const ctx = fakeCtx(warns);
  const from = mark();
  apply(ctx, { dryRun: false, escalate: 'cancel' });
  let calls = 0;
  let cause = null;
  let cancelOpts = null;
  const agent = { id: 'smoke2', cancel: (c, o) => { calls++; cause = c; cancelOpts = o; } };
  for (let i = 0; i < 8; i++) feedReasoning(ctx, agent, 'smoke2:1', '重'.repeat(2000));
  ok(calls === 1, '⑧ 窗口规则真的调用了 cancel（一次）', `实际 ${calls} 次`);
  ok(since(from).filter((l) => l.includes(CANCEL_MARK)).length === 1, '⑨ 日志只记一次');
  ok(cause && cause.kind === 'hook', '⑩ cancel cause 是 { kind:"hook" }', JSON.stringify(cause));
  ok(cancelOpts && cancelOpts.keepInbox === true, '⑩b cancel 带 keepInbox:true（别顺手清掉 inbox）', JSON.stringify(cancelOpts));
}

// ---- 用例 4：高多样性文本不误报（窗口规则） ----
{
  const warns = [];
  const ctx = fakeCtx(warns);
  const from = mark();
  apply(ctx, { dryRun: false });
  const diverse = Array.from({ length: 12000 }, (_, i) => String.fromCharCode(0x4e00 + ((i * 37) % 1500))).join('');
  feedReasoning(ctx, { id: 'smoke3' }, 'smoke3:1', diverse);
  ok(!since(from).some((l) => l.includes('tripped')), '⑪ 高多样性文本不误报');
}

// ---- 用例 5：llm/stream 周期切断（我们的形状：好。写。做。轮转） ----
{
  const warns = [];
  const ctx = fakeCtx(warns);
  const from = mark();
  apply(ctx, { dryRun: false });
  const loop = '好。写。做。'.repeat(400);
  const chunks = [];
  for (let i = 0; i < loop.length; i += 50) chunks.push({ type: 'reasoning-delta', index: 0, text: loop.slice(i, i + 50) });
  let steers = 0;
  ctx._agent = { id: 's1', steer: () => { steers++; } };
  const r = await runStream(ctx, 's1', chunks);
  ok(!r.error, '⑫ llm/stream 包了流且没报错', r.error ?? '');
  const finish = r.out?.find((c) => c.type === 'finish');
  ok(!!finish && finish.reason?.kind === 'stop', '⑬ 切流收尾 = finish{stop}（不是 error）', JSON.stringify(finish ?? null));
  ok(steers === 1, '⑭ 切断前 steer 了一次纠正', `steer ${steers} 次`);
  ok(
    r.out?.some((c) => c.type === 'block-end' && c.block?.type === 'text'),
    '⑭b reasoning-only 切断补了可见 text 块（不撞空回复守卫）'
  );
  ok(since(from).some((l) => l.includes('cut cycle')), '⑮ 日志记了 cut cycle');
}

// ---- 用例 6：高多样性文本不被 llm/stream 切断 ----
{
  const warns = [];
  const ctx = fakeCtx(warns);
  apply(ctx, { dryRun: false });
  const diverse = Array.from({ length: 20000 }, (_, i) => String.fromCharCode(0x4e00 + ((i * 37) % 1500))).join('');
  const chunks = [];
  for (let i = 0; i < diverse.length; i += 50) chunks.push({ type: 'reasoning-delta', index: 0, text: diverse.slice(i, i + 50) });
  let steers = 0;
  ctx._agent = { id: 's2', steer: () => { steers++; } };
  const r = await runStream(ctx, 's2', chunks);
  ok(!r.error, '⑯ 高多样性流没报错', r.error ?? '');
  ok(!r.out?.some((c) => c.type === 'finish' && c.reason?.kind === 'stop'), '⑰ 高多样性不被切断');
  ok(steers === 0, '⑱ 高多样性不 steer');
}

// ---- 用例 5b：escalate=warn → 窗口规则只 inject，不 cancel ----
{
  const warns = [];
  const ctx = fakeCtx(warns);
  apply(ctx, { dryRun: false, escalate: 'warn' });
  let injects = 0;
  let cancels = 0;
  const agent = { id: 'warn1', inject: () => { injects++; }, cancel: () => { cancels++; } };
  for (let i = 0; i < 8; i++) feedReasoning(ctx, agent, 'warn1:1', '重'.repeat(2000));
  ok(injects === 1 && cancels === 0, '⑤b escalate=warn → 只 inject 不 cancel', `inject=${injects} cancel=${cancels}`);
}

// ---- 用例 5c：连续相同 chunk → 切断 ----
{
  const warns = [];
  const ctx = fakeCtx(warns);
  apply(ctx, { dryRun: false });
  const chunks = [];
  for (let i = 0; i < 70; i++) chunks.push({ type: 'text-delta', index: 0, text: '做' });
  ctx._agent = { id: 's4', steer: () => {} };
  const r = await runStream(ctx, 's4', chunks);
  const finish = r.out?.find((c) => c.type === 'finish');
  ok(!!finish && finish.reason?.kind === 'stop', '⑤c 相同 chunk 70 次 → 切断 finish{stop}', JSON.stringify(finish ?? null));
}

// ---- 用例 6b：正文循环（已有可见 text）→ 切断不补第二条通知 ----
{
  const warns = [];
  const ctx = fakeCtx(warns);
  apply(ctx, { dryRun: false });
  const loopText = '重复的正文。'.repeat(300);
  const chunks = [];
  for (let i = 0; i < loopText.length; i += 50) chunks.push({ type: 'text-delta', index: 0, text: loopText.slice(i, i + 50) });
  ctx._agent = { id: 's3', steer: () => {} };
  const r = await runStream(ctx, 's3', chunks);
  const textBlocks = r.out?.filter((c) => c.type === 'block-end' && c.block?.type === 'text') ?? [];
  ok(!r.error, '⑱b 正文循环流没报错', r.error ?? '');
  ok(textBlocks.length === 0, '⑱c 正文循环切断不补第二条 text 通知（已有可见正文）', 'text blocks: ' + textBlocks.length);
}

// ---- 用例 7：坏配置回落默认 ----
{
  const warns = [];
  const ctx = fakeCtx(warns);
  apply(ctx, { dryRun: 'false', windowChars: 0, barrenWindows: null });
  ok(ctx.handlers.length === 3, '⑲ 坏配置下仍然加载成功（3 个监听）', String(ctx.handlers.length));
  const applied = lines().slice(-1)[0] ?? '';
  ok(applied.includes('windowChars=2000') && applied.includes('barrenWindows=5'), '⑳ 坏值回落默认值', applied);
  ok(applied.includes('夹紧'), '㉑ 日志写明夹紧前后', applied);
}

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
