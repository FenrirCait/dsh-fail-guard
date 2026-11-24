/**
 * dsh-fail-guard · 思考流复读防护（独立实现）
 *
 * 契约（ARCHITECTURE.md）：
 * - `guardReasoning(source, limit, onCut?, decide?, diagnostics?)` 包装一条 `StreamChunk` 流；
 * - 只检查 reasoning 块里**已经封行**（见过 \n）的行，连续相同的短行达到 limit 即命中；
 * - 放过空行、纯标点/符号行与明显结构行，它们既不计数也不打断连续；
 * - 每个块索引独立检测（交错 reasoning 块互不合并）；
 * - 命中后只有“同块非空续写、且没有其它活动块”时才进入截断判定；
 * - 截断判定先问第四参数 `decide()`（默认 true）：只有显式 false 才放行，
 *   放行时按原顺序透传、不截断、不关闭上游，但仍调用一次 onCut（载荷不变）；
 * - 不改正文、不记录思考文本；真正截断时只补一个终止 finish 并关闭上游一次；
 * - 第五参数 `diagnostics`（默认 false）：仅 true 时采集有界结构（块事件顺序、
 *   块边界、完整合格行的等价类编号），随 onCut 载荷的 `trace` 给出；
 *   关闭时不做任何额外采集，载荷与行为与旧版逐字段相同。
 *
 * 有界性：每个 reasoning 块只保留未封行短前缀（≤ SHORT_LINE_MAX_CHARS）、
 * 上一条短行与计数；超长行文本立即丢弃；块状态在 block-end 时整体丢弃。
 * 诊断结构另有上限：最多 TRACE_MAX_EVENTS（64）条事件、TRACE_MAX_GROUPS（32）
 * 条等价行编号；局部块编号 0..MAX_ACTIVE_BLOCKS-1，块结束时释放并可复用。
 * 活动块表另有上限 MAX_ACTIVE_BLOCKS（64）：超限即清空跟踪并永久停止检测，
 * 此后整条流原样透传，不截断也不关闭上游（只有消费者取消才关闭）。
 * 本模块不依赖宿主运行时：协议类型只做 type-only import，运行期没有外部依赖。
 */

import type { ContentBlockType, StreamChunk } from '@deepseek-ai/dsh-llm';

/**
 * 视为“短行”的最大字符数（trim 后按 UTF-16 code unit 计）。
 * 超过它的行视为正常分析内容：不计数，并打断当前连续段。
 */
export const SHORT_LINE_MAX_CHARS = 40;

/**
 * 同时跟踪的活动块上限（有界活动块状态）。
 * 达到上限后又出现新的块索引，按上游失序流处理：清空全部块状态并永久停止跟踪，
 * 此后整条流原样透传——不截断、不调用 onCut、不关闭上游迭代器。
 */
export const MAX_ACTIVE_BLOCKS = 64;

/**
 * 诊断结构的事件条数上限：`trace.events` 最多这么多条，超出后不再记录。
 * 事件只带种类与局部块编号，不含正文、哈希或上游 index。
 */
export const TRACE_MAX_EVENTS = 64;

/**
 * 诊断结构的等价行编号上限：`trace.groups` 最多这么多条，编号 0..TRACE_MAX_GROUPS-1。
 * 每条都来自与扫描器计数相同的“完整合格行”判据。
 */
export const TRACE_MAX_GROUPS = 32;

/** 诊断事件种类：块开始、块结束、被交给块扫描器的思考增量。 */
export type RepetitionTraceEventKind = 'start' | 'end' | 'delta';

/** 一条诊断事件：只有种类与本次 trace 的局部块编号。 */
export interface RepetitionTraceEvent {
  readonly kind: RepetitionTraceEventKind;
  /** 本次 trace 内分配的局部块编号（0..MAX_ACTIVE_BLOCKS-1），块结束后可复用。 */
  readonly block: number;
}

