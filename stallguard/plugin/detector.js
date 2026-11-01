// dsh-reasoning-guard 检测器 —— 四条规则，各管一段
//
// 来路（2026-11-01 夜）：
//   旧版只有「窗口」一条规则：2000 字符窗口里不重复字符 < 50、连续 5 窗。
//   它抓「做做做」有效（2026-10-25 拿 969 个真实窗口标定过），但看不见三种形状：
//     a) 同一结论换说法——字汇正常，窗口不贫瘠，它不报；
//     b) 正文自己刷屏——旧版故意不判正文（正文为空才是坏掉的征兆），但正文重复也是坏的；
//     c) 模型在单次调用里输出几千字同一句话——调用永远不结束，后判永远等不到。
//   这一版加的周期 / 短语池 / 跨调用三条，思路是从 @mrweicodes/dsh-loop-guard 的
//   公开说明和实测里学的。**代码是我们自己的写法，判据用我们自己的数字**，两处关键取舍：
//     1) 用**精确周期**而不是熵比。熵比随长度上升：markdown 表格 0.72、JSON 0.84、
//        真循环 0.92–0.99，差 0.06 没法定阈值；精确周期对表格/日志/JSON 一律是 0。
//     2) 跨调用用**包含度**（containment）而不是 Jaccard：卡住的模型会「复述上一步 +
//        补一句」，Jaccard 被新内容稀释，包含度直接报重复。
//
// 四条规则各管的时间尺度：
//   窗口  —— 跨步骤的「体温」：字汇密度塌了
//   周期  —— 单次调用内、字符级：一段短周期在精确重复
//   短语池 —— 单次调用内、行级：同一批短句重排
//   跨调用 —— 步骤之间：同一结论反复出现

export const GRAM_SIZE = 4;

// 周期规则每积累这么多字符重扫一次尾巴。
// 为什么不每 chunk 都扫：单次扫描要比较 maxPeriod 个候选周期、每个最多 need 次，
// 一个 18 万字符的 bleed 每 32 字符扫一次约 5600 次；每 chunk 扫就翻十倍。
const CYCLE_CHECK_STRIDE = 32;

// 短语池只数这么长的行以上。2 是底线：`}` 和 `);` 合法重复，一字符不算证据。
const LINE_MIN_CHARS = 2;

// ---------------------------------------------------------------------------
// 公共小件
// ---------------------------------------------------------------------------

// 定长滑窗集合。用字符窗口而不是分词：中文循环（「好。执行。」）没有空格，
// 按空白分词会塌成一个 token，永远分不出重复。
export function grams(text, size = GRAM_SIZE) {
  const out = new Set();
  for (let i = 0; i + size <= text.length; i++) out.add(text.slice(i, i + size));
  return out;
}

// 一组的 gram 被另一组包含的比例（以较小的一组为分母）。
// minShared：交集的最小绝对量（gram 数）。没有它，上一步 5 万字符、这一步 2 千字符
// 且恰好是它的子集时，会被判成 1.0 的「复述」——那只是引用了其中一小块。
export function containment(a, b, minShared = 0) {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const g of small) if (large.has(g)) shared++;
  if (shared < minShared) return 0;
  return shared / small.size;
}

// ---------------------------------------------------------------------------
// 规则 1：窗口（2026-10-25 标定，继承旧版）
// ---------------------------------------------------------------------------
// 每 windowChars 字符算一次「体温」：窗口内不同字符数。
// minUniqueChars=50：标定数据坏窗口落在 13~39，正常的从 60 往上堆，50 在交界带。
// barrenWindows=5：连续 5 窗才算（只记日志时是 3；真刹车要留余量）。
export const WINDOW_DEFAULTS = { windowChars: 2000, minUniqueChars: 50, barrenWindows: 5 };

