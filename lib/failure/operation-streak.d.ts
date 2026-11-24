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
export interface OperationStreakDecision {
    /** 同一操作在相邻回合连续失败达到阈值时的回合数；否则 null */
    crossTurn: number | null;
    /** 同一回合内同一操作失败达到阈值时的次数；否则 null */
    wouldStop: number | null;
}
export interface OperationStreakSize {
    /** 未决调用数（有上限） */
    pending: number;
    /** 已处理 callId 的记忆条数（有上限） */
    seen: number;
    /** 当前被追踪的操作数：0 或 1 */
    active: number;
}
export interface OperationStreak {
    /** 打开一个回合；缺 turn/end 的相邻回合、回合号缺口与旧回合回放都保守清零。 */
    startTurn(turn: number): void;
    /** 结束一个回合；对不上当前回合视为乱序并保守清零。 */
    endTurn(turn: number): void;
    /** 结束一个步骤；该步骤的未决调用作废（结果不会再按序到达）。 */
    endStep(turn: number, step: number): void;
    /** 全量重置：未决调用、调用记忆、连续计数、回合与步骤游标。 */
    reset(): void;
    /** 记录一次工具调用；参数不是完整合法 JSON、身份不明或回合未打开时不登记。 */
    call(id: unknown, tool: string, args: unknown, turn: number, step: number): void;
    /** 结算一次工具调用；返回只含数字的两个信号。 */
    result(id: unknown, turn: number, step: number, failed: boolean, limit: number): OperationStreakDecision;
    /** 有界规模快照（只含数字，不含任何身份或参数原文）。 */
    readonly size: OperationStreakSize;
}
export interface OperationStreakOptions {
    /** 可注入时钟（默认 Date.now），只用于跨轮 TTL 判定。 */
    now?: () => number;
    /** 跨轮 TTL（毫秒）；默认 120000，非正数或非有限值回落到默认值。 */
    ttlMs?: number;
}
/** 全部上限与默认值；测试直接引用，避免魔法数字漂移。 */
export declare const OPERATION_LIMITS: Readonly<{
    /** 未决调用表上限（超出按插入顺序淘汰最旧的一条） */
    pending: 64;
    /** 已处理 callId 记忆上限（LRU） */
    seen: 256;
    /** 参数规范化最大嵌套深度 */
    depth: 8;
    /** 参数规范化最多访问的节点数 */
    nodes: 2048;
    /** 单个对象最多键数 */
    keys: 64;
    /** 单个数组最多元素数 */
    items: 256;
    /** 单个字符串最多字符数 */
    string: 512;
    /** 规范化文本总字符上限 */
    chars: 16384;
    /** raw string 参数（JSON 文本）长度上限 */
    raw: 65536;
    /** 工具名长度上限 */
    tool: 256;
    /** 跨轮 TTL 默认值（2 分钟） */
    ttlMs: 120000;
    /** 跨轮 TTL 上限（1 小时） */
    maxTtlMs: 3600000;
}>;
export declare function createOperationStreak(options?: OperationStreakOptions): OperationStreak;
