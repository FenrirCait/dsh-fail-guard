/**
 * The bundle configuration page's staged draft, bound to the Host's settings
 * entry. One controller owns the form values, the user's edits, validation,
 * and the single atomic write; the React page only renders its snapshot.
 */

import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import { DEFAULTS, LIMITS, type GuardOptions } from '../options'
import { runSelfCheck, type SelfCheckResult } from '../self-check.js'

/** One numeric limit's accepted closed interval. */
interface LimitRange {
  readonly min: number
  readonly max: number
}

/** The numeric fields and the range each accepts. */
const LIMIT_FIELDS = {
  failureLimit: LIMITS.failureLimit,
  repeatLimit: LIMITS.repeatLimit,
} as const satisfies Record<string, LimitRange>

/** A guard limit edited as text, so an emptied or partial entry stays visible. */
export type GuardNumberField = keyof typeof LIMIT_FIELDS

/**
 * The four experimental switches. Their declaration belongs to {@link GuardOptions}
 * (the same package owns the field list); this page treats an undeclared key as
 * off, so the form, the draft and the write stay wired in either state.
 */
export const EXPERIMENTAL_SWITCHES = [
  'fuzzyObserveEnabled',
  'crossTurnObserveEnabled',
  'activeSteerEnabled',
  'stopSimulationEnabled',
] as const

/** One experimental switch's name. */
export type GuardExperimentalSwitch = typeof EXPERIMENTAL_SWITCHES[number]

/** The Host section as this page reads it: the declared options plus the experiments. */
export type GuardOptionValues = Readonly<GuardOptions> &
  Readonly<Record<GuardExperimentalSwitch, boolean>>

/** Every boolean field GuardOptions declares; derived, so a new flag cannot be missed. */
type GuardBooleanField = {
  [Key in keyof GuardOptions]: GuardOptions[Key] extends boolean ? Key : never
}[keyof GuardOptions]

/**
 * Every boolean switch this page renders, in form order. The `satisfies` clause
 * is the compile-time completeness check: a boolean added to GuardOptions (or to
 * {@link EXPERIMENTAL_SWITCHES}) without a row here fails the type check, so the
 * settings page can never silently drop a switch.
 */
const SWITCH_FIELDS = {
  failureEnabled: true,
  repeatEnabled: true,
  resumeOnRepeat: true,
  observeOnly: true,
  fragmentObserveEnabled: true,
  fuzzyObserveEnabled: true,
  crossTurnObserveEnabled: true,
  activeSteerEnabled: true,
  stopSimulationEnabled: true,
  diagnosticsEnabled: true,
} as const satisfies Record<GuardBooleanField | GuardExperimentalSwitch, true>

/** A boolean guard switch. */
export type GuardSwitchField = GuardBooleanField | GuardExperimentalSwitch

/** Every field the page edits. */
export type GuardField = GuardNumberField | GuardSwitchField

/** The editable values as the form holds them. */
export interface GuardDraft {
  readonly failureEnabled: boolean
  /** Decimal text; validated against {@link LIMITS.failureLimit} on save. */
  readonly failureLimit: string
  readonly repeatEnabled: boolean
  /** Decimal text; validated against {@link LIMITS.repeatLimit} on save. */
  readonly repeatLimit: string
  readonly resumeOnRepeat: boolean
  /** Pause both interventions: hits are recorded, not shown or cut. */
  readonly observeOnly: boolean
  readonly diagnosticsEnabled: boolean
  readonly fragmentObserveEnabled: boolean
  /** Experiment: count near-duplicate reasoning lines at the end of the turn only. */
  readonly fuzzyObserveEnabled: boolean
  /** Experiment: count the same operation repeated across adjacent turns at the end of the turn only. */
  readonly crossTurnObserveEnabled: boolean
  /** Experiment: send one steer after a turn whose precise repeat was already cut. */
  readonly activeSteerEnabled: boolean
  /** Experiment: record a simulated stop without cancelling anything. */
  readonly stopSimulationEnabled: boolean
}

/** One field's validation result. */
export interface GuardFieldNotice {
  readonly invalid: boolean
  /** Present only while {@link invalid} is true. */
  readonly message: string | null
}

/** The outcome line under the form. */
export type GuardNoticeKind = 'saved' | 'conflict' | 'error' | 'invalid'

/** A form-level outcome the footer announces. */
export interface GuardNotice {
  readonly kind: GuardNoticeKind
  readonly text: string
}

/** Everything the page renders, in one stable snapshot. */
export type SelfCheckState =
  | { kind: 'running' | 'error' }
  | { kind: 'result'; results: readonly SelfCheckResult[] }

