/**
 * dsh-fail-guard · 同一操作跨轮与模拟停手状态（独立、纯状态机）
 *
 * 契约（ARCHITECTURE.md）：
 * - 宿主按 agent 会话各自持有一个实例，只喂真实事件；本模块不跨会话共享状态；
 * - call() 记录一次工具调用（callId + 工具名 + 参数 + turn/step）；
 * - result() 结算该调用，只返回两个数字信号（没有文本、没有动作、不取消任何调用）：
 *   · crossTurn：同一操作在相邻回合连续失败的回合数（达到阈值时的回合数），否则 null；
 *   · wouldStop：同一回合内同一操作失败达到阈值时的次数，否则 null；
 * - 操作身份 = 工具名 + 参数的有界规范化文本的 64 位内存指纹；参数原文不保留、不输出；
 * - 参数只接受 JSON：宿主给的 raw string 必须是完整合法 JSON（JSON.parse 通过），
 *   undefined、截断/带尾随内容/裸字符串等无效 JSON，以及 NaN/Infinity/bigint 等非 JSON 值，
 *   一律视为身份不明：不登记、且保守清零；
 * - 成功、换操作、身份不明、并发乱序、回合缺失、并行未结算、缺 turn/end 一律保守清零：
 *   宁可漏报，不可误报；
 * - 活动（未决调用）与记忆（已处理 callId）都有上限；不读写磁盘、不执行工具、不取消调用。
 *
 * 保守清零的七种情形：
 *   1. 成功：任何非失败结果都清空当前段；
 *   2. 换操作：不同工具或不同参数（不同指纹）的调用会清空上一操作的段；
 *   3. 身份不明：参数不是完整合法的 JSON、无法精确规范化（环、函数、类实例、Map/Date、超上限），
 *      或结果对应的 callId 从未登记；
 *   4. 并发乱序：结果坐标与调用坐标不符、step 或 turn 已结束、旧回合回放；
 *   5. 回合缺失：结果所属回合没有 startTurn、没有打开任何回合、回合号出现缺口；
 *   6. 并行未结算：同一 (turn, step) 同时存在多条未结算调用时，该 step 的结果不累计；
 *   7. 缺 turn/end：上一回合没有 endTurn 就直接 startTurn 下一回合时，连续段中断。
 */
/** 全部上限与默认值；测试直接引用，避免魔法数字漂移。 */
export const OPERATION_LIMITS = Object.freeze({
    /** 未决调用表上限（超出按插入顺序淘汰最旧的一条） */
    pending: 64,
    /** 已处理 callId 记忆上限（LRU） */
    seen: 256,
    /** 参数规范化最大嵌套深度 */
    depth: 8,
    /** 参数规范化最多访问的节点数 */
    nodes: 2048,
    /** 单个对象最多键数 */
    keys: 64,
    /** 单个数组最多元素数 */
    items: 256,
    /** 单个字符串最多字符数 */
    string: 512,
    /** 规范化文本总字符上限 */
    chars: 16384,
    /** raw string 参数（JSON 文本）长度上限 */
    raw: 65536,
    /** 工具名长度上限 */
    tool: 256,
    /** 跨轮 TTL 默认值（2 分钟） */
    ttlMs: 120_000,
    /** 跨轮 TTL 上限（1 小时） */
    maxTtlMs: 3_600_000,
});
function defaultClock() {
    return Date.now();
}
function normalizeTtl(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return OPERATION_LIMITS.ttlMs;
    return Math.min(value, OPERATION_LIMITS.maxTtlMs);
}
function thresholdOf(limit) {
    if (typeof limit !== 'number' || !Number.isFinite(limit))
        return null;
    const value = Math.floor(limit);
    return value >= 2 ? value : null;
}
function isTurnNumber(turn) {
    return Number.isSafeInteger(turn) && turn >= 0;
}
function isCoordinate(turn, step) {
    return isTurnNumber(turn) && Number.isSafeInteger(step) && step >= 0;
}
function charge(size, budget) {
    budget.chars += size;
    return budget.chars <= OPERATION_LIMITS.chars;
}
function spend(text, budget) {
    return charge(text.length, budget) ? text : null;
}
function hex8(value) {
    return ('0000000' + value.toString(16)).slice(-8);
}
/** 64 位（两路 32 位）FNV-1a 变体：只用于同一实例内的操作身份比较，不输出指纹本身。 */
function digest(text) {
    let low = 0x811c9dc5;
    let high = 0x01000193;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        low = Math.imul(low ^ (code & 0xff), 0x01000193);
        low = Math.imul(low ^ (code >>> 8), 0x01000193);
        high = Math.imul(high ^ (code >>> 8), 0x85ebca6b) ^ index;
        high = Math.imul(high ^ (code & 0xff), 0xc2b2ae35);
    }
    low >>>= 0;
    high >>>= 0;
    return hex8(low) + hex8(high);
}
/**
 * 宿主 raw string arguments 必须是完整合法 JSON：JSON.parse 必须成功，尾随内容/裸字符串都算无效。
 * undefined 不登记；已经解析好的非字符串参数原样校验 JSON 值域。
 */
