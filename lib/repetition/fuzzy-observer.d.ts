import type { StreamChunk } from '@deepseek-ai/dsh-llm';
/** 观察器的有界参数（供接线与测试引用）。 */
export declare const FUZZY_LIMITS: Readonly<{
    /** 同时跟踪的 reasoning 块上限。 */
    blocks: 64;
    /** 单行最多 code units（UTF-16）。 */
    line: 96;
    /** 参与判定的最短行（trim 后）。 */
    minLine: 4;
    /** 一组近重复至少多少行。 */
    group: 4;
    /** 长行允许的最大编辑距离。 */
    edits: 2;
}>;
/**
 * 观察一条模型流里的近重复 reasoning 行，命中的同一条流只报告一次。
 *
 * 只观察，不截断、不改写、不关闭上游；每个 frame 原样透传。
 *
 * @param source 上游模型流（通常是 `LlmRuntime.stream()` 的结果）
 * @param onHit  命中回调：参数是连续近重复行数（命中时为 4；只给数字，不含正文）；
 *               回调抛出的异常被吞掉，不影响流
 */
export declare function observeFuzzy(source: AsyncIterable<StreamChunk>, onHit: (count: number) => void): AsyncGenerator<StreamChunk, void, void>;
