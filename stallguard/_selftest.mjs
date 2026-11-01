// 检测器自测：node _selftest.mjs
// 只测 plugin/detector.js（零外部依赖，不需要 DSH 环境）。
import {
  feedWindow,
  grams,
  containment,
  trailingCycle,
  periodicTailSpan,
  CycleBreaker,
  IdenticalChunkBreaker,
  PoolBreaker,
  CrossCallDetector,
} from './plugin/detector.js';

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

const diverse = (n) =>
  Array.from({ length: n }, (_, i) => String.fromCharCode(0x4e00 + ((i * 37) % 1500))).join('');

const feedChunks = (text, step = 200) => {
  const out = [];
  for (let i = 0; i < text.length; i += step) out.push(text.slice(i, i + step));
  return out;
};

// ---------- 规则 1：窗口 ----------
{
  let buf = { chars: 0, windowBuf: '', windowIndex: 0, uniqHistory: [], barrenStreak: 0, reported: false };
  let tripped = false;
  for (const c of feedChunks('做'.repeat(12000))) {
    const { state, events } = feedWindow(buf, c);
    buf = { ...buf, ...state };
    if (events.some((e) => e.tripped)) tripped = true;
  }
  ok(tripped, '窗口：重复单字 12000 字符 → 触发');

  buf = { chars: 0, windowBuf: '', windowIndex: 0, uniqHistory: [], barrenStreak: 0, reported: false };
  tripped = false;
  for (const c of feedChunks(diverse(12000))) {
    const { state, events } = feedWindow(buf, c);
    buf = { ...buf, ...state };
    if (events.some((e) => e.tripped)) tripped = true;
  }
  ok(!tripped, '窗口：高多样性 12000 字符 → 不触发');
}

// ---------- 规则 2：周期 ----------
{
  // 我们的形状：好。写。做。轮转（周期 6 字符）
  const loop = '好。写。做。'.repeat(400);
  const span = trailingCycle(loop, 512, 512);
  ok(span > 0, '周期：「好。写。做。」轮转 2400 字符 → 命中', `span=${span}`);
  ok(periodicTailSpan(loop, 512, 512) >= 2000, '周期：报告的真实跨度 ≥2000', 'span=' + periodicTailSpan(loop, 512, 512));

  ok(trailingCycle(diverse(2400), 512, 512) === 0, '周期：高多样性 2400 字符 → 不命中');
  ok(trailingCycle('='.repeat(3000), 512, 512) === 0, '周期：分隔线 ==== 3000 字符 → 不命中（单字符周期护栏）');
  ok(trailingCycle('做'.repeat(12000), 512, 512) === 0, '周期：单字重复交给窗口规则，周期规则不抢（避免双杀）');

  const c = new CycleBreaker({ maxPeriod: 512, minSpan: 512 });
  let tripped = false;
  for (const chunk of feedChunks(loop)) if (c.push(chunk)) tripped = true;
  ok(tripped, '周期：CycleBreaker 流式喂 → 触发一次');
  ok(c.repeatedChars >= 512, '周期：CycleBreaker 报的重复字符 ≥512', 'repeated=' + c.repeatedChars);

  const c2 = new CycleBreaker({ maxPeriod: 512, minSpan: 512 });
  let tripped2 = false;
  for (const chunk of feedChunks(diverse(20000))) if (c2.push(chunk)) tripped2 = true;
  ok(!tripped2, '周期：CycleBreaker 高多样性 20000 字符 → 不触发');

  // 审 2026-11-01 指出的边界：完全相同的短行在流里也是精确周期。
  // 我们接受「同构行重复 ≥32 次算重复」（那本来就是刷屏），但挡住 <3 种字符的周期。
  ok(trailingCycle('=\n'.repeat(300), 512, 512, 3) === 0, '周期：两字符周期（=\\n A 重复）→ 不触发（minDistinct 挡）');
  ok(trailingCycle('对。'.repeat(300), 512, 512, 2) > 0, '周期：两字符集周期（对。对。）→ 命中（minDistinct=2）');
  const sameLine = 'ab\n'.repeat(200);
  ok(trailingCycle(sameLine, 512, 512, 3) > 0, '周期：三字符同构行重复 → 触发（设计内：同构行本身就算重复）');
}

// ---------- 规则 2b：连续相同 chunk ----------
{
  const b = new IdenticalChunkBreaker({ maxRepeated: 60 });
  let trips = 0;
  for (let i = 0; i < 60; i++) if (b.push('做')) trips++;
  ok(trips === 1, '相同 chunk：60 次「做」→ 触发一次');
  ok(b.repeatedChars >= 60, '相同 chunk：报告重复字符 ≥60', 'repeated=' + b.repeatedChars);

  const b2 = new IdenticalChunkBreaker({ maxRepeated: 60 });
  let tripped2 = false;
  for (let i = 0; i < 59; i++) if (b2.push('做')) tripped2 = true;
  ok(!tripped2, '相同 chunk：59 次 → 不触发');

  const b3 = new IdenticalChunkBreaker({ maxRepeated: 60 });
  let tripped3 = false;
  for (let i = 0; i < 120; i++) if (b3.push(i % 2 === 0 ? '做' : '好')) tripped3 = true;
  ok(!tripped3, '相同 chunk：两个 payload 交替 → 不触发');
}