/**
 * 一次命中时的结构快照（仅 diagnostics=true 时采集）：
 * - `events`：按发生顺序的块边界与被扫描增量，最多 TRACE_MAX_EVENTS 条；
 * - `groups`：完整合格行的等价类编号，最多 TRACE_MAX_GROUPS 条。
 * 不含原文、哈希或上游 index；数组与事件对象都已冻结。
 */
export interface RepetitionTrace {
  readonly events: readonly RepetitionTraceEvent[];
  readonly groups: readonly number[];
}

/** 第四参数 decide 的类型：返回 false 表示本次安全命中放行（不截断）。 */
export type GuardDecision = () => boolean;

/** decide 的默认实现：始终允许截断（保持原有行为）。 */
const ALWAYS_CUT: GuardDecision = () => true;

/** 一次命中：只带位置与行数，不含任何思考正文。 */
export interface RepetitionCut {
  /** 触发截断的 reasoning 块索引。 */
  readonly index: number;
  /** 触发时连续相同短行的行数（>= limit）。 */
  readonly count: number;
  /**
   * 结构快照（仅第五参数 diagnostics=true 时存在）：命中时刻已采集的
   * 块事件与等价行编号；不含思考正文、哈希或上游 index。
   */
  readonly trace?: RepetitionTrace;
}

/** 一次 `push` 的扫描结果。 */
export interface LineScanResult {
  /** 本次 push 中某条完整行达到 limit 时的连续行数；没有命中为 null。 */
  readonly hit: number | null;
  /** 处理完最后一条完整行后的连续计数。 */
  readonly count: number;
}

/**
 * 有界的短行扫描器：只保留当前未封行的短前缀（≤ SHORT_LINE_MAX_CHARS）、
 * 上一短行与连续计数；超长行立即丢弃文本，只记“这一行已超长”。
 */
export interface LineScanner {
  /** 喂入一段文本（可以不含换行、可以跨片、可以一次含多行）。 */
  push(text: string): LineScanResult;
  /** 正常收尾确认：命中行不被拦截时清零连续段，未封行尾巴保留。 */
  acknowledge(): void;
  /** 当前暂存的未封行字符数（始终 ≤ SHORT_LINE_MAX_CHARS）。 */
  readonly pendingChars: number;
  /** 当前连续相同短行数（只供诊断/测试）。 */
  readonly consecutive: number;
}

/** 纯标点 / 纯符号（含空白）行：放过。 */
const PUNCTUATION_ONLY = /^[\p{P}\p{S}]+$/u;

/**
 * 明显结构行：Markdown 围栏、标题记号、分隔线、表格分隔、孤立列表/引用记号、
 * 孤立 HTML 标签、孤立任务框。只匹配“整行只有结构、没有正文”的形态。
 */
