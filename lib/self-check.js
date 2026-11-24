/**
 * dsh-fail-guard · 自检内核（独立实现）
 *
 * 给定一份由宿主校验过的配置，用**真实**的失败追踪器与思考流护栏跑两条固定样本，
 * 回答「这条规则在本次配置下会做什么」。
 *
 * 边界：
 * - 不创建会话、不读环境变量、不调用真实工具、不读写模型或磁盘；
 * - 不记录任何工具参数或思考正文，只统计次数与处置结论；
 * - 不写活动记录、不发通知、不 steer、不续跑：观察分支只模拟「记账」这一步，
 *   用 observed 标签表示宿主会记录但不动作。
 *
 * 固定样本（写死，保证自检可复现）：
 * - failure：同一工具连续 6 次失败，坐标落在同一个独立回合（turn 1，step 1..6）；
 * - repeat：同一个 reasoning 块里 8 行完全相同的短思考（每行一个增量），随后一段非空续写。
 * 两条规则不共享状态：失败在 turn 1 产生通知，复读在另一个独立回合里跑一条流的副本，
 * 因此失败通知不会压掉复读的续跑判定（宿主侧 failureNotified 只作用于本回合）。
 *
 * 阈值合法区间由宿主（配置 schema）保证；这里只做有界防御：非布尔值回落默认，
 * 阈值取整并夹在 LIMITS 区间内，任何输入都不抛异常。
 */
import { createFailureTracker } from './failure/index.js';
import { guardReasoning } from './repetition/index.js';
import { DEFAULTS, LIMITS } from './options.js';
/** 失败样本：同一工具连续失败次数。宿主阈值上限 12，样本取 6 即可覆盖 2–6 的命中区间。 */
const FAILURE_SAMPLE_INPUTS = 6;
/** 复读样本：同一块内完全相同短行的条数。宿主阈值上限 15，样本取 8 覆盖 3–8 的命中区间。 */
const REPEAT_SAMPLE_LINES = 8;
/** 样本用的合成工具名：不指向任何真实工具。 */
const SAMPLE_TOOL = 'self-check-probe';
/** 失败样本的合成 callId 前缀。 */
const FAILURE_CALL_PREFIX = 'self-check-failure-';
/** 失败样本所在的独立回合；复读样本另起一条流，不共享这里的状态。 */
const FAILURE_TURN = 1;
/** 复读样本的块索引。 */
const SAMPLE_BLOCK_INDEX = 0;
/** 复读样本的重复短行（trim 后 7 个字符，非结构行、非纯标点）。 */
const REPEAT_LINE = '重试同一步骤。';
/** 复读样本的续写：与重复行不同且非空，用来触发安全截断判定。 */
const REPEAT_CONTINUATION = '换一种验证方式并检查错误原文。';
/** 一条自检结论（冻结，避免调用方拿到共享可变对象）。 */
function freezeResult(rule, inputCount, threshold, action, wouldResume) {
    return Object.freeze({ rule, inputCount, threshold, action, wouldResume });
}
/** 布尔字段的有界防御：只接受真正的布尔值，其余回落默认。 */
function readBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
/** 阈值的有界防御：非有限数值回落默认，其余取整并夹在给定区间内。 */
function readThreshold(value, fallback, bounds) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    const rounded = Math.trunc(value);
    return Math.min(bounds.max, Math.max(bounds.min, rounded));
}
/**
 * 读取一份不会被外部修改的配置副本。
 * 宿主负责校验；这里对空对象、缺字段、越界值只做有界防御，不抛异常。
 */