export interface GuardConfigState {
  readonly selfCheck: SelfCheckState | null
  /** Host synchronization state of this settings entry. */
  readonly status: 'loading' | 'ready' | 'unavailable'
  /** Whether the Host document accepts writes. */
  readonly writable: boolean
  /** Latest configuration accepted by the Host, never the local draft. */
  readonly effective: Readonly<GuardOptionValues> | null
  /** The editable values, including in-progress text. */
  readonly draft: GuardDraft
  /** Validation of the failure limit (only while its guard is on). */
  readonly failureLimit: GuardFieldNotice
  /** Validation of the repeat limit (only while its guard is on). */
  readonly repeatLimit: GuardFieldNotice
  /** Whether the draft would write at least one field. */
  readonly dirty: boolean
  /** Whether the user edited the draft since it last matched the Host. */
  readonly touched: boolean
  /** Whether one atomic write is in flight. */
  readonly saving: boolean
  /** Whether the single save control can run now. */
  readonly canSave: boolean
  /** Whether the draft can return to the Host's values. */
  readonly canDiscard: boolean
  /** The latest save outcome, absent while the form is clean. */
  readonly notice: GuardNotice | null
}

/** The fields in the order the form writes them (the page's group order). */
const FIELDS: readonly GuardField[] = [
  'failureEnabled',
  'failureLimit',
  'repeatEnabled',
  'repeatLimit',
  'resumeOnRepeat',
  'observeOnly',
  'fragmentObserveEnabled',
  ...EXPERIMENTAL_SWITCHES,
  'diagnosticsEnabled',
]

/**
 * One settings entry's staged form. Edits stay local until {@link save} submits
 * every changed field as ONE mutation carrying the revision the draft started
 * from; a refused or failed write keeps the draft so the person can retry.
 */
export class GuardConfigController {
  private readonly form: ConfigForm<GuardOptions>
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private snapshot: ConfigFormSnapshot<GuardOptions>
  private draft: GuardDraft
  private touched = false
  private saving = false
  private notice: GuardNotice | null = null
  /** Revision the current draft was read at; undefined means "latest at submit". */
  private editRevision: number | undefined
  private state: GuardConfigState
  private disposed = false
  private check: { config: Readonly<GuardOptions>; state: SelfCheckState } | null = null

  /** @param form - the Host-published form of this plugin's own settings entry. */
  constructor(form: ConfigForm<GuardOptions>) {
    this.form = form
    this.snapshot = form.getSnapshot()
    this.draft = toDraft(this.hostValues())
    this.editRevision = this.snapshot.revision
    this.state = this.project()
    this.unsubscribe = form.subscribe(() => { this.acceptSnapshot() })
  }

  /** @returns the current render snapshot; stable until the next change. */
  readonly getState = (): GuardConfigState => this.state

  /**
   * Observe render snapshot replacements.
   * @param listener - invoked after each replacement.
   * @returns the disposer removing this listener.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Stage one field edit. Edits are ignored while loading, read-only, or while
   * a write is in flight, so the submitted values cannot move underneath it.
   * @param field - the edited field.
   * @param value - the new boolean or decimal text.
   */
  edit(field: GuardSwitchField, value: boolean): void
  edit(field: GuardNumberField, value: string): void
  edit(field: GuardField, value: string | boolean): void {
    if (this.disposed || this.saving) return
    if (this.snapshot.status !== 'ready' || !this.snapshot.writable) return
    if (!this.touched || this.editRevision === undefined) {
      this.touched = true
      this.editRevision = this.snapshot.revision
    }
    if (isSwitchField(field)) {
      if (typeof value !== 'boolean') return
      this.draft = { ...this.draft, [field]: value }
    } else {
      if (typeof value !== 'string') return
      this.draft = { ...this.draft, [field]: value }
    }
    this.notice = null
    this.publish()
  }