function isStructuralLine(line: string): boolean {
  if (PUNCTUATION_ONLY.test(line)) return true;
  if (/^(?:`{3,}|~{3,})/.test(line)) return true;
  if (/^#{1,6}$/.test(line)) return true;
  if (/^(?:[-*_]\s*){3,}$/.test(line)) return true;
  if (/^\|?[\s:|-]+\|?$/.test(line)) return true;
  if (/^(?:[-*+]|\d{1,3}[.)]|>)$/.test(line)) return true;
  if (/^<\/?[A-Za-z][^>]*>$/.test(line)) return true;
  if (/^\[[ xX]\]$/.test(line)) return true;
  return false;
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`repeatLimit 必须是正整数，收到 ${String(limit)}`);
  }
}

/** 完整合格行回调（诊断用）；`null` 表示不采集，默认路径不产生任何额外调用。 */
type QualifiedLineSink = ((line: string) => void) | null;

/**
 * 创建一个有界短行扫描器。
 * @param limit 连续相同短行达到多少行算命中（正整数；宿主配置范围 3–15）
 */
export function createLineScanner(limit: number): LineScanner {
  return createScanner(limit, null);
}

/** 扫描器实体：`onQualified` 只在诊断路径非空，仅用于给完整合格行编等价类号。 */
function createScanner(limit: number, onQualified: QualifiedLineSink): LineScanner {
  assertLimit(limit);

  /** 当前未封行的前缀；超过短行上限后清空，只保留 overflow 标记。 */
  let partial = '';
  /** 当前行在丢弃文本前是否已经超长。 */
  let overflow = false;
  /** 上一条计入的短行（trim 后）。 */
  let previous = '';
  /** 当前连续计数。 */
  let count = 0;

  const resetRun = (): void => {
    previous = '';
    count = 0;
  };

  /** 处理一条完整行（不含换行符）；该行使连续计数达到 limit 时返回 true。 */
  const finishLine = (segment: string): boolean => {
    if (overflow || partial.length + segment.length > SHORT_LINE_MAX_CHARS) {
      partial = '';
      overflow = false;
      resetRun();
      return false;
    }
    const line = (partial + segment).trim();
    partial = '';
    if (line === '' || isStructuralLine(line)) return false;
    if (line === previous) count += 1;
    else {
      previous = line;
      count = 1;
    }
    // 诊断：只在这里把完整合格行交给等价类编号，不改变计数与返回值。
    onQualified?.(line);
    return count >= limit;
  };

  return {
    push(text: string): LineScanResult {
      let hit: number | null = null;
      let start = 0;
      for (;;) {
        const newline = text.indexOf('\n', start);
        if (newline === -1) break;
        if (finishLine(text.slice(start, newline))) hit = count;
        start = newline + 1;
      }
      const tail = text.slice(start);
      if (tail.length > 0 && !overflow) {
        if (partial.length + tail.length > SHORT_LINE_MAX_CHARS) {
          overflow = true;
          partial = '';
          // This line can no longer qualify, even before its newline arrives.
          resetRun();
        } else {
          partial += tail;
        }
      }
      // A later complete line or an over-limit tail can break this frame’s run.
      return { hit: hit !== null && count >= limit ? count : null, count };
    },
    acknowledge(): void {
      resetRun();
    },
    get pendingChars(): number {
      return partial.length;
    },
    get consecutive(): number {
      return count;
    },
  };
}

/**
 * 诊断结构收集器：有界持有事件、局部块编号与等价行编号。
 * - 事件最多 TRACE_MAX_EVENTS 条，超出后不再记录；
 * - 局部块编号 0..MAX_ACTIVE_BLOCKS-1，按最小空闲号分配、块结束时释放复用；
 * - 等价类只保留至多 TRACE_MAX_GROUPS 个完整合格行（每个 ≤ SHORT_LINE_MAX_CHARS 字符）
 *   用于与既有 `line === previous` 同一判据的相等比较；满额后立即清空，不输出原文也不哈希；
 * - 活动块超限导致跟踪停止时整体释放，之后不再采集。
 * 只有 diagnostics=true 时才创建本对象；关闭时 runGuard 里的调用点全部是 null 短路。
 */
interface TraceCollector {
  /** 块进入活动表（显式 block-start 或 delta 隐式建块）。 */
  start(index: number): void;
  /** 块离开活动表（block-end）。 */
  end(index: number): void;
  /** 一条思考增量被交给块扫描器。 */
  delta(index: number): void;
  /** 一条完整合格行（trim 后）；与扫描器计数使用同一判据。 */
  line(text: string): void;
  /** 生成不可变快照；调用方可以长期持有。 */
  snapshot(): RepetitionTrace;
  /** 停止并释放（活动块超限时）。 */
  stop(): void;
}

/** 创建诊断收集器；只由 diagnostics=true 的 guardReasoning 调用。 */
function createTraceCollector(): TraceCollector {
  const events: RepetitionTraceEvent[] = [];
  const groups: number[] = [];
  /** 上游 index → 局部块编号；只含活动块，随 end 释放。 */
  const blocks = new Map<number, number>();
  /** 局部编号占用表（长度 = MAX_ACTIVE_BLOCKS，保证编号有界）。 */
  const used: boolean[] = Array.from({ length: MAX_ACTIVE_BLOCKS }, () => false);
  /** 等价类：trim 后的完整合格行 → 编号；条目数由 groups 上限约束，满额即清空。 */
  const classes = new Map<string, number>();
  let live = true;

  const push = (kind: RepetitionTraceEventKind, block: number): void => {
    if (!live || events.length >= TRACE_MAX_EVENTS) return;
    events.push(Object.freeze({ kind, block }));
  };

  return {
    start(index: number): void {
      if (!live) return;
      const known = blocks.get(index);
      if (known !== undefined) {
        // 同一 index 未收块又开始新块：沿用局部编号，事件序列里表现为连续两个 start。
        push('start', known);
        return;
      }
      let id = -1;
      for (let i = 0; i < used.length; i += 1) {
        if (!used[i]) {
          id = i;
          break;
        }
      }
      if (id < 0) return; // 块表上限保证不会发生；保守放弃本条事件
      used[id] = true;
      blocks.set(index, id);
      push('start', id);
    },
    end(index: number): void {
      if (!live) return;
      const id = blocks.get(index);
      if (id === undefined) return;
      blocks.delete(index);
      used[id] = false;
      push('end', id);
    },
    delta(index: number): void {
      if (!live) return;
      const id = blocks.get(index);
      if (id === undefined) return;
      push('delta', id);
    },
    line(text: string): void {
      if (!live || groups.length >= TRACE_MAX_GROUPS) return;
      let group = classes.get(text);
      if (group === undefined) {
        group = classes.size;
        classes.set(text, group);
      }
      groups.push(group);
      // 满额后不再需要任何原文用于比较：立即释放等价类表。
      if (groups.length >= TRACE_MAX_GROUPS) classes.clear();
    },
    snapshot(): RepetitionTrace {
      return Object.freeze({
        events: Object.freeze(events.slice()),
        groups: Object.freeze(groups.slice()),
      });
    },
    stop(): void {
      live = false;
      blocks.clear();
      classes.clear();
      events.length = 0;
      groups.length = 0;
    },
  };
}

/** 一个活动块：类型 + reasoning 块专属的扫描器。 */
interface BlockState {
  type: ContentBlockType;
  scanner: LineScanner | undefined;
}

/**
 * 包装一条模型流，在思考内容出现连续相同短行复读时提前收流。
 *
 * 判定：
 * - 只看 reasoning 块中已经封行的行，块尾未封行的内容不参与判定；
 * - 短行 = trim 后 1..SHORT_LINE_MAX_CHARS 个字符；连续 limit 行完全相同即命中；
 * - 空行、纯标点/符号行、明显结构行被放过（不计数、不打断连续）；
 * - 长行与不同的短行打断连续；每个块索引独立计行。
 *
 * 截断条件（同时满足）：
 * 1. 命中后紧邻的下一片是本块（同 index）的 reasoning-delta，且含非空白文本；
 * 2. 此刻只有本块处于活动状态（没有其它未闭合的 text / tool-call / reasoning 块）。
 * 任一不满足都按“正常收尾”处理：清零本块计数，流继续原样转发。
 *
 * 截断判定（第四参数 decide，默认 `() => true`）：
 * - 只有安全截断条件成立时才调用 `decide()`；只有显式返回 false 才放行；
 * - 放行时：已读出的探读片按原顺序接着转发，流继续，不截断、不关闭上游，
 *   但仍调用一次 onCut（载荷与截断时相同；记账方式由主控的闭包自行决定）。
 *
 * 截断行为：
 * - 不修改任何已经转发的片，也不合成 block-end（不保留、不复述思考正文）；
 * - 只补一个终止 `finish`（reason = stop），让消费者拿到合法的流结尾；
 * - 关闭上游迭代器一次（调用其 `return()`），并调用一次 onCut（载荷不含思考文本）。
 *
 * 取消：消费者 break 或调用返回生成器的 `return()` 时，上游同样只关闭一次，不触发 onCut。
 *
 * 有界：活动块超过 MAX_ACTIVE_BLOCKS 时清空跟踪并从此原样透传，不关闭上游。
 *
 * @param source 上游模型流（通常是 `LlmRuntime.stream()` 的结果）
 * @param limit  连续相同短行的命中阈值（正整数）
 * @param onCut  命中通知；每次安全命中调用一次（截断或放行都调用）
 * @param decide 截断判定；省略等价于 `() => true`
 * @param diagnostics 诊断开关（默认 false）：true 时在 onCut 载荷上附带有界 `trace`
 *        （事件顺序、块边界、等价行编号）；false/省略时不做任何额外采集，行为与旧版一致
 */
export function guardReasoning(
  source: AsyncIterable<StreamChunk>,
  limit: number,
  onCut?: (cut: RepetitionCut) => void,
  decide?: GuardDecision,
  diagnostics?: boolean,
): AsyncGenerator<StreamChunk, void, void> {
  assertLimit(limit);
  if (source === null || typeof source === 'undefined'
    || typeof (source as AsyncIterable<StreamChunk>)[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('source 必须是 AsyncIterable<StreamChunk>');
  }
  if (typeof onCut !== 'undefined' && typeof onCut !== 'function') {
    throw new TypeError('onCut 必须是函数或省略');
  }
  if (typeof decide !== 'undefined' && typeof decide !== 'function') {
    throw new TypeError('decide 必须是函数或省略');
  }
  if (typeof diagnostics !== 'undefined' && typeof diagnostics !== 'boolean') {
    throw new TypeError('diagnostics 必须是布尔值或省略');
  }
  return runGuard(source, limit, onCut, decide ?? ALWAYS_CUT,
    diagnostics === true ? createTraceCollector() : null);
}

async function* runGuard(
  source: AsyncIterable<StreamChunk>,
  limit: number,
  onCut: ((cut: RepetitionCut) => void) | undefined,
  decide: GuardDecision,
  collector: TraceCollector | null,
): AsyncGenerator<StreamChunk, void, void> {
  const iterator = source[Symbol.asyncIterator]();
  /** 完整合格行只交给诊断收集器做等价类编号；关闭诊断时为 null。 */
  const lineSink: QualifiedLineSink = collector === null ? null : line => collector.line(line);
  /** onCut 载荷：关闭诊断时与旧载荷逐字段相同（不含 trace）。 */
  const cutPayload = (index: number, count: number): RepetitionCut =>
    collector === null ? { index, count } : { index, count, trace: collector.snapshot() };
  /** 活着的块（见过 block-start 或隐式首片，尚未 block-end）；数量不超过 MAX_ACTIVE_BLOCKS。 */
  const blocks = new Map<number, BlockState>();
  /** 是否仍在跟踪；活动块超限后永久停止（此后整条流原样透传）。 */
  let tracking = true;
  /** 探读出来但本轮不消费的片，下一轮按原语义处理。 */
  let pending: StreamChunk | undefined;
  /** 上游已经正常读完（done）。 */
  let terminal = false;
  /** 上游已被我们主动关闭。 */
  let upstreamClosed = false;
  /** 已经见过 finish：之后不再截断（malformed 流防御）。 */
  let sawFinish = false;

  const closeUpstream = async (): Promise<void> => {
    if (upstreamClosed || terminal) return;
    upstreamClosed = true;
    await iterator.return?.();
  };

  /** 活动块超限：清空全部跟踪状态，此后原样透传（不关闭上游）。 */
  const disableTracking = (): void => {
    tracking = false;
    blocks.clear();
    // 跟踪停止后整体释放诊断结构（已交付的快照是独立副本）。
    collector?.stop();
  };

  /**
   * 取或建一个块状态；新建前检查活动块上限。
   * 返回 undefined 表示本次触发了超限停机，调用方应放弃这一片的检测。
   */
  const ensureBlock = (index: number, type: ContentBlockType): BlockState | undefined => {
    let block = blocks.get(index);
    if (block === undefined) {
      if (blocks.size >= MAX_ACTIVE_BLOCKS) {
        disableTracking();
        return undefined;
      }
      block = { type, scanner: undefined };
      blocks.set(index, block);
      collector?.start(index);
    }
    return block;
  };

  /** 观察一片、更新块表与扫描器；命中时返回命中位置。跟踪停止后什么都不做。 */
  const observe = (chunk: StreamChunk): RepetitionCut | undefined => {
    if (!tracking) return undefined;
    switch (chunk.type) {
      case 'block-start':
        if (!blocks.has(chunk.index) && blocks.size >= MAX_ACTIVE_BLOCKS) {
          disableTracking();
          return undefined;
        }
        blocks.set(chunk.index, {
          type: chunk.blockType,
          scanner: chunk.blockType === 'reasoning' ? createScanner(limit, lineSink) : undefined,
        });
        collector?.start(chunk.index);
        return undefined;
      case 'block-end':
        blocks.delete(chunk.index);
        collector?.end(chunk.index);
        return undefined;
      case 'reasoning-delta': {
        const block = ensureBlock(chunk.index, 'reasoning');
        if (block === undefined || block.type !== 'reasoning') return undefined;
        if (block.scanner === undefined) block.scanner = createScanner(limit, lineSink);
        collector?.delta(chunk.index);
        const result = block.scanner.push(chunk.text);
        return result.hit === null ? undefined : { index: chunk.index, count: result.hit };
      }
      case 'text-delta':
        ensureBlock(chunk.index, 'text');
        return undefined;
      case 'tool-call-delta':
        ensureBlock(chunk.index, 'tool-call');
        return undefined;
      case 'finish':
        sawFinish = true;
        return undefined;
      default:
        return undefined;
    }
  };

  try {
    for (;;) {
      let step: IteratorResult<StreamChunk>;
      if (pending !== undefined) {
        step = { done: false, value: pending };
        pending = undefined;
      } else {
        step = await iterator.next();
      }
      if (step.done === true) {
        terminal = true;
        return;
      }
      const chunk = step.value;
      const candidate = observe(chunk);
      yield chunk;
      if (candidate === undefined) continue;

      // 命中后探读一格：只有本块非空续写、且没有其它活动块，才进入截断判定。
      const probe = await iterator.next();
      if (probe.done === true) {
        terminal = true;
        return;
      }
      const probeChunk = probe.value;
      const sameBlockContinuation = probeChunk.type === 'reasoning-delta'
        && probeChunk.index === candidate.index
        && probeChunk.text.trim().length > 0;
      const onlyActiveBlock = blocks.size === 1 && blocks.has(candidate.index);
      if (!sawFinish && sameBlockContinuation && onlyActiveBlock) {
        // 安全截断条件成立才询问 decide；decide 抛错按普通异常向上传播。
        if (decide() === false) {
          // 放行：探读片按原顺序接着转发，流继续；onCut 仍调用一次，载荷不变。
          blocks.get(candidate.index)?.scanner?.acknowledge();
          pending = probeChunk;
          onCut?.(cutPayload(candidate.index, candidate.count));
          continue;
        }
        await closeUpstream();
        onCut?.(cutPayload(candidate.index, candidate.count));
        // 只补终止片，不补 block-end：思考正文不在本模块留存。
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      // 正常收尾：确认本条命中，探读片放回去按原语义继续。
      blocks.get(candidate.index)?.scanner?.acknowledge();
      pending = probeChunk;
    }
  } finally {
    await closeUpstream();
  }
}
