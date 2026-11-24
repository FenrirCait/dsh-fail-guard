// Observation only: frames pass through unchanged, nothing is logged or exported.
/*
 * dsh-fail-guard · 有界模糊复读观察器（实验）
 *
 * 目标：在同一条 reasoning 块**已经封行**的完整行里，找出“近重复”行组——
 * 4 行一组，组内至少一行与组首不是逐字相同（逐字相同的连续行归精确防护）。
 *
 * 一组命中的条件（全部满足）：
 * 1. 同一 reasoning 块、连续（中间没有空行 / 结构行 / 围栏 / 可见进度 / 超长行打断）；
 * 2. 每行 trim 后 4..96 code units；
 * 3. 每行与组首（锚行）的**敏感 token 序列完全一致**——数字、路径、URL、版本号、
 *    带标识符标点的 token（`a.ts`、`src/x`、`v2`、`user_id`）一改，整组作废；
 * 4. 与锚行的有界字面编辑距离 ≤ 预算：较短一行 < 8 units 时 1，否则 2；
 * 5. 组内至少一行与锚行不是逐字相同。
 *
 * 明确不看的（阴性边界）：
 * - 非 reasoning 块（text / tool-call）的正文；
 * - 没有换行的尾巴（块尾未封行内容、finish 前截断的半行）；
 * - 空行、纯标点/符号行、缩进 ≥2 空格或 Tab 的行；
 * - Markdown 结构行（标题 / 列表 / 引用 / 表格 / 任务框 / 含 `|` 的行）；
 * - 代码形态行（花括号、分号、反引号、箭头、标签、比较/赋值运算符、函数调用）；
 * - 围栏代码块内的所有行（含未闭合围栏一直到块尾）；
 * - 超过 96 code units 的行（只从有界前缀识别“开围栏”，不参与比较）；
 * - 被可见进度（text / tool-call 块或增量）打断的半行。
 *
 * 有界性：
 * - 同时跟踪 ≤64 个 reasoning 块（第 65 个新块即停用观察，此后原样透传）；
 * - 单行缓冲 ≤96 code units；每块只保留 1 条 ≤96 units 的锚行用于比较，
 *   命中 / 块结束 / 停用 / 流结束立刻释放；不落盘、不导出、不哈希、不打日志；
 * - 每行至多一次带宽 ≤ 2·edits+1 的有界编辑距离计算，没有回溯、没有子串搜索；
 * - 每条流最多回调一次 onHit，载荷只有一个行数（不记录任何正文）。
 *
 * 流语义：
 * - 每个 frame 原样 yield（同一对象、同一顺序），命中不截断、不关闭上游；
 * - 消费者取消时由 for-await 关闭上游恰好一次；
 * - onHit 抛出的异常被吞掉，不影响转发。
 */
