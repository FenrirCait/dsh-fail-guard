import type { Context } from '@deepseek-ai/cordis';
import { appendPluginRecord, pluginRecordOf, type Session, type SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-projection';
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types';
import { z } from 'zod';
import { ACTIVITY_KEY, GUARD_RULES, validHitFields, type GuardHit } from './activity-shared.js';

const RECORD = 'plugin:dsh-fail-guard/hit';
const HISTORY_LIMIT = 256;
const hitSchema: z.ZodType<GuardHit> = z.object({
  turn: z.number().int().nonnegative(), count: z.number().int().positive(), rule: z.enum(GUARD_RULES),
  action: z.enum(['observed', 'notified', 'cut', 'steer-queued', 'would-stop']),
}).refine(hit => validHitFields(hit.rule, hit.count, hit.action));
const stateSchema = z.array(hitSchema).max(HISTORY_LIMIT);

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:dsh-fail-guard/hit': GuardHit }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { 'dsh-fail-guard:activity': SessionProjectionSummaryExcluded<GuardHit[]> }
}

export function foldActivity(state: GuardHit[], event: SessionEvent): GuardHit[] {
  const record = pluginRecordOf(event);
  if (record?.type !== RECORD) return state;
  const parsed = hitSchema.safeParse(record.data);
  if (!parsed.success) return state;
  const hit = parsed.data;
  const previous = state.findIndex(item => item.turn === hit.turn && item.rule === hit.rule);
  if (previous < 0) return [...state.slice(-(HISTORY_LIMIT - 1)), hit];
  if (state[previous]?.action !== 'observed' || hit.action === 'observed') return state;
  const next = state.slice();
  next[previous] = hit;
  return next;
}

export function registerActivity(ctx: Context): void {
  ctx.inject(['sessionProjections'], c => {
    void c.sessionProjections.register<typeof ACTIVITY_KEY, GuardHit[]>({
      key: ACTIVITY_KEY, stateVersion: 3, stateSchema, init: () => [], apply: foldActivity,
      wire: { viewSchema: stateSchema, view: state => state, summary: false },
    }).catch(() => { /* Failure to display activity is independent of the guard. */ });
  });
}

export function queueActivity(session: Session, { turn, rule, count, action }: GuardHit, isCurrent: () => boolean): void {
  // Tool results themselves are being appended during the event callback.
  queueMicrotask(() => {
    if (!isCurrent()) return;
    try { appendPluginRecord(session, RECORD, { turn, rule, count, action }); }
    catch { /* Display-only telemetry never changes agent behavior. */ }
  });
}