export function feedWindow(buf, text, opts = {}) {
  const o = { ...WINDOW_DEFAULTS, ...opts };
  let chars = buf.chars ?? 0;
  let windowBuf = (buf.windowBuf ?? '') + text;
  let windowIndex = buf.windowIndex ?? 0;
  let uniqHistory = [...(buf.uniqHistory ?? [])];
  let barrenStreak = buf.barrenStreak ?? 0;
  let reported = buf.reported ?? false;
  const events = [];

  chars += text.length;
  while (windowBuf.length >= o.windowChars) {
    const win = windowBuf.slice(0, o.windowChars);
    windowBuf = windowBuf.slice(o.windowChars);
    const uniq = new Set(win).size;
    uniqHistory.push(uniq);
    windowIndex++;
    const barren = uniq < o.minUniqueChars;
    if (barren) barrenStreak++;
    else barrenStreak = 0;
    events.push({ windowIndex, uniq, barren, chars });
    if (!reported && barrenStreak >= o.barrenWindows) {
      reported = true;
      events.push({ tripped: true, windowIndex, uniq, barrenStreak, chars });
    }
  }
  return {
    state: { chars, windowBuf, windowIndex, uniqHistory, barrenStreak, reported },
    events,
  };
}

// 旧名保留，外部调用方可能仍用它。
export const feed = feedWindow;

// ---------------------------------------------------------------------------
// 规则 2：字符级精确周期
// ---------------------------------------------------------------------------
// 判据：尾部是不是「一段短周期在精确重复」。
// 两个护栏：① 必须精确——近似重复直接算 0；② 周期里至少两个不同字符——
// `=====` 分隔线合法，一字符周期会把所有长横线判成循环。

// 尾部连续相同字符的长度（`aaaa` 里最后一个 a 所在的那一串）。
export function trailingRunLength(text) {
  const len = text.length;
  if (len === 0) return 0;
  const last = text[len - 1];
  let run = 1;
  while (run < len && text[len - 1 - run] === last) run++;
  return run;
}

// 判定用：找到第一个合格周期就停（返回下限 ≈ minSpan），不扫满整个尾巴。
// minDistinct：一个周期里至少要有几个不同字符。没有它，「完全相同的行」——
// 同构 JSON 元素、`|  |  |` 表头、重复日志行、`});`——在流里本身就是精确周期，
// 正文 256 跨度、32 行同构就够，那是最现实的误切来源。分隔线靠 tailRun 守卫排除，
// 这一条挡的是「整行一模一样」。
export function trailingCycle(text, maxPeriod, minSpan, minDistinct = 0) {
  if (maxPeriod < 1) return 0;
  const len = text.length;
  if (len < minSpan) return 0;
  const tailRun = trailingRunLength(text);
  const periodCap = Math.min(maxPeriod, Math.floor(len / 2));
  for (let period = 1; period <= periodCap; period++) {
    // 尾部同一字符连跑长度 ≥ 周期 ⇒ 这个周期里全是同一个字符（分隔线/长横线），不算循环。
    if (tailRun >= period) continue;
    if (minDistinct > 1 && new Set(text.slice(len - period)).size < minDistinct) continue;
    const need = Math.max(minSpan, 2 * period) - period;
    if (need <= 0) continue;
    const limit = Math.min(need, len - period);
    let matched = 0;
    while (matched < limit && text[len - period - 1 - matched] === text[len - 1 - matched]) matched++;
    if (matched >= need) return matched + period;
  }
  return 0;
}

// 报告用：同一个周期，走满整个尾巴，返回真实重复跨度（只在触发时调一次）。
export function periodicTailSpan(text, maxPeriod, minSpan, minDistinct = 0) {
  if (maxPeriod < 1) return 0;
  const len = text.length;
  if (len < minSpan) return 0;
  const tailRun = trailingRunLength(text);
  const periodCap = Math.min(maxPeriod, Math.floor(len / 2));
  for (let period = 1; period <= periodCap; period++) {
    if (tailRun >= period) continue;
    if (minDistinct > 1 && new Set(text.slice(len - period)).size < minDistinct) continue;
    const need = Math.max(minSpan, 2 * period) - period;
    if (need <= 0) continue;
    const limit = len - period;
    let matched = 0;
    while (matched < limit && text[len - period - 1 - matched] === text[len - 1 - matched]) matched++;
    if (matched >= need) return matched + period;
  }
  return 0;
}