/** 观察器的有界参数（供接线与测试引用）。 */
export const FUZZY_LIMITS = Object.freeze({
    /** 同时跟踪的 reasoning 块上限。 */
    blocks: 64,
    /** 单行最多 code units（UTF-16）。 */
    line: 96,
    /** 参与判定的最短行（trim 后）。 */
    minLine: 4,
    /** 一组近重复至少多少行。 */
    group: 4,
    /** 长行允许的最大编辑距离。 */
    edits: 2,
});
/** 纯标点 / 符号（含空白）行：不是重复证据。 */
const PUNCTUATION_ONLY = /^[\p{P}\p{S}\s]+$/u;
/** 围栏标记：≤3 个前导空格 + 三个以上反引号或波浪号 + 其余部分。 */
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u;
/** 只认行首的围栏开口（超长行的有界前缀也够用）。 */
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})/u;
/** 闭合围栏的其余部分必须为空。 */
const BLANK_REST = /^[ \t]*$/u;
/** 缩进 ≥2 空格或 Tab：代码块形态，不参与判定。 */
const INDENTED = /^(?: {2,}|\t)/u;
/** Markdown 结构行：标题、列表、引用、任务框。 */
const FORMATTING = /^[ \t]{0,3}(?:#{1,6}(?:\s|$)|[-*+]\s|\d{1,3}[.)]\s|>|\[[ xX]\](?:\s|$))/u;
/** 代码形态：花括号/分号/反引号、箭头、标签、运算符、控制关键字、函数调用。 */
const CODE_SHAPE = /[{};`]|=>|<\/|\(\s*\)|==|!=|::|:=|&&|\|\||(?:^|[\s(])(?:function|class|const|let|var|import|export|return|def|async|await|if|for|while)\b|[A-Za-z_$][\w$]*\s*\(/u;
/** 敏感 token：数字（含全角）、路径、URL、版本号、带标点的标识符。 */
const SENSITIVE_TOKEN = /[A-Za-z0-9\uFF10-\uFF19][A-Za-z0-9\uFF10-\uFF19_.\-/\\:@%+#]*/gu;
/** token 里出现这些字符（数字或标识符标点）才算“目标/数字”，普通英文单词不算。 */
const SENSITIVE_MARK = /[\d\uFF10-\uFF19_.\/\\:@%+#]/u;
/** 超长行保留的行首前缀长度：够判断“开围栏”（最多 3 个前导空格 + 3 个标记）。 */
const HEAD_UNITS = 8;
function createBlock() {
    return { pending: '', overflow: false, skipLine: false, fence: null, anchor: '', run: 0, differed: false };
}
/** 清空连续组：结构行、空行、围栏、可见进度、超长行都走这里。 */
function resetRun(state) {
    state.anchor = '';
    state.run = 0;
    state.differed = false;
}
/** 敏感 token 序列（数字 / 路径 / URL / 版本 / 标识符）；顺序与个数都参与比较。 */
function sensitiveTokens(line) {
    const tokens = [];
    for (const match of line.matchAll(SENSITIVE_TOKEN)) {
        if (SENSITIVE_MARK.test(match[0]))
            tokens.push(match[0]);
    }
    return tokens;
}
/** 两行的敏感 token 序列是否完全相同——数字或目标一改就返回 false。 */
function sameTargets(left, right) {
    const a = sensitiveTokens(left);
    const b = sensitiveTokens(right);
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}
/**
 * 有界字面编辑距离（UTF-16 code unit 逐位比较，无回溯）。
 * 带宽 2*max+1；任何一行一旦整行最小值超过 max 立刻返回 max+1。
 */
function boundedDistance(left, right, max) {
    if (left === right)
        return 0;
    const leftLength = left.length;
    const rightLength = right.length;
    if (Math.abs(leftLength - rightLength) > max)
        return max + 1;
    let previous = new Array(rightLength + 1);
    for (let j = 0; j <= rightLength; j += 1)
        previous[j] = j;
    for (let i = 1; i <= leftLength; i += 1) {
        const current = new Array(rightLength + 1);
        const from = Math.max(1, i - max);
        const to = Math.min(rightLength, i + max);
        current[0] = i;
        for (let j = 1; j < from; j += 1)
            current[j] = max + 1;
        let rowMin = current[0];
        for (let j = from; j <= to; j += 1) {
            const cost = left.charCodeAt(i - 1) === right.charCodeAt(j - 1) ? 0 : 1;
            const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
            current[j] = value;
            if (value < rowMin)
                rowMin = value;
        }
        for (let j = to + 1; j <= rightLength; j += 1)
            current[j] = max + 1;
        if (rowMin > max)
            return max + 1;
        previous = current;
    }
    return previous[rightLength] <= max ? previous[rightLength] : max + 1;
}
/** 编辑距离预算：短行只允许 1 处差异，长行最多 FUZZY_LIMITS.edits 处。 */
function editBudget(left, right) {
    return Math.min(left.length, right.length) < 8 ? 1 : FUZZY_LIMITS.edits;
}
/** 这一行是否可能作为近重复证据（结构 / 代码 / 过短 / 过长一律否）。 */
function isCandidate(raw, value) {
    if (value.length < FUZZY_LIMITS.minLine || value.length > FUZZY_LIMITS.line)
        return false;
    if (INDENTED.test(raw))
        return false;
    if (PUNCTUATION_ONLY.test(value))
        return false;
    if (FORMATTING.test(raw))
        return false;
    if (value.includes('|'))
        return false;
    if (CODE_SHAPE.test(value))
        return false;
    return true;
}
/**
 * 观察一条模型流里的近重复 reasoning 行，命中的同一条流只报告一次。
 *
 * 只观察，不截断、不改写、不关闭上游；每个 frame 原样透传。
 *
 * @param source 上游模型流（通常是 `LlmRuntime.stream()` 的结果）
 * @param onHit  命中回调：参数是连续近重复行数（命中时为 4；只给数字，不含正文）；
 *               回调抛出的异常被吞掉，不影响流
 */
export function observeFuzzy(source, onHit) {
    if (source === null || typeof source === 'undefined'
        || typeof source[Symbol.asyncIterator] !== 'function') {
        throw new TypeError('source 必须是 AsyncIterable<StreamChunk>');
    }
    if (typeof onHit !== 'function') {
        throw new TypeError('onHit 必须是函数');
    }
    return runFuzzy(source, onHit);
}
async function* runFuzzy(source, onHit) {
    /** 活动的 reasoning 块；数量不超过 FUZZY_LIMITS.blocks。 */
    const blocks = new Map();
    /** 是否仍在观察；命中、finish 或块表超限后永久关闭。 */
    let enabled = true;
    const stop = () => {
        enabled = false;
        blocks.clear();
    };
    /** 报告一次并停止观察；回调异常不能改变流。 */
    const report = (count) => {
        stop();
        try {
            onHit(count);
        }
        catch {
            // 观察器只读：回调失败被吞掉，转发继续。
        }
    };
    /** 可见进度（text / tool-call）：打断所有块的连续组，丢弃尚未封行的半行。 */
    const progress = () => {
        for (const state of blocks.values()) {
            resetRun(state);
            if (state.pending.length > 0)
                state.skipLine = true;
        }
    };
    /** 一条完整行（已去掉换行与行尾 \r）：先处理围栏，再判定是否候选。 */
    const consider = (raw, state) => {
        const marker = FENCE.exec(raw);
        if (state.fence !== null) {
            // 围栏内所有行都不参与判定；只有“同字符、长度不短于开口、其余为空”才闭合。
            if (marker !== null && marker[1][0] === state.fence.char
                && marker[1].length >= state.fence.length && BLANK_REST.test(marker[2])) {
                state.fence = null;
            }
            resetRun(state);
            return;
        }
        if (marker !== null) {
            state.fence = { char: marker[1][0], length: marker[1].length };
            resetRun(state);
            return;
        }
        const value = raw.trim();
        if (!isCandidate(raw, value)) {
            resetRun(state);
            return;
        }
        if (state.run === 0) {
            state.anchor = value;
            state.run = 1;
            state.differed = false;
            return;
        }
        const budget = editBudget(state.anchor, value);
        const similar = sameTargets(state.anchor, value)
            && boundedDistance(state.anchor, value, budget) <= budget;
        if (!similar) {
            state.anchor = value;
            state.run = 1;
            state.differed = false;
            return;
        }
        state.run += 1;
        if (value !== state.anchor)
            state.differed = true;
        if (state.run >= FUZZY_LIMITS.group && state.differed)
            report(state.run);
    };
    /** 喂入一段 reasoning 增量：可以不含换行、可以跨片、可以一次多行。 */
    const feed = (text, state) => {
        let start = 0;
        while (enabled && start < text.length) {
            const newline = text.indexOf('\n', start);
            const end = newline < 0 ? text.length : newline;
            const piece = text.slice(start, end);
            if (!state.skipLine && !state.overflow) {
                if (state.pending.length + piece.length > FUZZY_LIMITS.line) {
                    // 超长行：只保留 ≤8 units 的行首前缀用于识别围栏开口（最多 3 空格 + 3 标记），
                    // 其余内容立即丢弃；封行时整行都不参与判定。
                    if (state.pending.length < HEAD_UNITS) {
                        state.pending += piece.slice(0, HEAD_UNITS - state.pending.length);
                    }
                    state.overflow = true;
                }
                else {
                    state.pending += piece;
                }
            }
            if (newline < 0)
                return;
            start = newline + 1;
            const raw = state.pending.endsWith('\r') ? state.pending.slice(0, -1) : state.pending;
            const truncated = state.overflow;
            state.pending = '';
            state.overflow = false;
            if (state.skipLine) {
                state.skipLine = false;
                resetRun(state);
                continue;
            }
            if (truncated) {
                // 超长行不参与判定；只从有界前缀里识别“开围栏”，避免漏掉代码块。
                if (state.fence === null) {
                    const opener = FENCE_OPEN.exec(raw);
                    if (opener !== null)
                        state.fence = { char: opener[1][0], length: opener[1].length };
                }
                resetRun(state);
                continue;
            }
            consider(raw, state);
        }
    };
    const handle = (frame) => {
        switch (frame.type) {
            case 'block-start': {
                const index = frame.index;
                if (typeof index !== 'number' || !Number.isSafeInteger(index))
                    return;
                if (frame.blockType === 'reasoning') {
                    // 重复的 index 或超过活动块上限：按上游失序处理，停用观察。
                    if (blocks.has(index) || blocks.size >= FUZZY_LIMITS.blocks) {
                        stop();
                        return;
                    }
                    blocks.set(index, createBlock());
                    return;
                }
                progress();
                return;
            }
            case 'block-end': {
                const index = frame.index;
                if (typeof index !== 'number' || !Number.isSafeInteger(index))
                    return;
                // 只认见过换行的完整行：块尾未封行的尾巴直接丢弃。
                blocks.delete(index);
                return;
            }
            case 'reasoning-delta': {
                const index = frame.index;
                const text = frame.text;
                if (typeof index !== 'number' || !Number.isSafeInteger(index) || typeof text !== 'string')
                    return;
                let state = blocks.get(index);
                if (state === undefined) {
                    if (blocks.size >= FUZZY_LIMITS.blocks) {
                        stop();
                        return;
                    }
                    state = createBlock();
                    blocks.set(index, state);
                }
                feed(text, state);
                return;
            }
            case 'text-delta':
            case 'tool-call-delta':
                progress();
                return;
            case 'usage':
                return;
            case 'finish':
                stop();
                return;
            default:
                return;
        }
    };
    try {
        for await (const frame of source) {
            const value = frame;
            if (enabled && value !== null && typeof value === 'object')
                handle(frame);
            yield frame;
        }
    }
    finally {
        // 释放所有有界状态；上游由 for-await 关闭恰好一次（命中不关闭）。
        stop();
    }
}
