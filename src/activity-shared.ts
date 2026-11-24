export const ACTIVITY_KEY = 'dsh-fail-guard:activity';
export const FRAGMENT_COUNT_MAX = 128;

export const GUARD_RULES = ['failure', 'repeat', 'fragment', 'fuzzy', 'cross-turn', 'steer', 'stop-simulation'] as const;
export type GuardRule = typeof GUARD_RULES[number];
export type GuardAction = 'observed' | 'notified' | 'cut' | 'steer-queued' | 'would-stop';

export type GuardHit = { turn: number; rule: GuardRule; count: number; action: GuardAction };

/** Shared validation for persisted records, the browser summary, and local exports. */
export function validHitFields(rule: unknown, count: unknown, action: unknown): boolean {
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return false;
  switch (rule) {
    case 'failure': return action === 'observed' || action === 'notified';
    case 'repeat': return action === 'observed' || action === 'cut';
    case 'fragment': return count <= FRAGMENT_COUNT_MAX && action === 'observed';
    case 'fuzzy': return count === 4 && action === 'observed';
    case 'cross-turn': return count <= 64 && action === 'observed';
    case 'steer': return count === 1 && action === 'steer-queued';
    case 'stop-simulation': return count <= 12 && action === 'would-stop';
    default: return false;
  }
}
