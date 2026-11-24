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
import { type GuardOptions } from './options.js';
/** 自检覆盖的两条规则。 */
export type SelfCheckRule = 'failure' | 'repeat';
/**
 * 规则在本次配置下的处置：
 * - disabled：规则停用，引擎没有运行；
 * - none：引擎运行了，但固定样本没有达到阈值；
 * - observed：命中，但 observeOnly 打开，只记录不通知、不截断；
 * - notified：失败规则命中，宿主会向 agent 发一条通知（不中断回合）；
 * - cut：复读规则命中且安全截断条件成立，宿主会截断这条流。
 */
export type SelfCheckAction = 'disabled' | 'none' | 'observed' | 'notified' | 'cut';
/** 一条规则的自检结论。字段固定，便于宿主直接渲染。 */
export interface SelfCheckResult {
    /** 规则名。 */
    readonly rule: SelfCheckRule;
    /** 本次喂入该规则的固定样本条数（failure 6、repeat 8）；规则停用、引擎未运行时为 0。 */
    readonly inputCount: number;
    /** 本次使用的阈值（来自配置，已按 LIMITS 夹取）。 */
    readonly threshold: number;
    /** 引擎的处置结论；命中发生在第 threshold 条输入上。 */
    readonly action: SelfCheckAction;
    /**
     * 宿主是否会在本回合结束后请求自动续跑。
     * 只有复读截断（cut）且开启 resumeOnRepeat 才是 true；失败通知永远不触发续跑。
     */
    readonly wouldResume: boolean;
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
export declare function runSelfCheck(options: Readonly<GuardOptions>): Promise<readonly SelfCheckResult[]>;
