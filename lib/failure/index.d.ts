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
export interface FailureTracker {
    readonly consecutive: number;
    /** 记录一次工具调用。参数非法、或属于历史回放（坐标早于最近一次已接受调用）时忽略。 */
    call(id: unknown, tool: string, turn: number, step: number): void;
    /**
     * 记录一次工具调用结果。
     * @param failed 该调用是否失败
     * @param limit  连续失败通知阈值（宿主配置，合法范围 2–12）
     * @returns 需要告知 agent 的文本；不需要时为 null
     */
    result(id: unknown, turn: number, step: number, failed: boolean, limit: number): string | null;
    /** 全量重置：在途调用、连续计数、通知记忆、坐标游标。 */
    clear(): void;
    /** 只丢弃在途调用记录（历史替换或回合中止时用），保留连续计数与通知记忆。 */
    clearPending(): void;
}
export declare function createFailureTracker(): FailureTracker;