  /**
   * Submit every changed field as one atomic mutation. A Host refusal (for
   * example a stale revision) keeps the draft and arms an explicit retry that
   * uses the latest Host revision; a transport failure does the same. Repeated
   * calls while a write is in flight return false without writing again.
   * @returns whether the Host accepted the mutation.
   */
  async save(): Promise<boolean> {
    if (this.disposed || this.saving) return false
    if (this.snapshot.status !== 'ready' || !this.snapshot.writable) return false
    const failure = noticeFor(this.draft.failureEnabled, this.draft.failureLimit, LIMITS.failureLimit)
    const repeat = noticeFor(this.draft.repeatEnabled, this.draft.repeatLimit, LIMITS.repeatLimit)
    if (failure.invalid || repeat.invalid) {
      this.notice = { kind: 'invalid', text: '请先修正标红的字段。' }
      this.publish()
      return false
    }
    const ops = this.pendingOps()
    if (ops.length === 0) return false
    this.saving = true
    this.notice = null
    this.publish()
    const expected = this.editRevision
    try {
      const accepted = await this.form.mutate(ops, expected)
      if (this.disposed) return false
      if (accepted) {
        this.saving = false
        this.snapshot = this.form.getSnapshot()
        this.touched = false
        this.draft = toDraft(this.hostValues())
        this.editRevision = this.snapshot.revision
        this.notice = { kind: 'saved', text: '已保存。' }
        this.publish()
        return true
      }
      this.saving = false
      // The Host recovered the current values; the next attempt must fence on
      // them (undefined lets the shared form supply its latest revision).
      this.editRevision = undefined
      this.snapshot = this.form.getSnapshot()
      this.notice = {
        kind: 'conflict',
        text: '保存被拒绝：配置可能已在别处更新。草稿已保留，重试会基于最新版本保存。',
      }
      this.publish()
      return false
    } catch (error) {
      if (this.disposed) return false
      this.saving = false
      this.editRevision = undefined
      this.snapshot = this.form.getSnapshot()
      this.notice = {
        kind: 'error',
        text: `保存失败：${describeError(error)}。草稿已保留，可重试。`,
      }
      this.publish()
      return false
    }
  }

  /** Simulate a bounded fixture using the last saved Host configuration only. */
  async selfCheck(): Promise<void> {
    const config = this.state.effective
    if (this.disposed || this.saving || !config || this.state.selfCheck?.kind === 'running') return
    const job = { config, state: { kind: 'running' } as SelfCheckState }
    this.check = job
    this.publish()
    try {
      const results = await runSelfCheck(config)
      job.state = { kind: 'result', results }
    } catch {
      job.state = { kind: 'error' }
    }
    if (!this.disposed && this.check === job) this.publish()
  }

  /** Return the draft to the Host's accepted values. */
  discard(): void {
    if (this.disposed || this.saving || !this.touched) return
    this.touched = false
    this.draft = toDraft(this.hostValues())
    this.editRevision = this.snapshot.revision
    this.notice = null
    this.publish()
  }

  /** Release the Host form subscription. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.listeners.clear()
  }

  /** The Host's accepted section, with defaults and the experiments normalized. */
  private hostValues(): GuardOptionValues {
    return withExperiments(this.snapshot.value ?? { ...DEFAULTS })
  }

  /**
   * A changed section as the write operations, in field order. A numeric field
   * whose guard is off never blocks the write: its invalid text falls back to
   * the Host's value instead of being submitted. Experimental switches are
   * compared like every other switch, so each one writes only its own field.
   */
  private pendingOps(): SettingsPathOpView[] {
    const host = this.hostValues()
    const ops: SettingsPathOpView[] = []
    for (const field of FIELDS) {
      const value = this.desired(field, host)
      if (value !== readField(host, field)) ops.push({ op: 'set', path: [field], value })
    }
    return ops
  }

  /** The draft's value for one field, with numeric text resolved for a write. */
  private desired(field: GuardField, host: GuardOptions): boolean | number {
    if (isSwitchField(field)) return this.draft[field]
    if (field === 'failureLimit') {
      return parseLimit(this.draft.failureLimit, LIMITS.failureLimit)
        ?? clampLimit(host.failureLimit, LIMITS.failureLimit)
    }
    return parseLimit(this.draft.repeatLimit, LIMITS.repeatLimit)
      ?? clampLimit(host.repeatLimit, LIMITS.repeatLimit)
  }

  private project(): GuardConfigState {
    const failure = noticeFor(this.draft.failureEnabled, this.draft.failureLimit, LIMITS.failureLimit)
    const repeat = noticeFor(this.draft.repeatEnabled, this.draft.repeatLimit, LIMITS.repeatLimit)
    const ready = this.snapshot.status === 'ready'
    const writable = ready && this.snapshot.writable
    const dirty = this.pendingOps().length > 0
    const invalid = failure.invalid || repeat.invalid
    const effective = ready && this.snapshot.value ? withExperiments({ ...DEFAULTS, ...this.snapshot.value }) : null
    const check = this.check
    if (check && (!effective || FIELDS.some(field => readField(check.config, field) !== readField(effective, field)))) this.check = null
    return {
      selfCheck: this.check?.state ?? null,
      status: this.snapshot.status,
      writable,
      effective,
      draft: this.draft,
      failureLimit: failure,
      repeatLimit: repeat,
      dirty,
      touched: this.touched,
      saving: this.saving,
      canSave: ready && writable && !this.saving && dirty && !invalid,
      canDiscard: ready && !this.saving && this.touched,
      notice: this.notice,
    }
  }

