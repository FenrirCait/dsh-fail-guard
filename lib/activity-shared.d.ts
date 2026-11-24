export declare const ACTIVITY_KEY = "dsh-fail-guard:activity";
export declare const FRAGMENT_COUNT_MAX = 128;
export declare const GUARD_RULES: readonly ['failure', 'repeat', 'fragment', 'fuzzy', 'cross-turn', 'steer', 'stop-simulation'];
export type GuardRule = typeof GUARD_RULES[number];
export type GuardAction = 'observed' | 'notified' | 'cut' | 'steer-queued' | 'would-stop';
export type GuardHit = {
    turn: number;
    rule: GuardRule;
    count: number;
    action: GuardAction;
};
/** Shared validation for persisted records, the browser summary, and local exports. */
export declare function validHitFields(rule: unknown, count: unknown, action: unknown): boolean;
