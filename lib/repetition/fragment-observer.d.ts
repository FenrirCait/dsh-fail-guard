import type { StreamChunk } from '@deepseek-ai/dsh-llm';
export declare const LIMITS: Readonly<{
    blocks: 64;
    line: 256;
    window: 12;
    minFragments: 8;
}>;
export type FragmentSignal = Readonly<{
    rule: 'fragment-window' | 'inline-fragments';
    fragments: number;
    distinct: number;
    lines?: number;
}>;
/** Forward every frame as received. Emit at most one metadata-only report per source. */
export declare function observeFragments(source: AsyncIterable<StreamChunk>, onSignal: (report: FragmentSignal) => void): AsyncGenerator<StreamChunk, void, void>;