  /** Fold a Host snapshot change without discarding an in-progress draft. */
  private acceptSnapshot(): void {
    if (this.disposed) return
    this.snapshot = this.form.getSnapshot()
    if (!this.touched && !this.saving) {
      this.draft = toDraft(this.hostValues())
      this.editRevision = this.snapshot.revision
    }
    this.publish()
  }

  private publish(): void {
    this.state = this.project()
    for (const listener of [...this.listeners]) listener()
  }
}

/** Whether one numeric draft is acceptable only while its guard is enabled. */
function noticeFor(enabled: boolean, text: string, range: LimitRange): GuardFieldNotice {
  if (!enabled) return { invalid: false, message: null }
  if (parseLimit(text, range) !== undefined) return { invalid: false, message: null }
  return { invalid: true, message: `请输入 ${range.min}–${range.max} 的整数。` }
}

/** Parse a closed-range integer from decimal text; undefined when unacceptable. */
function parseLimit(text: string, range: LimitRange): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value < range.min || value > range.max) return undefined
  return value
}

/** Keep a Host number inside the field's range for comparisons and fallbacks. */
function clampLimit(value: number, range: LimitRange): number {
  if (!Number.isFinite(value)) return range.min
  return Math.min(range.max, Math.max(range.min, Math.round(value)))
}

/** Render a Host value or the fallback as editable decimal text. */
function numberText(value: unknown, fallback: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : String(fallback)
}

/** Coerce the Host section into a complete editable draft. */
function toDraft(value: GuardOptionValues): GuardDraft {
  return {
    failureEnabled: typeof value.failureEnabled === 'boolean' ? value.failureEnabled : DEFAULTS.failureEnabled,
    failureLimit: numberText(value.failureLimit, DEFAULTS.failureLimit),
    repeatEnabled: typeof value.repeatEnabled === 'boolean' ? value.repeatEnabled : DEFAULTS.repeatEnabled,
    repeatLimit: numberText(value.repeatLimit, DEFAULTS.repeatLimit),
    resumeOnRepeat: typeof value.resumeOnRepeat === 'boolean' ? value.resumeOnRepeat : DEFAULTS.resumeOnRepeat,
    diagnosticsEnabled: value.diagnosticsEnabled === true,
    fragmentObserveEnabled: value.fragmentObserveEnabled === true,
    fuzzyObserveEnabled: value.fuzzyObserveEnabled === true,
    crossTurnObserveEnabled: value.crossTurnObserveEnabled === true,
    activeSteerEnabled: value.activeSteerEnabled === true,
    stopSimulationEnabled: value.stopSimulationEnabled === true,
    observeOnly: typeof value.observeOnly === 'boolean' ? value.observeOnly : DEFAULTS.observeOnly,
  }
}

/**
 * Whether a field is one of the boolean switches. The set is the same
 * compile-checked map that proves every switch has a row on the page.
 * @param field - any editable field.
 * @returns true for a switch, false for a numeric limit.
 */
function isSwitchField(field: GuardField): field is GuardSwitchField {
  return field in SWITCH_FIELDS
}

/**
 * One switch's value from a Host section. A key the options module has not
 * declared yet is simply off, so an older accepted section reads as defaults.
 * @param value - the Host section or the effective view.
 * @param field - the switch to read.
 * @returns whether the switch is on.
 */
function switchOf(value: Readonly<GuardOptions>, field: GuardSwitchField): boolean {
  const switches: Partial<Record<GuardSwitchField, unknown>> = value
  return switches[field] === true
}

/**
 * The comparable value of one field: a number for a limit, a boolean for a switch.
 * @param value - the Host section or the effective view.
 * @param field - the field to read.
 */
function readField(value: Readonly<GuardOptions>, field: GuardField): boolean | number {
  return isSwitchField(field) ? switchOf(value, field) : value[field]
}

/**
 * Normalize a Host section into the view the page renders: the accepted options
 * plus the four experimental switches, absent keys reading as off.
 * @param value - the section the Host accepted (or the defaults).
 * @returns the same section with every experimental flag present.
 */
function withExperiments(value: GuardOptions): GuardOptionValues {
  return {
    ...value,
    fuzzyObserveEnabled: switchOf(value, 'fuzzyObserveEnabled'),
    crossTurnObserveEnabled: switchOf(value, 'crossTurnObserveEnabled'),
    activeSteerEnabled: switchOf(value, 'activeSteerEnabled'),
    stopSimulationEnabled: switchOf(value, 'stopSimulationEnabled'),
  }
}

/** A readable transport error for the footer. */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message
  const text = String(error)
  return text === '' ? '未知错误' : text
}
