import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';
import { z } from 'zod';
import { ACTIVITY_KEY, GUARD_RULES, validHitFields } from './activity-shared.js';
const RECORD = 'plugin:dsh-fail-guard/hit';
const HISTORY_LIMIT = 256;
const hitSchema = z.object({
    turn: z.number().int().nonnegative(), count: z.number().int().positive(), rule: z.enum(GUARD_RULES),
    action: z.enum(['observed', 'notified', 'cut', 'steer-queued', 'would-stop']),
}).refine(hit => validHitFields(hit.rule, hit.count, hit.action));
const stateSchema = z.array(hitSchema).max(HISTORY_LIMIT);
export function foldActivity(state, event) {
    const record = pluginRecordOf(event);
    if (record?.type !== RECORD)
        return state;
    const parsed = hitSchema.safeParse(record.data);
    if (!parsed.success)
        return state;
    const hit = parsed.data;
    const previous = state.findIndex(item => item.turn === hit.turn && item.rule === hit.rule);
    if (previous < 0)
        return [...state.slice(-(HISTORY_LIMIT - 1)), hit];
    if (state[previous]?.action !== 'observed' || hit.action === 'observed')
        return state;
    const next = state.slice();
    next[previous] = hit;
    return next;
}
export function registerActivity(ctx) {
    ctx.inject(['sessionProjections'], c => {
        void c.sessionProjections.register({
            key: ACTIVITY_KEY, stateVersion: 3, stateSchema, init: () => [], apply: foldActivity,
            wire: { viewSchema: stateSchema, view: state => state, summary: false },
        }).catch(() => { });
    });
}
export function queueActivity(session, { turn, rule, count, action }, isCurrent) {
    // Tool results themselves are being appended during the event callback.
    queueMicrotask(() => {
        if (!isCurrent())
            return;
        try {
            appendPluginRecord(session, RECORD, { turn, rule, count, action });
        }
        catch { /* Display-only telemetry never changes agent behavior. */ }
    });
}
