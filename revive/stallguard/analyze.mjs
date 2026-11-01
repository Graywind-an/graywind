// stallguard · 离线分析器（复活包里的独立脚本，不依赖 DSH、不是插件）
//
// 为什么放在复活包里：
//   插件管「活着的时候刹车」，这个管「事后看」——DSH 起不来的时候也能跑，
//   不需要加载任何插件、不需要 DSH 进程。它只读会话文件 + 一个纯函数检测器。
//
// 用法（在复活包目录下）：
//   node analyze.mjs                扫全部会话
//   node analyze.mjs --session ab12 只扫 id 前缀是 ab12 的
//   node analyze.mjs --json         机器可读
//
// 规则和阈值跟插件一致（detector.js 是插件的同一份代码拷来的）：
//   窗口 / 周期 / 短语池 / 跨调用。
// 注意：identical-chunks（连续相同 chunk 60 次）是流式规则，离线整块消息测不了——
//   它只在插件运行时生效，这里不重复实现。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  feedWindow,
  CycleBreaker,
  PoolBreaker,
  CrossCallDetector,
} from './detector.js';

const HOME = os.homedir();
const SESSIONS_ROOT = path.join(HOME, '.dsh', 'sessions');

// 会话文件是多帧 zstd 拼接的，必须按魔数切帧逐帧解（同工作区 memory/lib/sessions.mjs）。
function decodeZstd(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  if (starts.length === 0) return '';
  const parts = [];
  const skip = new Set();
  for (let i = 0; i < starts.length; i++) {
    if (skip.has(i)) continue;
    const s = starts[i];
    const e = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(s, e)));
    } catch {
      if (i + 2 < starts.length) {
        try {
          parts.push(zlib.zstdDecompressSync(buf.subarray(s, starts[i + 2])));
          skip.add(i + 1);
        } catch {
          /* 这一帧解不开，跳过 */
        }
      }
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

function readEvents(sessionDir) {
  const f = path.join(sessionDir, 'session.v4.jsonl.zstd');
  const raw = decodeZstd(f);
  const events = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      events.push(JSON.parse(s));
    } catch {
      /* 坏行跳过 */
    }
  }
  return events;
}

function listSessionDirs() {
  const out = [];
  let projects = [];
  try {
    projects = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const proj of projects) {
    const pdir = path.join(SESSIONS_ROOT, proj.name);
    const nested = proj.name === '_archive' || proj.name === '_lab';
    if (nested) {
      let subs = [];
      try {
        subs = fs.readdirSync(pdir, { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch {
        continue;
      }
      for (const sub of subs) {
        const d = path.join(pdir, sub.name);
        for (const s of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
          if (s.isDirectory() && fs.existsSync(path.join(d, s.name, 'session.v4.jsonl.zstd'))) out.push(path.join(d, s.name));
        }
      }
    } else {
      for (const s of fs.readdirSync(pdir, { withFileTypes: true })) {
        if (s.isDirectory() && fs.existsSync(path.join(pdir, s.name, 'session.v4.jsonl.zstd'))) out.push(path.join(pdir, s.name));
      }
    }
  }
  return out;
}

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const only = args.includes('--session') ? args[args.indexOf('--session') + 1] : undefined;

const split = (text, step = 200) => {
  const out = [];
  for (let i = 0; i < text.length; i += step) out.push(text.slice(i, i + step));
  return out;
};

const summary = [];
for (const dir of listSessionDirs()) {
  const id = path.basename(dir).replace(/^session-/, '');
  if (only && !id.startsWith(only)) continue;
  let evs;
  try {
    evs = readEvents(dir);
  } catch {
    continue;
  }
  const steps = evs
    .filter((e) => e.type === 'assistant/message')
    .map((e) => {
      const content = e.data?.message?.content ?? [];
      const reasoning = content.filter((b) => b?.type === 'reasoning').map((b) => String(b.text ?? '')).join('');
      const text = content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('');
      const hasTool = content.some((b) => b && b.type !== 'reasoning' && b.type !== 'text');
      return { seq: e.seq, reasoning, text, hasOutput: !!text || hasTool };
    });
  if (steps.length === 0) continue;

  let windowTrips = 0;
  for (const s of steps) {
    let buf = { chars: 0, windowBuf: '', windowIndex: 0, uniqHistory: [], barrenStreak: 0, reported: false };
    let tripped = false;
    for (const chunk of split(s.reasoning)) {
      const { state, events } = feedWindow(buf, chunk);
      buf = { ...buf, ...state };
      if (events.some((e) => e.tripped)) tripped = true;
    }
    if (tripped) windowTrips++;
  }

  const cycleTrips = [];
  for (const s of steps) {
    const c = new CycleBreaker({ maxPeriod: 512, minSpan: 512, minDistinct: 2 });
    let tripped = false;
    for (const chunk of split(s.reasoning)) if (c.push(chunk)) tripped = true;
    if (tripped) cycleTrips.push(s.seq);
  }

  const poolTrips = [];
  for (const s of steps) {
    for (const [label, text] of [['推理', s.reasoning], ['正文', s.text]]) {
      if (!text) continue;
      const p = new PoolBreaker({ minChars: 2048, minCoverage: 0.6, minConcentration: 4 });
      let tripped = false;
      for (const chunk of split(text)) if (p.push(chunk)) tripped = true;
      if (tripped) poolTrips.push(`${s.seq}:${label}`);
    }
  }

  const cross = new CrossCallDetector({ threshold: 0.8, steps: 3, maxFires: 4, minChars: 2048 });
  let crossTrips = 0;
  for (const s of steps) {
    cross.observe({ reasoning: s.reasoning, hasOutput: s.hasOutput });
    if (cross.takeFire() !== undefined) crossTrips++;
  }

  summary.push({ id: id.slice(0, 8), steps: steps.length, windowTrips, cycleTrips, poolTrips, crossTrips });
}

if (jsonOut) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  summary.sort((a, b) => b.steps - a.steps);
  console.log('会话        步数  窗口触发  周期触发  池触发  跨调用触发');
  for (const s of summary) {
    const cyc = s.cycleTrips.length ? s.cycleTrips.slice(0, 5).join(',') : '0';
    const pool = s.poolTrips.length ? s.poolTrips.slice(0, 5).join(',') : '0';
    console.log(
      `${s.id}  ${String(s.steps).padStart(4)}  ${String(s.windowTrips).padStart(7)}  ${String(cyc).padStart(8)}  ${String(pool).padStart(6)}  ${String(s.crossTrips).padStart(7)}`
    );
  }
  console.log('\n（窗口/周期/池按「块」计；跨调用按「次」计，最多 4 次）');
  console.log('（identical-chunks 是流式规则，离线测不了；它只在插件运行时生效）');
}