// ---------- 规则 3：短语池 ----------
{
  const lines = ['这一行是在重复的内容', '另一行也在重复', '第三行同样是重复的'];
  const text = (lines.join('\n') + '\n').repeat(120);
  const p = new PoolBreaker({ minChars: 2048, minCoverage: 0.6, minConcentration: 4 });
  let tripped = false;
  for (const chunk of feedChunks(text)) if (p.push(chunk)) tripped = true;
  ok(tripped, '短语池：三行循环 120 遍 → 触发');
  ok(p.repeatedChars >= 2048, '短语池：重复质量 ≥2048', 'repeated=' + p.repeatedChars);

  const p2 = new PoolBreaker({ minChars: 2048, minCoverage: 0.6, minConcentration: 4 });
  let tripped2 = false;
  // 每行都不同 → 没有重复行
  const distinct = Array.from({ length: 200 }, (_, i) => '第' + i + '行：唯一内容' + i).join('\n') + '\n';
  for (const chunk of feedChunks(distinct)) if (p2.push(chunk)) tripped2 = true;
  ok(!tripped2, '短语池：200 行全不同 → 不触发');
}

// ---------- 规则 4：跨调用 ----------
{
  const t = '这是一个重复的推理句子。'.repeat(300); // ≈3600 字符
  const d = new CrossCallDetector({ threshold: 0.8, steps: 3, maxFires: 4, minChars: 2048 });
  ok(d.observe({ reasoning: t, hasOutput: false }) === 'reasoning-only', '跨调用：第一步判 reasoning-only');
  ok(d.observe({ reasoning: t, hasOutput: false }) === 'reasoning-only', '跨调用：第二步判 reasoning-only');
  ok(d.observe({ reasoning: t, hasOutput: false }) === 'reasoning-only', '跨调用：第三步判 reasoning-only');
  ok(d.takeFire() === 'reasoning-only', '跨调用：连续 3 步 → 触发');
  ok(d.takeFire() === undefined, '跨调用：触发后计数重置（不 latch，需再攒 3 步）');

  // repeated-material：有输出、但 reasoning 是上一步的复述
  const d2 = new CrossCallDetector({ threshold: 0.8, steps: 3, maxFires: 4, minChars: 2048 });
  d2.observe({ reasoning: t, hasOutput: true });
  ok(d2.observe({ reasoning: t, hasOutput: true }) === 'repeated-material', '跨调用：有输出但复述上一步 → repeated-material');

  // 新内容 → 进度，清零
  const d3 = new CrossCallDetector({ threshold: 0.8, steps: 3, maxFires: 4, minChars: 2048 });
  d3.observe({ reasoning: t, hasOutput: false });
  d3.observe({ reasoning: t, hasOutput: false });
  const other = '完全不同的推理内容'.repeat(300);
  ok(d3.observe({ reasoning: other, hasOutput: true }) === undefined, '跨调用：新内容 → 不算空转（清零）');
  ok(d3.takeFire() === undefined, '跨调用：清零后不触发');

  // 预算恢复：真进展之后 fires 慢慢回来，不会「用满 4 次就永久失效」。
  const d4 = new CrossCallDetector({ threshold: 0.8, steps: 3, maxFires: 1, minChars: 2048 });
  for (let i = 0; i < 3; i++) d4.observe({ reasoning: t, hasOutput: false });
  ok(d4.takeFire() === 'reasoning-only', '跨调用：预算 1 次 → 第一次触发');
  for (let i = 0; i < 3; i++) d4.observe({ reasoning: other, hasOutput: true }); // 真进展 ×3
  for (let i = 0; i < 3; i++) d4.observe({ reasoning: t, hasOutput: false });
  ok(d4.takeFire() === 'reasoning-only', '跨调用：真进展后预算恢复，还能再触发（不会永久失效）');

  // 短步 + 输出也算进步：工具密集会话 reasoning 都短，不能因此永远不回预算。
  const d5 = new CrossCallDetector({ threshold: 0.8, steps: 3, maxFires: 1, minChars: 2048 });
  for (let i = 0; i < 3; i++) d5.observe({ reasoning: t, hasOutput: false });
  ok(d5.takeFire() === 'reasoning-only', '跨调用：短步用例——先触发一次');
  for (let i = 0; i < 3; i++) d5.observe({ reasoning: '很短', hasOutput: true }); // 短步 + 输出
  for (let i = 0; i < 3; i++) d5.observe({ reasoning: t, hasOutput: false });
  ok(d5.takeFire() === 'reasoning-only', '跨调用：短进步也能恢复预算');
}

// ---------- 公共小件 ----------
{
  ok(containment(grams('abcdefgh'), grams('abcdefgh')) === 1, 'containment：相同集合 = 1');
  ok(containment(grams('abcdefgh'), grams('zzzzzzzz')) === 0, 'containment：不相交 = 0');
  ok(containment(grams('abcdefgh'), grams('abcdefgh'), 100) === 0, 'containment：交集不到 minShared → 0');
}

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