function readOptions(options) {
    const source = (options !== null && typeof options === 'object' ? options : {});
    return {
        failureEnabled: readBoolean(source.failureEnabled, DEFAULTS.failureEnabled),
        failureLimit: readThreshold(source.failureLimit, DEFAULTS.failureLimit, LIMITS.failureLimit),
        repeatEnabled: readBoolean(source.repeatEnabled, DEFAULTS.repeatEnabled),
        repeatLimit: readThreshold(source.repeatLimit, DEFAULTS.repeatLimit, LIMITS.repeatLimit),
        resumeOnRepeat: readBoolean(source.resumeOnRepeat, DEFAULTS.resumeOnRepeat),
        observeOnly: readBoolean(source.observeOnly, DEFAULTS.observeOnly),
        diagnosticsEnabled: false,
        fragmentObserveEnabled: false,
        fuzzyObserveEnabled: false,
        crossTurnObserveEnabled: false,
        activeSteerEnabled: false,
        stopSimulationEnabled: false,
    };
}
/** 失败样本：同一工具连续 6 次失败，只观察真实 tracker 是否给出通知。 */
function runFailureSample(config) {
    if (!config.failureEnabled) {
        return freezeResult('failure', 0, config.failureLimit, 'disabled', false);
    }
    const tracker = createFailureTracker();
    let hit = false;
    for (let index = 0; index < FAILURE_SAMPLE_INPUTS; index += 1) {
        const step = index + 1;
        const callId = FAILURE_CALL_PREFIX + step;
        tracker.call(callId, SAMPLE_TOOL, FAILURE_TURN, step);
        const notice = tracker.result(callId, FAILURE_TURN, step, true, config.failureLimit);
        if (typeof notice === 'string' && notice.length > 0)
            hit = true;
    }
    // 失败通知不中断回合，也永远不触发自动续跑。
    const action = hit ? (config.observeOnly ? 'observed' : 'notified') : 'none';
    return freezeResult('failure', FAILURE_SAMPLE_INPUTS, config.failureLimit, action, false);
}
/** 构造复读样本的片序列：块开始 → 8 行相同短行 → 一段续写 → 块结束 → finish。 */
function buildRepeatChunks() {
    const chunks = [{ type: 'block-start', index: SAMPLE_BLOCK_INDEX, blockType: 'reasoning' }];
    for (let line = 0; line < REPEAT_SAMPLE_LINES; line += 1) {
        chunks.push({ type: 'reasoning-delta', index: SAMPLE_BLOCK_INDEX, text: REPEAT_LINE + '\n' });
    }
    chunks.push({ type: 'reasoning-delta', index: SAMPLE_BLOCK_INDEX, text: REPEAT_CONTINUATION + '\n' });
    chunks.push({
        type: 'block-end',
        index: SAMPLE_BLOCK_INDEX,
        block: { type: 'reasoning', text: (REPEAT_LINE + '\n').repeat(REPEAT_SAMPLE_LINES) + REPEAT_CONTINUATION + '\n' },
    });
    chunks.push({ type: 'finish', reason: { kind: 'stop' } });
    return chunks;
}
/** 复读样本流：只读常量片，不读模型、不读磁盘。 */
function createSampleStream() {
    const chunks = buildRepeatChunks();
    let cursor = 0;
    let exhausted = false;
    let closedEarly = false;
    return {
        get closedEarly() {
            return closedEarly;
        },
        [Symbol.asyncIterator]() {
            return {
                next() {
                    if (cursor >= chunks.length) {
                        exhausted = true;
                        return Promise.resolve({ done: true, value: undefined });
                    }
                    const value = chunks[cursor];
                    cursor += 1;
                    return Promise.resolve({ done: false, value });
                },
                return() {
                    if (!exhausted)
                        closedEarly = true;
                    return Promise.resolve({ done: true, value: undefined });
                },
            };
        },
    };
}
/**
 * 复读样本：真实 guardReasoning 跑一条独立流。
 * 结论从引擎的实际效果反推：有没有 onCut（命中）、上游有没有被提前关闭（真截断）。
 */
async function runRepeatSample(config) {
    if (!config.repeatEnabled) {
        return freezeResult('repeat', 0, config.repeatLimit, 'disabled', false);
    }
    const source = createSampleStream();
    let hits = 0;
    // 与宿主同一策略：只有开启截断且不是观察模式才真正收流。
    const guarded = guardReasoning(source, config.repeatLimit, () => {
        hits += 1;
    }, () => !config.observeOnly);
    for await (const chunk of guarded) {
        // 只消费，不读正文、不留存：自检不保留任何思考文本。
        void chunk;
    }
    const cut = hits > 0 && source.closedEarly;
    const action = hits === 0 ? 'none' : cut ? 'cut' : 'observed';
    const wouldResume = cut && !config.observeOnly && config.resumeOnRepeat;
    return freezeResult('repeat', REPEAT_SAMPLE_LINES, config.repeatLimit, action, wouldResume);
}
/**
 * 用真实检测内核跑两条固定样本，返回各自的实际命中与宿主处置。
 *
 * 顺序固定：failure、repeat。失败与复读在互相独立的回合/流里模拟，互不影响：
 * 失败通知不会抑制复读的续跑判定，复读截断也不会改变失败的结论。
 *
 * @param options 宿主配置（只读）；越界阈值按 LIMITS 夹取，非法布尔值回落默认，不抛异常。
 * @returns 冻结的结果数组，长度恒为 2。
 */
export async function runSelfCheck(options) {
    const config = readOptions(options);
    const failure = runFailureSample(config);
    const repeat = await runRepeatSample(config);
    return Object.freeze([failure, repeat]);
}
