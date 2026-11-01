// dsh-reasoning-guard —— 兜圈子刹车 v0.2（2026-11-01）
//
// 它管什么：模型「在重复同一段东西、没有新进展」的时候，让它停下来、换个方向。
//
// 两个接缝，各管一段：
//   1) agent/assistant-stream（emit，旧版就在用）：窗口规则 → cancel。
//      只能观察、只能杀，改不了流——所以它是最后手段。
//   2) llm/stream（waterfall，v0.2 新增）：周期 / 短语池 → 流内切断 + steer。
//      只有 waterfall 能改流：关掉开着的块、补一个 finish{stop}，让这一轮正常收尾。
//
// 为什么切断用 stop 不用 error（loop-guard 踩过的坑，直接记下不重踩）：
//   error finish 会让 step() 不产 assistant/message，UI 渲染拿不到消息节点会崩，
//   而且 turn() 在报错分支抛出去，不会走到「还有没有排队消息」那行——steer 进来的
//   纠正永远没人认领，看起来就是「它突然停了」。stop 走普通路径。
//
// 为什么有 tool-call 块开着时不切：关掉一个半截的 tool-call 会把它commit 进消息，
//   而 step() 会执行任何 tool-call 块——等于拿半截 JSON 去执行。留开它违反协议，
//   两害取轻：放弃这次切断，等它自己结束。

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  feedWindow,
  CycleBreaker,
  IdenticalChunkBreaker,
  PoolBreaker,
  CrossCallDetector,
  WINDOW_DEFAULTS,
} from './detector.js';

export const name = 'dsh-reasoning-guard';
// 必须声明：waterfall / agent 服务没 inject 的话，ctx.agents 一读就抛。
export const inject = ['agents'];

// @deepseek-ai/dsh-llm 的辅助（isAgentLoopRequest / createUserMessage）。
// 为什么不静态 import：插件库目录（桌面）不在 profile 的 node_modules 链上，
// 裸 node 跑自测时解析会失败；DSH 加载时能解析。所以动态取，拿不到就降级：
//   · isAgentLoopRequest 退化成「有 sessionId 且能拿到 agent」——调用点另有一道守卫
//     （只对见过 reasoning/text/tool 增量的调用做跨调用观察），不会把工具流误判成空转。
//   · createUserMessage 退化成手工构造（官方实现也只是补 id + freeze）。
let isAgentLoopRequest = () => true;
let createUserMessage = null;
import('@deepseek-ai/dsh-llm')
  .then((m) => {
    if (typeof m?.isAgentLoopRequest === 'function') isAgentLoopRequest = m.isAgentLoopRequest;
    if (typeof m?.createUserMessage === 'function') createUserMessage = m.createUserMessage;
  })
  .catch(() => {
    /* 自测 / 无 DSH 环境：保持降级 */
  });

function makeNotice(text, summary) {
  if (createUserMessage) {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'reasoning-guard', form: 'notice', summary } });
  }
  return {
    id: 'rg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'reasoning-guard', form: 'notice', summary },
  };
}

