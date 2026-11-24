/**
 * A completed Turn's guard activity, rendered under the Turn through the Chat
 * list slot. It reads only the shared projection's wire view and the closing
 * Turn number; model, tool, and reasoning text never reach this component.
 */

import type { ReactNode } from 'react'
import { version as pluginVersion } from '../../package.json'
import { ACTIVITY_KEY } from '../activity-shared'
import { currentTurnHits, summarizeActivity } from './activity-summary'
import { DiagnosticPanel } from './diagnostic-panel'
import type { DiagnosticReport } from '../diagnostic-shared.js'

/** The Chat list slot that owns feature rows under a completed Turn. */
export const TURN_TAIL_SLOT = 'conversation.chat.turnTail'

/** Owner and Session standard props this entry reads. */
export interface GuardActivityTailProps {
  /** The closing Turn; only its number is used. */
  readonly turn: { readonly turn: number }
  /** Key-addressed projection reader supplied by the Session standard kit. */
  readonly useProjection?: (key: string) => unknown
  readonly reportForTurn?: (turn: number) => Promise<DiagnosticReport | null>
}

/**
 * Render one compact line when this Turn hit a guard rule.
 * @param props - the closing Turn and the projection reader.
 * @returns the line, or null for a Turn without hits.
 */
export function GuardActivityTail(props: GuardActivityTailProps): ReactNode {
  const activity = props.useProjection?.(ACTIVITY_KEY)
  const summary = summarizeActivity(activity, props.turn.turn)
  const row = summary === null ? null : (
    <div className="dfg-tail">
      <style>{TAIL_STYLES}</style>
      <span className="dfg-tail-dot" aria-hidden="true" />
      <span className="dfg-tail-label">防护</span>
      <span className="dfg-tail-text">{summary}</span>
    </div>
  )
  const reportForTurn = props.reportForTurn
  if (!reportForTurn) return row
  // Keep the legacy hit behavior, but experimental hits alone do not create RPC reports.
  const hits = currentTurnHits(activity, props.turn.turn)
  const hasLegacyHit = hits.some(hit => hit.rule === 'failure' || hit.rule === 'repeat')
  return <>{row}<DiagnosticPanel key={props.turn.turn} pluginVersion={pluginVersion} feedbackHits={hits} load={hasLegacyHit ? () => reportForTurn(props.turn.turn) : undefined} /></>
}

/** A quiet row under the Turn: one dot, a label, and the combined line. */
const TAIL_STYLES = `
.dfg-tail {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  margin: 6px 0 0;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font-size: 12px;
  line-height: 1.5;
}
.dfg-tail-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
  transform: translateY(-1px);
}
.dfg-tail-label {
  color: var(--dsw-alias-label-secondary, #4b5563);
  font-weight: 500;
}
.dfg-tail-text { min-width: 0; }
`
