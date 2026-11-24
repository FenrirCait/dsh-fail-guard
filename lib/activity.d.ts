import type { Context } from '@deepseek-ai/cordis';
import { type Session, type SessionEvent } from '@deepseek-ai/dsh-session';
import { type GuardHit } from './activity-shared.js';
declare module '@deepseek-ai/dsh-session/types' {
    interface PluginRecordMap {
        'plugin:dsh-fail-guard/hit': GuardHit;
    }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionMap {
        'dsh-fail-guard:activity': SessionProjectionSummaryExcluded<GuardHit[]>;
    }
}
export declare function foldActivity(state: GuardHit[], event: SessionEvent): GuardHit[];
export declare function registerActivity(ctx: Context): void;
export declare function queueActivity(session: Session, { turn, rule, count, action }: GuardHit, isCurrent: () => boolean): void;
