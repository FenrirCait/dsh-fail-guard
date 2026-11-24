/**
 * Turn-scoped view of the guard's activity projection. The Host folds one
 * record per rule per Turn; the client only reads the finished wire view,
 * narrows it to the closing Turn, and renders one short line. It never reads
 * message, tool, or reasoning content.
 */

import { GUARD_RULES, validHitFields, type GuardHit } from '../activity-shared'

/** Whether one unknown wire entry is a complete hit for the requested Turn. */
function isHit(value: unknown, turn: number): value is GuardHit {
  if (value === null || typeof value !== 'object') return false
  const hit = value as Record<string, unknown>
  return hit.turn === turn && validHitFields(hit.rule, hit.count, hit.action)
}

/**
 * The strongest hit of each rule for one Turn.
 * @param value - the projection's wire view; unknown until the Host baseline lands.
 * @param turn - the closing Turn number.
 * @returns the hits in rule order; empty when the Turn has none.
 */
export function currentTurnHits(value: unknown, turn: number): GuardHit[] {
  if (!Array.isArray(value)) return []
  const byRule = new Map<GuardHit['rule'], GuardHit>()
  for (const item of value) {
    if (!isHit(item, turn)) continue
    const previous = byRule.get(item.rule)
    // A later decisive hit replaces an earlier observation; observations never
    // replace a decisive hit, so a replayed view cannot soften the line.
    if (previous === undefined || (previous.action === 'observed' && item.action !== 'observed')) {
      byRule.set(item.rule, item)
    }
  }
  const hits: GuardHit[] = []
  for (const rule of GUARD_RULES) {
    const hit = byRule.get(rule)
    if (hit) hits.push(hit)
  }
  return hits
}

/** The short action label the summary line shows. */
function actionLabel(hit: GuardHit): string {
  if (hit.action === 'notified') return '已提示停手'
  if (hit.action === 'cut') return '已截断'
  return '仅记录'
}

/**
 * One line combining this Turn's guard hits.
 * @param value - the projection's wire view.
 * @param turn - the closing Turn number.
 * @returns the summary text, or null when the Turn has no hit.
 */
export function summarizeActivity(value: unknown, turn: number): string | null {
  const hits = currentTurnHits(value, turn)
  if (hits.length === 0) return null
  return hits.map(hit => {
    if (hit.rule === 'fragment') return `短碎片疑似复读 ${hit.count} 段（仅观察）`
    if (hit.rule === 'fuzzy') return `模糊复读 ${hit.count} 行（仅观察）`
    if (hit.rule === 'cross-turn') return `同一操作连续失败 ${hit.count} 轮（仅观察）`
    if (hit.rule === 'steer') return '复读引导已排队'
    if (hit.rule === 'stop-simulation') return `模拟停手：同一操作失败 ${hit.count} 次（未中止）`
    if (hit.rule === 'failure') return `连续失败 ${hit.count} 次（${actionLabel(hit)}）`
    return `复读 ${hit.count} 行（${actionLabel(hit)}）`
  }).join(' · ')
}
