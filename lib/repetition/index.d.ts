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
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
/**
 * 视为“短行”的最大字符数（trim 后按 UTF-16 code unit 计）。
 * 超过它的行视为正常分析内容：不计数，并打断当前连续段。
 */
export declare const SHORT_LINE_MAX_CHARS = 40;
/**
 * 同时跟踪的活动块上限（有界活动块状态）。
 * 达到上限后又出现新的块索引，按上游失序流处理：清空全部块状态并永久停止跟踪，
 * 此后整条流原样透传——不截断、不调用 onCut、不关闭上游迭代器。
 */
export declare const MAX_ACTIVE_BLOCKS = 64;
/**
 * 诊断结构的事件条数上限：`trace.events` 最多这么多条，超出后不再记录。
 * 事件只带种类与局部块编号，不含正文、哈希或上游 index。
 */
export declare const TRACE_MAX_EVENTS = 64;
/**
 * 诊断结构的等价行编号上限：`trace.groups` 最多这么多条，编号 0..TRACE_MAX_GROUPS-1。
 * 每条都来自与扫描器计数相同的“完整合格行”判据。
 */
export declare const TRACE_MAX_GROUPS = 32;
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
/**
 * 创建一个有界短行扫描器。
 * @param limit 连续相同短行达到多少行算命中（正整数；宿主配置范围 3–15）
 */
export declare function createLineScanner(limit: number): LineScanner;
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
export declare function guardReasoning(source: AsyncIterable<StreamChunk>, limit: number, onCut?: (cut: RepetitionCut) => void, decide?: GuardDecision, diagnostics?: boolean): AsyncGenerator<StreamChunk, void, void>;
