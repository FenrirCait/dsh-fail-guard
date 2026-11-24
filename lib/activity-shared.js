export const ACTIVITY_KEY = 'dsh-fail-guard:activity';
export const FRAGMENT_COUNT_MAX = 128;
export const GUARD_RULES = ['failure', 'repeat', 'fragment', 'fuzzy', 'cross-turn', 'steer', 'stop-simulation'];
/** Shared validation for persisted records, the browser summary, and local exports. */
export function validHitFields(rule, count, action) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1)
        return false;
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