function parseArguments(args) {
    if (args === undefined)
        return { ok: false };
    if (typeof args === 'string') {
        if (args.length > OPERATION_LIMITS.raw)
            return { ok: false };
        try {
            return { ok: true, value: JSON.parse(args) };
        }
        catch {
            return { ok: false };
        }
    }
    return { ok: true, value: args };
}
/**
 * 把参数编码成规范文本：对象键排序、数组保序、只接受 JSON 值域。
 * 无法精确表示时返回 null（身份不明），绝不截断或近似：截断会让不同参数误判为同一操作。
 */
function encodeValue(value, depth, budget) {
    budget.nodes += 1;
    if (budget.nodes > OPERATION_LIMITS.nodes || depth > OPERATION_LIMITS.depth)
        return null;
    if (typeof value === 'string') {
        if (value.length > OPERATION_LIMITS.string)
            return null;
        const text = JSON.stringify(value);
        return text === undefined ? null : spend(text, budget);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            return null; // NaN / ±Infinity 不是 JSON
        return spend(Object.is(value, -0) ? '0' : String(value), budget);
    }
    if (typeof value === 'boolean')
        return value ? 'true' : 'false';
    if (value === null)
        return 'null';
    if (typeof value !== 'object')
        return null; // undefined / bigint / function / symbol 不是 JSON
    if (budget.path.has(value))
        return null; // 环：无法展开
    if (Array.isArray(value)) {
        if (value.length > OPERATION_LIMITS.items)
            return null;
        budget.path.add(value);
        try {
            const parts = [];
            for (let index = 0; index < value.length; index += 1) {
                const text = encodeValue(value[index], depth + 1, budget);
                if (text === null)
                    return null;
                parts.push(text);
            }
            return charge(2 + Math.max(0, parts.length - 1), budget) ? '[' + parts.join(',') + ']' : null;
        }
        finally {
            budget.path.delete(value);
        }
    }
    const record = value;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null)
        return null; // 类实例 / Map / Date：不是 JSON
    const keys = Object.keys(record);
    if (keys.length > OPERATION_LIMITS.keys)
        return null;
    keys.sort(); // 有界 canonical key order
    budget.path.add(value);
    try {
        const parts = [];
        for (const key of keys) {
            const text = encodeValue(record[key], depth + 1, budget);
            if (text === null)
                return null;
            const name = JSON.stringify(key);
            if (name === undefined || !charge(name.length + 1, budget))
                return null;
            parts.push(name + ':' + text);
        }
        return charge(2 + Math.max(0, parts.length - 1), budget) ? '{' + parts.join(',') + '}' : null;
    }
    finally {
        budget.path.delete(value);
    }
}
/** 操作指纹；参数不是完整合法 JSON、不可精确规范化或工具名非法时返回 null。 */
function fingerprint(tool, args) {
    if (typeof tool !== 'string' || tool.length === 0 || tool.length > OPERATION_LIMITS.tool)
        return null;
    const parsed = parseArguments(args);
    if (!parsed.ok)
        return null;
    try {
        const budget = { nodes: 0, chars: tool.length + 1, path: new Set() };
        const canonical = encodeValue(parsed.value, 0, budget);
        if (canonical === null)
            return null;
        return digest(tool + '\u0000' + canonical);
    }
    catch {
        return null; // 参数里的 getter / Proxy 抛错：身份不明
    }
}
export function createOperationStreak(options = {}) {
    const clock = typeof options.now === 'function' ? options.now : defaultClock;
    const ttlMs = normalizeTtl(options.ttlMs);
    /** callId -> 未结算的调用 */
    const pending = new Map();
    /** 已结算的 callId（LRU）：重复结果/回放调用直接忽略 */
    const seen = new Map();
    /** 当前唯一被追踪的操作段；null 表示已保守清零 */
    let track = null;
    /** 当前打开的回合；null 表示没有回合在跑 */
    let openTurn = null;
    /** 最近一次正常结束的回合 */
    let closedTurn = null;
    /** 当前回合内最近结束的步骤 */
    let stepCursor = null;
    function clearCounts() {
        track = null;
    }
    function dropTurn(turn) {
        for (const [id, entry] of pending)
            if (entry.turn === turn)
                pending.delete(id);
    }
    function dropStep(turn, step) {
        for (const [id, entry] of pending)
            if (entry.turn === turn && entry.step === step)
                pending.delete(id);
    }
    function rememberSeen(id) {
        seen.delete(id);
        seen.set(id, true);
        while (seen.size > OPERATION_LIMITS.seen) {
            const oldest = seen.keys().next();
            if (oldest.done)
                break;
            seen.delete(oldest.value);
        }
    }
    function rememberPending(id, entry) {
        pending.delete(id);
        pending.set(id, entry);
        while (pending.size > OPERATION_LIMITS.pending) {
            const oldest = pending.keys().next();
            if (oldest.done)
                break;
            pending.delete(oldest.value);
        }
    }
    const streak = {
        startTurn(turn) {
            if (!isTurnNumber(turn)) {
                streak.reset();
                return;
            }
            if (openTurn === null && closedTurn !== null && turn <= closedTurn) {
                clearCounts(); // 已结束的旧回合回放：忽略，不重新打开
                return;
            }
            if (openTurn !== null) {
                if (turn === openTurn)
                    return; // 同一回合重复开始：幂等
                if (turn < openTurn) {
                    clearCounts(); // 更早的回合：乱序
                    return;
                }
                clearCounts(); // 缺 turn/end：连续段中断
                dropTurn(openTurn);
                openTurn = turn;
                stepCursor = null;
                return;
            }
            if (closedTurn !== null && turn > closedTurn + 1)
                clearCounts(); // 回合缺口：保守清零
            openTurn = turn;
            stepCursor = null;
        },
        endTurn(turn) {
            if (!isTurnNumber(turn)) {
                streak.reset();
                return;
            }
            if (openTurn === null || openTurn !== turn) {
                clearCounts(); // 没有开始过、或对不上当前回合：乱序
                return;
            }
            dropTurn(turn);
            openTurn = null;
            stepCursor = null;
            closedTurn = closedTurn === null || turn > closedTurn ? turn : closedTurn;
        },
        endStep(turn, step) {
            if (!isCoordinate(turn, step)) {
                streak.reset();
                return;
            }
            if (openTurn === null || openTurn !== turn) {
                clearCounts(); // 回合缺失或对不上：乱序
                return;
            }
            if (stepCursor !== null && step < stepCursor) {
                clearCounts(); // 步骤回退：乱序
                return;
            }
            stepCursor = step;
            dropStep(turn, step); // 该步骤的未决调用作废
        },
        reset() {
            pending.clear();
            seen.clear();
            track = null;
            openTurn = null;
            closedTurn = null;
            stepCursor = null;
        },
        call(id, tool, args, turn, step) {
            if (id === null || id === undefined || id === '')
                return; // 没有可用身份：不登记
            if (seen.has(id))
                return; // 已结算调用的回放：忽略
            if (!isCoordinate(turn, step)) {
                clearCounts();
                return;
            }
            if (openTurn === null || openTurn !== turn) {
                clearCounts(); // 回合缺失：结果无法归属
                return;
            }
            if (stepCursor !== null && step <= stepCursor) {
                clearCounts(); // 已结束步骤的迟到调用：不登记，并打断连续段
                return;
            }
            const key = fingerprint(tool, args);
            if (key === null) {
                clearCounts(); // 身份不明：参数不是完整合法 JSON 或不可精确规范化
                return;
            }
            if (track !== null && track.key !== key)
                clearCounts(); // 换操作
            const previous = pending.get(id);
            if (previous !== undefined) {
                if (previous.key !== key || previous.turn !== turn || previous.step !== step)
                    clearCounts(); // callId 复用
                rememberPending(id, { key, turn, step, ambiguous: previous.ambiguous }); // 同一 callId 重复调用：幂等刷新
                return;
            }
            // 同一 (turn, step) 已有多条未结算调用：该步骤的结果无法无歧义归属，保守中断。
            let ambiguous = false;
            for (const entry of pending.values()) {
                if (entry.turn === turn && entry.step === step) {
                    entry.ambiguous = true;
                    ambiguous = true;
                }
            }
            if (ambiguous)
                clearCounts();
            rememberPending(id, { key, turn, step, ambiguous });
        },
        result(id, turn, step, failed, limit) {
            const threshold = thresholdOf(limit);
            const entry = pending.get(id);
            if (entry === undefined) {
                const identifiable = id !== null && id !== undefined && id !== '';
                if (identifiable && seen.has(id))
                    return { crossTurn: null, wouldStop: null }; // 重复结果：幂等忽略
                clearCounts(); // 身份不明
                return { crossTurn: null, wouldStop: null };
            }
            if (!isCoordinate(turn, step) || entry.turn !== turn || entry.step !== step) {
                clearCounts(); // 坐标不符（并发乱序）：保留 pending，等真正的结果
                return { crossTurn: null, wouldStop: null };
            }
            pending.delete(id);
            rememberSeen(id);
            if (entry.ambiguous) {
                clearCounts(); // 同一步多条未结算调用：不误累计
                return { crossTurn: null, wouldStop: null };
            }
            if (openTurn === null || openTurn !== turn) {
                clearCounts(); // 回合缺失或已结束
                return { crossTurn: null, wouldStop: null };
            }
            if (failed !== true) {
                clearCounts(); // 成功（或非失败）即清零
                return { crossTurn: null, wouldStop: null };
            }
            const now = clock();
            let next;
            if (track === null || track.key !== entry.key) {
                next = { key: entry.key, turn, sameTurn: 1, crossTurns: 1, lastTurn: turn, lastAt: now };
            }
            else if (track.turn === turn) {
                next = { ...track, sameTurn: track.sameTurn + 1, lastTurn: turn, lastAt: now };
            }
            else {
                const adjacent = track.lastTurn === turn - 1;
                const withinTtl = Number.isFinite(now) && now >= track.lastAt && now - track.lastAt <= ttlMs;
                next = {
                    ...track,
                    turn,
                    sameTurn: 1,
                    crossTurns: adjacent && withinTtl ? track.crossTurns + 1 : 1,
                    lastTurn: turn,
                    lastAt: now,
                };
            }
            track = next;
            if (threshold === null)
                return { crossTurn: null, wouldStop: null };
            return {
                crossTurn: next.crossTurns >= 2 && next.crossTurns >= threshold ? next.crossTurns : null,
                wouldStop: next.sameTurn >= threshold ? next.sameTurn : null,
            };
        },
        get size() {
            return Object.freeze({ pending: pending.size, seen: seen.size, active: track === null ? 0 : 1 });
        },
    };
    return streak;
}
