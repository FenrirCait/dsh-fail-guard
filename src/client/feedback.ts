import { GUARD_RULES, validHitFields, type GuardHit } from '../activity-shared.js'

export const FEEDBACK_RULES = GUARD_RULES
export const FEEDBACK_LABELS = ['correct_hit', 'false_positive', 'false_negative'] as const
export const REPORTED_ENABLEMENT = ['unknown', 'enabled', 'disabled'] as const
export type FeedbackRule = typeof FEEDBACK_RULES[number]
export type FeedbackLabel = typeof FEEDBACK_LABELS[number]

export interface FeedbackDocument {
  readonly version: 1
  readonly kind: 'feedback'
  readonly rule: FeedbackRule
  readonly label: FeedbackLabel
  readonly detection: 'recorded_hit' | 'unknown'
  readonly enablement: 'observed_enabled' | 'reported_enabled' | 'reported_disabled' | 'unknown'
  readonly exporterVersion?: string
  readonly count?: number
  readonly action?: GuardHit['action']
}

/** Select only the known rule and its valid count/action pair. Never copy the hit object. */
export function feedbackHit(hits: readonly GuardHit[], rule: unknown): GuardHit | undefined {
  return hits.find(hit => hit.rule === rule && validHitFields(hit.rule, hit.count, hit.action))
}

export function feedbackLabels(hit: GuardHit | undefined): readonly FeedbackLabel[] {
  return hit ? FEEDBACK_LABELS.slice(0, 2) : FEEDBACK_LABELS.slice(2)
}

/** No clock, identifier, text input, storage, or network API in a feedback payload. */
export function buildFeedbackDocument(input: {
  rule: unknown
  label: unknown
  hits: readonly GuardHit[]
  reportedEnablement?: unknown
  exporterVersion?: string
  includeVersion?: boolean
  includeDetails?: boolean
}): FeedbackDocument | null {
  const rule = FEEDBACK_RULES.find(rule => rule === input.rule)
  if (!rule) return null
  const hit = feedbackHit(input.hits, rule)
  const label = feedbackLabels(hit).find(label => label === input.label)
  if (!label) return null
  const enablement = hit ? 'observed_enabled' : input.reportedEnablement === 'enabled' ? 'reported_enabled'
    : input.reportedEnablement === 'disabled' ? 'reported_disabled' : 'unknown'
  const version = input.exporterVersion
  return {
    version: 1, kind: 'feedback', rule, label,
    detection: hit ? 'recorded_hit' : 'unknown',
    enablement,
    ...(input.includeVersion && typeof version === 'string' && version.length <= 48 && /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(version)
      ? { exporterVersion: version } : {}),
    ...(input.includeDetails && hit ? { count: hit.count, action: hit.action } : {}),
  }
}