export class CycleBreaker {
  constructor({ maxPeriod = 512, minSpan = 512, minDistinct = 2 } = {}) {
    this.maxPeriod = maxPeriod;
    this.minSpan = minSpan;
    this.minDistinct = minDistinct;
    this.text = '';
    this.lastCheck = 0;
    this.tripped = false;
    this.repeated = 0;
  }
  get repeatedChars() {
    return this.repeated;
  }
  // 返回 true 恰好一次（触发那一 chunk），之后恒 false。
  push(text) {
    if (this.tripped) return false;
    this.text += text;
    if (this.text.length - this.lastCheck < CYCLE_CHECK_STRIDE) return false;
    this.lastCheck = this.text.length;
    const span = trailingCycle(this.text, this.maxPeriod, this.minSpan, this.minDistinct);
    if (span === 0) return false;
    this.tripped = true;
    this.repeated = periodicTailSpan(this.text, this.maxPeriod, this.minSpan, this.minDistinct) || span;
    return true;
  }
}

// ---------------------------------------------------------------------------
// 规则 2b：连续相同 chunk（2026-11-01 从 loop-guard 吸收）
// ---------------------------------------------------------------------------
// 单字/短词刷屏：provider 常把「做。」拆成「做」+「。」，同一 payload 连续出现。
// 60 次 × 2 字符 = 120 字符就够触发，比窗口规则（1 万字符）早两个数量级。
// 只看「一模一样」的 payload（trim 后），近似重复交给周期规则。
export function countRepeatedText(texts) {
  const last = texts.at(-1);
  if (last === undefined) return 0;
  const normalized = last.trim();
  let run = 0;
  for (let i = texts.length - 1; i >= 0; i--) {
    if (texts[i].trim() !== normalized) break;
    run++;
  }
  return run;
}

