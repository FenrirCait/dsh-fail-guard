/**
 * dsh-fail-guard · 连续失败追踪内核（独立实现）
 *
 * 契约（ARCHITECTURE.md）：
 * - 宿主按 agent 会话持有一个 tracker 实例，只喂真实事件；
 * - call() 记录一次工具调用（callId + 工具名 + turn/step 坐标）；
 * - result() 记录这次调用的结果；只有能匹配到 pending 调用、且坐标完全一致的结果才被计入；
 * - 同一工具连续失败达到 limit 时返回一条通知文本，每轮至多一次；
 * - 成功结果或其它工具的结果会重置当前连续计数；
 * - 未匹配结果、坐标不一致结果、历史替换回放的旧调用一律忽略；
 * - pending 表有上限，不随会话无限增长。
 *
 * 本模块是纯状态机：不依赖宿主包、不读写磁盘、不记录思考或工具正文。
 */
/** pending 容量上限：超出后按插入顺序淘汰最旧的一条。 */
const MAX_PENDING = 64;
/** 已处理 callId 的短期记忆上限：足以识别历史回放的旧调用，同时保持内存有界。 */
const MAX_SEEN = 256;
export function createFailureTracker() {
    /** callId -> 未返回结果的调用 */
    const pending = new Map();
    /** 已处理完的 callId（LRU）：历史替换回放同一 callId 时直接忽略。 */
    const seen = new Map();
    /** 当前连续失败段：工具名 + 次数 */
    let streakTool = null;
    let streakCount = 0;
    /** 最近一次通知所在的轮次（每轮至多一次通知） */
    let notifiedTurn = null;
    let hasNotified = false;
    /** 最近一次已接受调用的坐标，用于丢弃历史替换回放的旧事件 */
    let lastTurn = null;
    let lastStep = null;
    const hasCoordinate = (turn, step) => typeof turn === 'number' && Number.isFinite(turn) && typeof step === 'number' && Number.isFinite(step);
    /** 坐标早于最近一次已接受调用 = 历史回放，忽略。 */
    function isReplay(turn, step) {
        if (!hasCoordinate(turn, step) || lastTurn === null || lastStep === null)
            return false;
        if (turn < lastTurn)
            return true;
        return turn === lastTurn && step < lastStep;
    }
    function rememberSeen(id) {
        seen.delete(id);
        seen.set(id, true);
        if (seen.size > MAX_SEEN) {
            const oldest = seen.keys().next();
            if (!oldest.done)
                seen.delete(oldest.value);
        }
    }
    function remember(id, tool, turn, step) {
        // 同一 callId 再次出现时以最后一次记录为准，并刷新插入顺序。
        pending.delete(id);
        pending.set(id, { tool, turn, step });
        if (pending.size > MAX_PENDING) {
            const oldest = pending.keys().next();
            if (!oldest.done)
                pending.delete(oldest.value);
        }
    }
    return {
        get consecutive() { return streakCount; },
        call(id, tool, turn, step) {
            if (id === null || id === undefined || id === '')
                return;
            if (typeof tool !== 'string' || tool.length === 0)
                return;
            if (seen.has(id))
                return; // 已处理过的调用：历史回放，忽略
            if (isReplay(turn, step))
                return;
            remember(id, tool, turn, step);
            if (hasCoordinate(turn, step)) {
                lastTurn = turn;
                lastStep = step;
            }
        },
        result(id, turn, step, failed, limit) {
            const entry = pending.get(id);
            if (entry === undefined)
                return null; // 未匹配：忽略
            if (entry.turn !== turn || entry.step !== step)
                return null; // 坐标不一致：忽略
            pending.delete(id);
            rememberSeen(id);
            if (!failed) {
                // 成功结果重置连续失败段。
                streakTool = null;
                streakCount = 0;
                return null;
            }
            if (entry.tool === streakTool) {
                streakCount += 1;
            }
            else {
                streakTool = entry.tool;
                streakCount = 1;
            }
            if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 2)
                return null;
            if (streakCount < limit)
                return null;
            if (hasNotified && Object.is(notifiedTurn, turn))
                return null;
            hasNotified = true;
            notifiedTurn = turn;
            return ('工具「' + entry.tool + '」已连续失败 ' + streakCount + ' 次（阈值 ' + limit + '）。' +
                '停止重复同一调用：检查错误原文，换用其它方式或向用户报告。');
        },
        clear() {
            pending.clear();
            seen.clear();
            streakTool = null;
            streakCount = 0;
            notifiedTurn = null;
            hasNotified = false;
            lastTurn = null;
            lastStep = null;
        },
        clearPending() {
            // 只清在途记录：连续计数与通知记忆保留，坐标游标保留以防旧事件回放。
            pending.clear();
        },
    };
}