// ---------------------------------------------------------------------------
// 自证日志
// ---------------------------------------------------------------------------
// 为什么不用 ctx.logger：宿主日志我读不到。而一个安全阀不写「我活着」，
// 就没法和「没装上」区分——2026-10-25 已经栽过一次（接缝收不到 chunk，静默空转）。
const NOTE = `${os.homedir().replace(/\\/g, '/')}/.dsh/notes/reasoning-guard.log`;
const NOTE_MAX = 512 * 1024;
function writeNote(line) {
  // 2026-11-02：干净机器上 `~/.dsh/notes/` 根本不存在（本机有是因为 DSH 早用过了）。
  // 不建目录就写，会 ENOENT —— 而这条日志正是「我活着」的唯一证据，
  // 它一失败，插件就和「没装上」不可区分。在云电脑上实测抓到（rc.5 + 全新用户）。
  try {
    mkdirSync(path.dirname(NOTE), { recursive: true });
  } catch {
    /* 建不了就往下走，下面的 append 会报出来 */
  }
  try {
    if (statSync(NOTE).size > NOTE_MAX) renameSync(NOTE, NOTE + '.1');
  } catch {
    /* 文件不存在就跳过 */
  }
  try {
    appendFileSync(NOTE, `[${new Date().toISOString()}] ${line}\n`);
  } catch (err) {
    // 写不进不能完全无声：自证手段自己坏掉，就回到「和没装上不可区分」。
    try {
      console.error('[dsh-reasoning-guard] 自证日志写不进:', String(err?.message ?? err));
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
export const DEFAULTS = {
  // 窗口规则（2026-10-25 标定）
  ...WINDOW_DEFAULTS,
  dryRun: false,
  // 周期规则：尾部精确周期的最长周期 / 触发所需的最短跨度 / 周期里至少几个不同字符
  // minDistinct=2：单字符周期（分隔线）由 tailRun 守卫挡掉；2 种字符的周期是真实循环
  // （「对。」「嗯。」周期 3、只有 2 种字符），降到 2 才抓得到。
  cycleMaxPeriod: 512,
  cycleMinSpan: 512,
  cycleMinDistinct: 2,
  // 正文重复用更短的跨度：正文重复比推理重复更少见，可以下手早一点
  textCycleMinSpan: 256,
  // 连续相同 chunk（原版 identical-chunks）：同一 payload 连续这么多次就切
  maxRepeatedText: 60,
  // 短语池：重复行质量 / 覆盖率 / 集中度
  poolMinChars: 2048,
  poolMinCoverage: 0.6,
  poolMinConcentration: 4,
  // 跨调用：包含度阈值 / 连续几步 / 最多打几次 / 材料最短长度 / 交集绝对量下限（0=只看比例）
  crossCallThreshold: 0.8,
  crossCallSteps: 3,
  crossCallFires: 4,
  crossCallMinChars: 2048,
  crossCallMinShared: 0,
  // 反应分档（原版 escalate）：warn=只注入提示 / steer=注入纠正并续跑 / cancel=中止本轮
  escalate: 'steer',
  // 切断后自动续跑（原版 resumeAfterBreak，默认关：坏模型不能悄悄重复计费）
  resumeAfterBreak: false,
  // 同一个 agent 最多切几次（防「模型每轮都循环」时无限切 + 无限 steer）
  maxCutFires: 8,
  // 切断的错误码（原版 breakCode），写进日志方便事后核对
  breakCode: 'REPETITIVE_OUTPUT',
  // 流内切断总开关
  breakOnRepetition: true,
};

const GUARDS = new Map(); // attemptId -> 窗口规则状态

// ---------------------------------------------------------------------------
// 反应
// ---------------------------------------------------------------------------
function notice(text, summary) {
  return makeNotice(text, summary);
}

// 注入纠正。拿不到 agent / steer 不存在都算失败，要留下痕迹——不许静默。
function steer(agent, text, summary, note) {
  if (!agent || typeof agent.steer !== 'function') {
    writeNote(`${note} steer 没执行：拿不到 agent.steer`);
    return false;
  }
  try {
    agent.steer(notice(text, summary));
    writeNote(`${note} 已 steer`);
    return true;
  } catch (err) {
    writeNote(`${note} steer 失败：${String(err?.message ?? err)}`);
    return false;
  }
}

// 只注入提示、不打断（原版 escalate=warn）。
function warnOnly(agent, text, summary, note) {
  if (!agent || typeof agent.inject !== 'function') {
    writeNote(`${note} warn 没执行：拿不到 agent.inject`);
    return false;
  }
  try {
    agent.inject(notice(text, summary));
    writeNote(`${note} 已注入提示（warn）`);
    return true;
  } catch (err) {
    writeNote(`${note} warn 失败：${String(err?.message ?? err)}`);
    return false;
  }
}

// 中止本轮（原版 escalate=cancel）。keepInbox：别顺手清掉排队消息。
function cancelTurn(agent, reason, note) {
  if (!agent || typeof agent.cancel !== 'function') {
    writeNote(`${note} cancel 没执行：agent.cancel 不是函数`);
    return false;
  }
  try {
    agent.cancel({ kind: 'hook', reason: 'dsh-reasoning-guard: ' + reason }, { keepInbox: true });
    writeNote(`${note} 已 cancel（中止在下一个 chunk 生效）`);
    return true;
  } catch (err) {
    writeNote(`${note} cancel 失败：${String(err?.message ?? err)}`);
    return false;
  }
}

// 后判类触发（窗口规则 / 跨调用）按 escalate 分档；流内切断不受这里控制。
function reactByEscalate(agent, o, text, summary, note) {
  if (o.escalate === 'warn') return warnOnly(agent, text, summary, note);
  if (o.escalate === 'cancel') return cancelTurn(agent, text, note);
  return steer(agent, text, summary, note);
}

// 切断后自动续跑（原版 scheduleResume / resumeAfterBreak，默认关）。
// 为什么等 whenIdle：driven 只在 idle 时启动，流内发的 wake 会被静默丢掉；
// 等这一轮真正收尾再 followup，纠正才能落到下一轮。
function scheduleResume(agent, text, summary) {
  const whenIdle = agent?.whenIdle;
  const followup = agent?.followup;
  if (typeof whenIdle !== 'function' || typeof followup !== 'function') {
    writeNote('resumeAfterBreak 没执行：agent 没有 whenIdle/followup');
    return;
  }
  void whenIdle
    .call(agent)
    .then(() => {
      followup.call(agent, notice(text, summary));
      writeNote('resumeAfterBreak 已续跑');
    })
    .catch((err) => writeNote('resumeAfterBreak 失败：' + String(err?.message ?? err)));
}

// 流内切断：关掉所有开着的 text/reasoning 块，补一个 stop finish。
// 有 tool-call 块开着时返回 null（放弃切断）。
// seen = 本次尝试「见过」的所有块（不只看还开着的）：已经 block-end 关掉的正文也算可见，
// 否则会在正文已经输出之后又补一条通知（重复显示）；delta-only 协议下 open 为空时，
// 补的 index 会撞上宿主已经建好的 0 号块，通知被吞、甚至把真正的正文盖掉。
function buildBreakTail(open, rule, correctionText, seen) {
  if (open.some((b) => b.blockType !== 'text' && b.blockType !== 'reasoning')) {
    writeNote(`检测到重复（${rule}），但 tool-call 块开着——不切断`);
    return null;
  }
  const out = [];
  const sorted = [...open].sort((a, b) => a.index - b.index);
  const hasVisibleText = (seen?.textHasNonSpace ?? false) || sorted.some((b) => b.blockType === 'text' && b.text.trim().length > 0);
  let maxIndex = seen?.maxIndex ?? -1;
  for (const b of sorted) {
    maxIndex = Math.max(maxIndex, b.index);
    out.push({ type: 'block-end', index: b.index, block: { type: b.blockType, text: b.text } });
  }
  if (!hasVisibleText && correctionText) {
    out.push({ type: 'block-end', index: maxIndex + 1, block: { type: 'text', text: correctionText } });
  }
  out.push({ type: 'finish', reason: { kind: 'stop' } });
  return out;
}

const CORRECTION = (what, chars) =>
  `你刚才在${what}里重复了同一段内容（至少 ${chars} 字符），已经在原地打转，所以这次回复被切断了。` +
  '不要复述它：回到任务上，直接做下一步。';

// 补进 assistant 消息的那一行（不是给用户看的完整纠正，是切断通知本身）。
const CUT_NOTICE = (what, chars) => `（${what}重复至少 ${chars} 字符，已切断。）`;

const STALL_NOTICE = (steps, detail) =>
  `你已经连续 ${steps} 步在重复同一段推理（${detail}），没有推进任务。` +
  '停止复述，直接执行下一步——哪怕是很小的一步。';

const WHAT = { cycle: '推理', pool: '推理', 'text-cycle': '正文', 'text-pool': '正文', identical: '正文' };

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------
export function apply(ctx, config = {}) {
  const raw = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
  // 配置是外部输入，必须夹紧。坏值一律回落默认，不是夹到下界——
  // 下界是没标定过的数字（2026-10-25 审阅高危 1 的教训）。
  const pick = (v, d, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    if (n < min || n > max) return d;
    return Math.floor(n);
  };
  const asBool = (v, d) => {
    if (v === false || v === 'false' || v === 0 || v === '0') return false;
    if (v === true || v === 'true' || v === 1 || v === '1') return true;
    return d;
  };
  const o = {
    windowChars: pick(raw.windowChars, DEFAULTS.windowChars, 500, 20000),
    minUniqueChars: pick(raw.minUniqueChars, DEFAULTS.minUniqueChars, 10, 500),
    barrenWindows: pick(raw.barrenWindows, DEFAULTS.barrenWindows, 2, 50),
    dryRun: asBool(raw.dryRun, DEFAULTS.dryRun),
    cycleMaxPeriod: pick(raw.cycleMaxPeriod, DEFAULTS.cycleMaxPeriod, 16, 2048),
    cycleMinSpan: pick(raw.cycleMinSpan, DEFAULTS.cycleMinSpan, 64, 8192),
    cycleMinDistinct: pick(raw.cycleMinDistinct, DEFAULTS.cycleMinDistinct, 2, 8),
    textCycleMinSpan: pick(raw.textCycleMinSpan, DEFAULTS.textCycleMinSpan, 64, 8192),
    poolMinChars: pick(raw.poolMinChars, DEFAULTS.poolMinChars, 256, 65536),
    poolMinCoverage: Number.isFinite(Number(raw.poolMinCoverage))
      ? Math.min(1, Math.max(0, Number(raw.poolMinCoverage)))
      : DEFAULTS.poolMinCoverage,
    poolMinConcentration: pick(raw.poolMinConcentration, DEFAULTS.poolMinConcentration, 2, 64),
    crossCallThreshold: Number.isFinite(Number(raw.crossCallThreshold))
      ? Math.min(1, Math.max(0, Number(raw.crossCallThreshold)))
      : DEFAULTS.crossCallThreshold,
    crossCallSteps: pick(raw.crossCallSteps, DEFAULTS.crossCallSteps, 2, 20),
    crossCallFires: pick(raw.crossCallFires, DEFAULTS.crossCallFires, 1, 20),
    crossCallMinChars: pick(raw.crossCallMinChars, DEFAULTS.crossCallMinChars, 256, 65536),
    crossCallMinShared: pick(raw.crossCallMinShared, DEFAULTS.crossCallMinShared, 0, 8192),
    maxRepeatedText: pick(raw.maxRepeatedText, DEFAULTS.maxRepeatedText, 2, 2000),
    maxCutFires: pick(raw.maxCutFires, DEFAULTS.maxCutFires, 1, 100),
    escalate: ['warn', 'steer', 'cancel'].includes(raw.escalate) ? raw.escalate : DEFAULTS.escalate,
    resumeAfterBreak: asBool(raw.resumeAfterBreak, DEFAULTS.resumeAfterBreak),
    breakCode: typeof raw.breakCode === 'string' && raw.breakCode.trim() ? raw.breakCode.trim() : DEFAULTS.breakCode,
    breakOnRepetition: asBool(raw.breakOnRepetition, DEFAULTS.breakOnRepetition),
  };
  // 两个参数互相关联：窗口太窄而阈值太高 → 恒贫瘠，等于全杀。
  // 要求窗口至少是阈值的 10 倍（标定过的比例是 2000 / 50）。
  if (o.windowChars < o.minUniqueChars * 10) o.windowChars = DEFAULTS.windowChars;

  const log = ctx.logger ?? appLogger();

  // 日志必须报「夹紧前后」：只报结果等于把事故藏进一行看起来正常的记录里。
  const diff = [];
  for (const k of Object.keys(DEFAULTS)) {
    if (k === 'dryRun' || k === 'breakOnRepetition') continue;
    if (o[k] !== Number(raw[k])) diff.push(`${k}: ${JSON.stringify(raw[k])} → ${o[k]}`);
  }
  for (const k of ['dryRun', 'breakOnRepetition']) {
    if (String(raw[k]) !== String(o[k])) diff.push(`${k}: ${JSON.stringify(raw[k])} → ${o[k]}`);
  }
  // 探针：dsh-llm 的动态 import 成没成，必须看得见——否则 isAgentLoopRequest 静默变恒真、
  // createUserMessage 静默变手搓，和「装上了但没在跑」是同一个盲区。
  const dshLlm = createUserMessage ? 'real' : 'fallback';
  writeNote(
    `applied v0.2.1 dshLlm=${dshLlm} windowChars=${o.windowChars} minUniqueChars=${o.minUniqueChars} ` +
      `barrenWindows=${o.barrenWindows} cycle=${o.cycleMaxPeriod}/${o.cycleMinSpan}/${o.cycleMinDistinct} ` +
      `identical=${o.maxRepeatedText} pool=${o.poolMinChars}/${o.poolMinCoverage}/${o.poolMinConcentration} ` +
      `cross=${o.crossCallThreshold}/${o.crossCallSteps}/${o.crossCallFires}/${o.crossCallMinChars}/${o.crossCallMinShared} ` +
      `escalate=${o.escalate} resume=${o.resumeAfterBreak} code=${o.breakCode} maxCut=${o.maxCutFires} ` +
      `breakOnRepetition=${o.breakOnRepetition} dryRun=${o.dryRun}` +
      (diff.length ? ` | 夹紧: ${diff.join(', ')}` : '')
  );

  // ---- 接缝 1：窗口规则（旧版行为，保留）----
  const off1 = ctx.on('agent/assistant-stream', ({ agent, frame } = {}) => {
    if (!frame || frame.type !== 'chunk') return;
    const chunk = frame.chunk;
    if (!chunk || typeof chunk !== 'object') return;
    if (chunk.type !== 'reasoning-delta' && chunk.type !== 'reasoning') return;
    const text = typeof chunk.text === 'string' ? chunk.text : '';
    if (!text) return;

    const key = String(frame.attemptId ?? '');
    let g = GUARDS.get(key);
    if (!g) {
      g = { chars: 0, windowBuf: '', windowIndex: 0, uniqHistory: [], barrenStreak: 0, reported: false };
      GUARDS.set(key, g);
    }
    const { state, events } = feedWindow(g, text, o);
    GUARDS.set(key, { ...g, ...state });

    for (const e of events) {
      if (!e.tripped) continue;
      const msg =
        `窗口规则触发：连续 ${e.barrenStreak} 个窗口的不重复字符数低于 ${o.minUniqueChars}` +
        `（最近一格 ${e.uniq} / 累计 ${e.chars} 字符）`;
      log?.warn?.(`[dsh-reasoning-guard] ${msg}`);
      writeNote(`tripped ${msg}`);
      if (o.dryRun) {
        writeNote('dryRun 模式，只记录不动作');
        continue;
      }
      // 窗口规则是后判类：按 escalate 分档（warn / steer / cancel），默认 steer。
      // cancel 只在中止整轮时才用，而且带 keepInbox——别把排队消息一起清掉。
      reactByEscalate(agent, o, msg, `stalled: window (${e.uniq})`, '窗口规则');
    }
  });

  // attempt 结束后清掉窗口状态，别让它无限长。
  const off2 = ctx.on('agent/assistant-stream', ({ frame } = {}) => {
    if (frame && frame.type === 'end') GUARDS.delete(String(frame.attemptId ?? ''));
  });

  // ---- 接缝 2：流内切断 + 跨调用（v0.2 新增）----
  // 跨调用状态按 agent 缓存（WeakMap：agent 被回收就跟着回收）。
  const crossDetectors = new WeakMap();
  // 同一个 agent 切了几次。防「模型每轮都循环」时无限切 + 无限 steer
  // （2026-11-01 隔离环境实测抓到的：假模型固定回循环，切完又切，停不下来）。
  const cutFires = new WeakMap();
  let warnedNoAgent = false;
  const off3 = ctx.on('llm/stream', (options, next) => {
    // 安全阀不能有能力弄坏被守护的东西：waterfall 监听器一抛，整次模型调用就失败。
    // 所以入口整段 try/catch，出错就原样放行。
    try {
      if (!isAgentLoopRequest(options)) return next();
    if (options?.sessionId === undefined) return next();
    const agent = typeof ctx.agents?.get === 'function' ? ctx.agents.get(options.sessionId) : undefined;
    if (!agent) {
      // 只警告一次：拿不到 agent 时这条接缝静默不工作（窗口规则仍兜底），
      // 但每次调用都写一行会把日志刷爆。
      if (!warnedNoAgent) {
        warnedNoAgent = true;
        writeNote('llm/stream 拿不到 agent（sessionId=' + options.sessionId + '）——切流层不工作，只剩窗口规则');
      }
      return next();
    }
    let cross = crossDetectors.get(agent);
    if (!cross) {
      cross = new CrossCallDetector({
        threshold: o.crossCallThreshold,
        steps: o.crossCallSteps,
        maxFires: o.crossCallFires,
        minChars: o.crossCallMinChars,
        minShared: o.crossCallMinShared,
      });
      crossDetectors.set(agent, cross);
    }

    return (async function* wrapped() {
      let reasoning = '';
      let hasOutput = false;
      let sawDelta = false;
      const cycle = new CycleBreaker({ maxPeriod: o.cycleMaxPeriod, minSpan: o.cycleMinSpan, minDistinct: o.cycleMinDistinct });
      const textCycle = new CycleBreaker({ maxPeriod: o.cycleMaxPeriod, minSpan: o.textCycleMinSpan, minDistinct: o.cycleMinDistinct });
      const textIdentical = new IdenticalChunkBreaker({ maxRepeated: o.maxRepeatedText });
      const reasoningPool = new PoolBreaker({
        minChars: o.poolMinChars,
        minCoverage: o.poolMinCoverage,
        minConcentration: o.poolMinConcentration,
      });
      const textPool = new PoolBreaker({
        minChars: o.poolMinChars,
        minCoverage: o.poolMinCoverage,
        minConcentration: o.poolMinConcentration,
      });
      const open = new Map();
      const openBlocks = () => [...open.entries()].map(([index, b]) => ({ index, ...b }));
      // 本次尝试「见过」的块，包括已经 block-end 关闭的。补切断通知时用它判断
      // 可见性和最大 index——只看 open 会在正文已输出后重复补通知，delta-only 协议
      // 下还会把补的 index 撞到宿主已有的块上。
      const seen = { maxIndex: -1, textHasNonSpace: false };

      for await (const chunk of next()) {
        if (typeof chunk.index === 'number' && chunk.index > seen.maxIndex) seen.maxIndex = chunk.index;
        if (chunk.type === 'block-start') open.set(chunk.index, { blockType: chunk.blockType, text: '' });
        else if (chunk.type === 'block-end') open.delete(chunk.index);
        else if (chunk.type === 'reasoning-delta') {
          sawDelta = true;
          reasoning += chunk.text;
          const block = open.get(chunk.index);
          if (block !== undefined) block.text += chunk.text;
        } else if (chunk.type === 'text-delta') {
          sawDelta = true;
          hasOutput = true;
          if (!seen.textHasNonSpace && /\S/.test(chunk.text)) seen.textHasNonSpace = true;
          const block = open.get(chunk.index);
          if (block !== undefined) block.text += chunk.text;
        } else if (chunk.type === 'tool-call-delta') {
          sawDelta = true;
          hasOutput = true;
        }
        yield chunk;

        if (!o.breakOnRepetition) continue;
        try {
          let rule = null;
          let repeated = 0;
          if (chunk.type === 'reasoning-delta') {
            if (cycle.push(chunk.text)) {
              rule = 'cycle';
              repeated = cycle.repeatedChars;
            } else if (reasoningPool.push(chunk.text)) {
              rule = 'pool';
              repeated = reasoningPool.repeatedChars;
            }
          } else if (chunk.type === 'text-delta') {
            // 顺序跟原版一致：连续相同 payload → 短语池 → 字符级周期。
            if (textIdentical.push(chunk.text)) {
              rule = 'identical';
              repeated = textIdentical.repeatedChars;
            } else if (textPool.push(chunk.text)) {
              rule = 'text-pool';
              repeated = textPool.repeatedChars;
            } else if (textCycle.push(chunk.text)) {
              rule = 'text-cycle';
              repeated = textCycle.repeatedChars;
            }
          }
          if (rule === null) continue;

          const fired = cutFires.get(agent) ?? 0;
          if (fired >= o.maxCutFires) {
            writeNote(`cut 预算用完（${fired}/${o.maxCutFires}），这一轮不再切，让它自己结束`);
            continue;
          }
          cutFires.set(agent, fired + 1);

          const what = WHAT[rule] ?? '输出';
          const tail = buildBreakTail(openBlocks(), rule, CUT_NOTICE(what, repeated), seen);
          if (tail === null) continue;
          writeNote(`cut ${rule}，重复至少 ${repeated} 字符（code=${o.breakCode}）`);
          if (!o.dryRun) {
            writeNote('cut 前 steer：' + (steer(agent, CORRECTION(what, repeated), `cut a repeating ${what} at ${repeated} chars`, 'cut') ? 'ok' : 'fail'));
            // 原版 resumeAfterBreak：切断后等这一轮收尾再自动续跑（默认关）。
            if (o.resumeAfterBreak) scheduleResume(agent, CORRECTION(what, repeated), `cut a repeating ${what} at ${repeated} chars`);
          } else {
            writeNote('dryRun 模式，cut 不执行（只记日志）');
            continue;
          }
          for (const c of tail) yield c;
          return;
        } catch (detectorErr) {
          // 检测器自己出错不能弄坏这次调用：跳过这个 chunk，继续原样放行。
          writeNote('检测出错，跳过这个 chunk：' + String(detectorErr?.message ?? detectorErr));
        }
      }

      // 流正常结束：判这一步算不算空转（跨调用规则）。
      // 只在真见过模型增量时才判——否则工具流/空流会被误判成「只有推理没输出」。
      if (!sawDelta) return;
      // 这一轮没被切（正常收尾）：重置 cut 预算——偶发循环不该把预算攒成永久失效。
      cutFires.delete(agent);
      try {
        const reason = cross.observe({ reasoning, hasOutput });
        if (reason !== undefined) log?.debug?.(`[dsh-reasoning-guard] 跨调用：stalled（${reason}）`);
        const fire = cross.takeFire();
        if (fire !== undefined) {
          const detail = fire === 'reasoning-only' ? '只有推理、没有正文和工具调用' : '复述上一段推理、没有新增材料';
          writeNote(`跨调用触发（${fire}），连续 ${o.crossCallSteps} 步`);
          if (!o.dryRun) {
            reactByEscalate(agent, o, STALL_NOTICE(o.crossCallSteps, detail), `stalled: ${fire}`, 'cross');
          } else {
            writeNote('dryRun 模式，跨调用只记录不动作');
          }
        }
      } catch (crossErr) {
        writeNote('跨调用检测出错：' + String(crossErr?.message ?? crossErr));
      }
    })();
    } catch (err) {
      // 入口出错（构造侧）：原样放行，别让安全阀弄坏这次调用。
      // 这条安全的前提：next() 只在生成器体内被调用，构造侧出错时还没调过它。
      // 以后改这里别在构造侧先调 next() 再 catch——那会变成双调 next。
      writeNote('llm/stream 入口出错，原样放行：' + String(err?.message ?? err));
      return next();
    }
  });

  // 卸载时才清理。cordis 的 effect 是「body 立刻执行，返回的函数留到卸载调用」——
  // 写成 ctx.effect(() => { off(); }) 等于一加载就把监听注销掉（2026-10-25 抓过）。
  ctx.effect(
    () => () => {
      off1?.();
      off2?.();
      off3?.();
      GUARDS.clear();
    },
    'dsh-reasoning-guard: dispose'
  );
}

// 宿主没给 ctx.logger 时退化成 console
function appLogger() {
  return {
    warn: (...a) => console.warn(...a),
    info: (...a) => console.info(...a),
    debug: (...a) => console.debug(...a),
  };
}