export class IdenticalChunkBreaker {
  constructor({ maxRepeated = 60 } = {}) {
    this.maxRepeated = maxRepeated;
    this.texts = [];
    this.tripped = false;
    this.repeated = 0;
  }
  get repeatedChars() {
    return this.repeated;
  }
  push(text) {
    if (this.tripped) return false;
    if (this.maxRepeated <= 0) return false;
    this.texts.push(text);
    // 只保留能判定的尾部，别让数组无限长。
    const keep = Math.max(this.maxRepeated + 1, 8);
    if (this.texts.length > keep * 2) this.texts = this.texts.slice(-keep);
    if (this.texts.length >= this.maxRepeated) {
      const run = countRepeatedText(this.texts);
      if (run >= this.maxRepeated) {
        this.tripped = true;
        this.repeated = run * text.trim().length;
        return true;
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// 诊断：低熵比（原版 repeatRatio，明确不作为 loop 判据）
// ---------------------------------------------------------------------------
// 原版文档的结论：它随长度上升——连续不重复的长文 2048 字符 0.29、20000 字符 0.63，
// 而真循环 0.99。它分的是「长/短」不是「卡/不卡」。保留它只用于事后描述，不接判定。
export function repeatRatio(reasoning) {
  if (reasoning.length < 16) return 0;
  const k = Math.min(GRAM_SIZE, Math.max(2, Math.floor(reasoning.length / 16)));
  let repeated = 0;
  let total = 0;
  const seen = new Set();
  for (let i = 0; i + k <= reasoning.length; i++) {
    const gram = reasoning.slice(i, i + k);
    total++;
    if (seen.has(gram)) repeated++;
    else seen.add(gram);
  }
  return total === 0 ? 0 : repeated / total;
}

// ---------------------------------------------------------------------------
// 规则 3：短语池（行级，抓「同一批短句重排」）
// ---------------------------------------------------------------------------
// 周期规则抓「同一段按同样顺序重复」；短语池抓「用同样十几个短句重排」。
// 实测（loop-guard 的真实现场）：5,569 次出现、26 个不同短语、重复质量 44,995 字符、
// 覆盖率 0.993、集中度 214，三条阈值全被一个数量级越过，所以它很早就该报。
class PhrasePool {
  constructor() {
    this.counts = new Map();
    this.total = 0;
    this.repeat = 0;
    this.instances = 0;
    this.partial = '';
  }
  get repeatedChars() {
    return this.repeat;
  }
  push(text) {
    this.partial += text;
    let idx;
    while ((idx = this.partial.indexOf('\n')) >= 0) {
      this.addLine(this.partial.slice(0, idx).trim());
      this.partial = this.partial.slice(idx + 1);
    }
  }
  tripped(minChars, minCoverage, minConcentration) {
    if (this.repeat < minChars) return false;
    if (this.total === 0) return false;
    if (this.repeat / this.total < minCoverage) return false;
    if (this.counts.size === 0) return false;
    return this.instances / this.counts.size >= minConcentration;
  }
  addLine(line) {
    if (line.length < LINE_MIN_CHARS) return;
    const prev = this.counts.get(line) ?? 0;
    this.counts.set(line, prev + 1);
    this.total += line.length;
    this.instances += 1;
    // 第二次看到时，两份都算重复；之后每次再多一份。
    if (prev === 1) this.repeat += line.length * 2;
    else if (prev > 1) this.repeat += line.length;
  }
}

export class PoolBreaker {
  constructor({ minChars = 2048, minCoverage = 0.6, minConcentration = 4 } = {}) {
    this.minChars = minChars;
    this.minCoverage = minCoverage;
    this.minConcentration = minConcentration;
    this.pool = new PhrasePool();
    this.tripped = false;
  }
  get repeatedChars() {
    return this.pool.repeatedChars;
  }
  push(text) {
    if (this.tripped) return false;
    this.pool.push(text);
    if (this.pool.tripped(this.minChars, this.minCoverage, this.minConcentration)) {
      this.tripped = true;
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// 规则 4：跨调用（同一结论反复出现）
// ---------------------------------------------------------------------------
// 一步算「空转」：要么没有任何输出（reasoning-only），要么把上一步 distinct 4-gram
// 包含了 ≥80%（repeated-material——同一结论换个说法）。
// 连续 steps 步才触发；不 latch：打一次重置计数，最多 maxFires 次。
export class CrossCallDetector {
  constructor({ threshold = 0.8, steps = 3, maxFires = 4, minChars = 2048, minShared = 0 } = {}) {
    this.threshold = threshold;
    this.steps = steps;
    this.maxFires = maxFires;
    this.minChars = minChars;
    // 交集的最小绝对量（gram 数）。默认 0 = 只看比例。
    // 为什么不开默认值：真正复述的文本 distinct gram 本来就少（周期 12 的句子，
    // 3600 字符也只有十来个 gram），一个固定的 256 会把「真的在复述」挡掉。
    this.minShared = minShared;
    this.stalled = 0;
    this.fires = 0;
    this.previous = undefined;
    this.lastReason = undefined;
  }
  // step = { reasoning, hasOutput }
  // 材料太短的一步不判、也不清零——短爆发不构成进展，也不能打断一个已经成形的空转段。
  observe(step) {
    const reasoning = String(step?.reasoning ?? '');
    if (reasoning.length < this.minChars) {
      // 短步不判空转，但带输出的短步是「真在干活」——预算也要回一点。
      // 否则工具密集的会话（reasoning 都短）用满 maxFires 就永久静默。
      if (step?.hasOutput) this.fires = Math.max(0, this.fires - 1);
      return undefined;
    }
    const current = grams(reasoning);
    const repeated =
      this.previous !== undefined &&
      this.threshold > 0 &&
      containment(this.previous, current, this.minShared) >= this.threshold;
    this.previous = current;
    const reason = !step?.hasOutput ? 'reasoning-only' : repeated ? 'repeated-material' : undefined;
    if (reason === undefined) {
      this.stalled = 0;
      this.lastReason = undefined;
      // 真进展之后，预算慢慢恢复。否则 maxFires 用满一次，这条规则在这个 agent
      // 余生就静默失效，只能重启 DSH 才回来。
      this.fires = Math.max(0, this.fires - 1);
      return undefined;
    }
    this.stalled += 1;
    this.lastReason = reason;
    return reason;
  }
  takeFire() {
    if (this.stalled < this.steps) return undefined;
    if (this.fires >= this.maxFires) return undefined;
    this.fires += 1;
    this.stalled = 0;
    const reason = this.lastReason ?? 'reasoning-only';
    this.lastReason = undefined;
    return reason;
  }
  reset() {
    this.stalled = 0;
    this.previous = undefined;
    this.lastReason = undefined;
  }
}
