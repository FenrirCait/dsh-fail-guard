/**
 * The plugin's only configuration surface: one form on the bundle's page in
 * the Plugins panel, registered under this package's name. The Host publishes
 * the settings entry this form edits; the page renders the staged draft and
 * submits every changed field with one atomic write.
 */

import { useId, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: adds ctx.slots (ui-renderer), ctx.configForms (ui-settings), and
// the plugins.bundle.config SlotMap key (ui-plugin-manager) to this module.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { ENTRY_ID, PACKAGE_NAME, LIMITS, type GuardOptions } from '../options'
import { GuardActivityTail, TURN_TAIL_SLOT } from './activity-tail'
import { GuardConfigController, type GuardConfigState } from './config-controller'
import { GuardStatus, GuardSelfCheck } from './guard-status'
import { installDiagnosticReader } from './diagnostic-remote'
export * from './diagnostic-panel'

/** Re-exported for the built-bundle tests; the page itself never calls them. */
export { GuardActivityTail, TURN_TAIL_SLOT } from './activity-tail'
export { summarizeActivity } from './activity-summary'

/** The one slot this plugin contributes to: its own bundle's configuration. */
export const BUNDLE_CONFIG_SLOT = 'plugins.bundle.config'

/** Services the form needs: the slot registry and the shared settings forms. */
export const inject: string[] = ['slots', 'configForms']

/** The face the registration injects into {@link ConfigForm}. */
export interface GuardConfigFace {
  readonly controller: GuardConfigController
}

/** Props the renderer binds: the bundle page's owner props plus this form. */
export type ConfigFormProps = PluginConfigViewProps & GuardConfigFace

/**
 * Contribute the bundle configuration page while the Plugins page is mounted.
 * The key is the bundle's npm package name; the settings entry is this
 * plugin's own Cordis row, whose id is not the package name.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const controller = new GuardConfigController(ctx.configForms.get<GuardOptions>(ENTRY_ID))
  ctx.effect(() => () => { controller.dispose() }, 'dsh-fail-guard: configuration draft')
  ctx.effect(() => ctx.slots.inject(BUNDLE_CONFIG_SLOT, () => ctx.slots.register({
    name: BUNDLE_CONFIG_SLOT,
    key: PACKAGE_NAME,
    inject: () => ({ controller }),
  }, ConfigForm)), 'dsh-fail-guard: bundle configuration page')
  // A list entry under every completed Turn; it reads only the activity
  // projection, so a Host without that projection renders nothing.
  const readDiagnostic = installDiagnosticReader(ctx)
  const activitySlots = ctx.slots as unknown as ActivitySlotFace
  ctx.effect(() => activitySlots.inject(TURN_TAIL_SLOT, () => activitySlots.register({
    name: TURN_TAIL_SLOT,
    id: PACKAGE_NAME,
    inject: sessionId => ({ reportForTurn: (turn: number) => readDiagnostic(sessionId, turn) }),
  }, GuardActivityTail)), 'dsh-fail-guard: turn activity summary')
}

/** The two slot operations the activity entry uses, typed without ui-chat. */
interface ActivitySlotFace {
  inject(key: string, callback: () => () => void): () => void
  register(options: { name: string; id: string; inject: (sessionId: string) => object }, component: typeof GuardActivityTail): () => void
}

/**
 * Render the six guard settings, one save control, and the save outcome.
 * @param props - the requested view and the injected form controller.
 * @returns nothing for a summary view, a loading/read-only note, or the form.
 */
export function ConfigForm(props: ConfigFormProps) {
  const state = useSyncExternalStore(
    props.controller.subscribe,
    props.controller.getState,
    props.controller.getState,
  )
  const uid = useId()
  const titleId = `${uid}-title`
  const failureEnabledId = `${uid}-failure-enabled`
  const failureLimitId = `${uid}-failure-limit`
  const failureErrorId = `${uid}-failure-limit-error`
  const repeatEnabledId = `${uid}-repeat-enabled`
  const repeatLimitId = `${uid}-repeat-limit`
  const repeatErrorId = `${uid}-repeat-limit-error`
  const resumeOnRepeatId = `${uid}-resume-on-repeat`
  const observeOnlyId = `${uid}-observe-only`
  if (props.view === 'summary') return null
  if (state.status === 'loading') {
    return (
      <div className="dfg-root" aria-busy="true">
        <style>{STYLES}</style>
        <p className="dfg-note">正在读取配置…</p>
      </div>
    )
  }
  if (state.status === 'unavailable') {
    return (
      <div className="dfg-root">
        <style>{STYLES}</style>
        <p className="dfg-note">当前环境未提供这项配置。</p>
      </div>
    )
  }
  return (
    <div className="dfg-root">
      <style>{STYLES}</style>
      <header className="dfg-intro">
        <h4 id={titleId}>失败与复读防护</h4>
        <p>改动先作为草稿，保存成功后才生效。</p>
      </header>
      <GuardStatus state={state} />
      <form
        className="dfg-form"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault()
          void props.controller.save()
        }}
      >
        <fieldset className="dfg-group" disabled={!state.writable || state.saving}>
          <legend className="dfg-legend">连续失败</legend>
          <p className="dfg-group-hint">
            {state.draft.observeOnly
              ? '达到上限时只记录，不提示，也不会中断本轮。'
              : '达到上限时提示停手；提示只是建议，不会强制中断本轮。'}
          </p>
          <SwitchRow
            id={failureEnabledId}
            label="启用连续失败防护"
            checked={state.draft.failureEnabled}
            disabled={!state.writable || state.saving}
            onChange={(checked) => { props.controller.edit('failureEnabled', checked) }}
          />
          <div className="dfg-row">
            <label className="dfg-label" htmlFor={failureLimitId}>
              <span>连续失败上限</span>
              <span className="dfg-hint">
                同一工具连续失败 {LIMITS.failureLimit.min}–{LIMITS.failureLimit.max} 次后{state.draft.observeOnly ? '记录。' : '提示。'}
              </span>
            </label>
            <input
              id={failureLimitId}
              className="dfg-number"
              type="number"
              inputMode="numeric"
              min={LIMITS.failureLimit.min}
              max={LIMITS.failureLimit.max}
              step={1}
              value={state.draft.failureLimit}
              disabled={!state.writable || state.saving || !state.draft.failureEnabled}
              aria-invalid={state.failureLimit.invalid}
              aria-describedby={state.failureLimit.invalid ? failureErrorId : undefined}
              onChange={(event) => { props.controller.edit('failureLimit', event.currentTarget.value) }}
            />
          </div>
          {state.failureLimit.message === null ? null : (
            <p className="dfg-error" id={failureErrorId}>{state.failureLimit.message}</p>
          )}
        </fieldset>
        <fieldset className="dfg-group" disabled={!state.writable || state.saving}>
          <legend className="dfg-legend">复读</legend>
          <p className="dfg-group-hint">
            {state.draft.observeOnly
              ? '同一块思考连续出现相同短行时只记录，不截断。'
              : '同一块思考连续出现相同短行时截断本轮输出。'}
          </p>
          <SwitchRow
            id={repeatEnabledId}
            label="启用复读防护"
            checked={state.draft.repeatEnabled}
            disabled={!state.writable || state.saving}
            onChange={(checked) => { props.controller.edit('repeatEnabled', checked) }}
          />
          <div className="dfg-row">
            <label className="dfg-label" htmlFor={repeatLimitId}>
              <span>连续相同短行上限</span>
              <span className="dfg-hint">
                连续相同短行达到 {LIMITS.repeatLimit.min}–{LIMITS.repeatLimit.max} 行时{state.draft.observeOnly ? '记录。' : '截断。'}
              </span>
            </label>
            <input
              id={repeatLimitId}
              className="dfg-number"
              type="number"
              inputMode="numeric"
              min={LIMITS.repeatLimit.min}
              max={LIMITS.repeatLimit.max}
              step={1}
              value={state.draft.repeatLimit}
              disabled={!state.writable || state.saving || !state.draft.repeatEnabled}
              aria-invalid={state.repeatLimit.invalid}
              aria-describedby={state.repeatLimit.invalid ? repeatErrorId : undefined}
              onChange={(event) => { props.controller.edit('repeatLimit', event.currentTarget.value) }}
            />
          </div>
          {state.repeatLimit.message === null ? null : (
            <p className="dfg-error" id={repeatErrorId}>{state.repeatLimit.message}</p>
          )}
          <SwitchRow
            id={resumeOnRepeatId}
            label="复读后自动续跑"
            hint={state.draft.observeOnly
              ? '观察模式不续跑；关闭观察后每轮最多续跑一次。'
              : '每轮最多续跑一次；仅复读防护开启时生效。'}
            checked={state.draft.resumeOnRepeat}
            disabled={!state.writable || state.saving || !state.draft.repeatEnabled || state.draft.observeOnly}
            onChange={(checked) => { props.controller.edit('resumeOnRepeat', checked) }}
          />
        </fieldset>
        <fieldset className="dfg-group" disabled={!state.writable || state.saving}>
          <legend className="dfg-legend">观察模式</legend>
          <p className="dfg-group-hint">只记录命中，不提示、不截断、不续跑。适合先确认真实会话里规则是否误判。</p>
          <SwitchRow
            id={observeOnlyId}
            label="启用观察模式"
            checked={state.draft.observeOnly}
            disabled={!state.writable || state.saving}
            onChange={(checked) => { props.controller.edit('observeOnly', checked) }}
          />
        </fieldset>
        <fieldset className="dfg-group" disabled={!state.writable || state.saving}>
          <legend className="dfg-legend">实验功能</legend>
          <p className="dfg-group-hint">实验逐项开启，不会自动分享反馈。观察类开关只记录命中，不改变模型输出。可在会话回合末的「防护诊断」标记反馈。</p>
          <SwitchRow
            id={uid + '-fragment-observe'}
            label="观察短碎片复读（实验）"
            hint="默认关闭。开启后仅在回合末显示计数，不提示模型、不截断、不续跑，不保存思考原文。"
            checked={state.draft.fragmentObserveEnabled}
            disabled={!state.writable || state.saving}
            onChange={checked => props.controller.edit('fragmentObserveEnabled', checked)}
          />
          <SwitchRow
            id={uid + '-fuzzy-observe'}
            label="观察模糊复读（实验）"
            hint="默认关闭。整行相近但不完全相同的复读只在回合末计数，不提示模型、不截断、不续跑，也不保存思考原文。"
            checked={state.draft.fuzzyObserveEnabled}
            disabled={!state.writable || state.saving}
            onChange={checked => props.controller.edit('fuzzyObserveEnabled', checked)}
          />
          <SwitchRow
            id={uid + '-cross-turn-observe'}
            label="观察跨轮重复操作（实验）"
            hint="默认关闭。相邻回合重复同一操作（同一工具、同一参数）只在回合末计数，不提示模型、不拦截工具调用。"
            checked={state.draft.crossTurnObserveEnabled}
            disabled={!state.writable || state.saving}
            onChange={checked => props.controller.edit('crossTurnObserveEnabled', checked)}
          />
          <SwitchRow
            id={uid + '-active-steer'}
            label="复读截断后主动引导（实验）"
            hint="默认关闭。只在现有精确复读已截断的回合收尾发送一次引导，每轮最多一次；与「复读后自动续跑」互斥（续跑生效时不发送），观察模式下不发送。"
            checked={state.draft.activeSteerEnabled}
            disabled={!state.writable || state.saving || state.draft.observeOnly}
            onChange={checked => props.controller.edit('activeSteerEnabled', checked)}
          />
          <SwitchRow
            id={uid + '-stop-simulation'}
            label="记录模拟停手（实验）"
            hint="默认关闭。命中时只生成一条模拟停手记录，不会取消本轮、不会取消工具调用。"
            checked={state.draft.stopSimulationEnabled}
            disabled={!state.writable || state.saving}
            onChange={checked => props.controller.edit('stopSimulationEnabled', checked)}
          />
        </fieldset>
        <fieldset className="dfg-group" disabled={!state.writable || state.saving}>
          <legend className="dfg-legend">复读诊断</legend>
          <SwitchRow
            id={uid + '-diagnostics'}
            label="本地记录复读诊断"
            hint="默认关闭。命中时仅保留结构和处置，不记录原文，不上传。最多 20 份，7 天后清理。"
            checked={state.draft.diagnosticsEnabled}
            disabled={!state.writable || state.saving}
            onChange={checked => props.controller.edit('diagnosticsEnabled', checked)}
          />
        </fieldset>
        <footer className="dfg-footer">
          <p className={noticeClass(state)} role="status" aria-live="polite">{statusText(state)}</p>
          <div className="dfg-actions">
            <button
              type="button"
              className="dfg-button"
              disabled={!state.canDiscard}
              onClick={() => { props.controller.discard() }}
            >
              撤销修改
            </button>
            <button
              type="submit"
              className="dfg-button dfg-primary"
              disabled={!state.canSave}
              aria-busy={state.saving}
            >
              {saveLabel(state)}
            </button>
          </div>
        </footer>
      </form>
      <GuardSelfCheck state={state} run={() => { void props.controller.selfCheck() }} />
    </div>
  )
}

/** One labelled boolean row with an optional explanation. */
function SwitchRow(props: {
  readonly id: string
  readonly label: string
  readonly hint?: string
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (checked: boolean) => void
}) {
  const hintId = `${props.id}-hint`
  return (
    <div className="dfg-row">
      <div className="dfg-label">
        <label htmlFor={props.id}>{props.label}</label>
        {props.hint === undefined ? null : <span className="dfg-hint" id={hintId}>{props.hint}</span>}
      </div>
      <span className="dfg-switch-control">
        <input
          id={props.id}
          className="dfg-switch"
          type="checkbox"
          role="switch"
          checked={props.checked}
          disabled={props.disabled}
          aria-describedby={props.hint === undefined ? undefined : hintId}
          onChange={(event) => { props.onChange(event.currentTarget.checked) }}
        />
        <span className="dfg-switch-track" aria-hidden="true" />
      </span>
    </div>
  )
}

/** The footer's message: the latest outcome, the dirty hint, or read-only. */
function statusText(state: GuardConfigState): string {
  if (!state.writable) return '只读：当前配置不接受写入。'
  if (state.notice !== null) return state.notice.text
  if (state.saving) return '正在保存…'
  if (state.dirty) return '有未保存的修改。'
  return ''
}

/** Map the status line to its tone. */
function noticeClass(state: GuardConfigState): string {
  if (!state.writable) return 'dfg-status dfg-status-readonly'
  const kind = state.notice?.kind
  if (kind === 'saved') return 'dfg-status dfg-status-saved'
  if (kind === 'conflict' || kind === 'error' || kind === 'invalid') return 'dfg-status dfg-status-error'
  return 'dfg-status'
}

/** The save control names the recovery action after a refusal or failure. */
function saveLabel(state: GuardConfigState): string {
  if (state.saving) return '保存中…'
  const kind = state.notice?.kind
  if (kind === 'conflict' || kind === 'error') return '重试保存'
  return '保存'
}

/** Scoped styles; host tokens carry the theme, the fallbacks keep it legible. */
const STYLES = `
.dfg-root {
  --dfg-action-bg: var(--dsw-alias-label-primary, CanvasText);
  --dfg-action-fg: var(--dsw-alias-bg-module-platform, Canvas);
  display: flex;
  flex-direction: column;
  gap: 18px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--dsw-alias-label-primary, #1f2329);
}
.dfg-intro h4 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
.dfg-intro p { margin: 0; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 12px; }
.dfg-form { display: flex; flex-direction: column; gap: 18px; }
.dfg-mode { display: grid; gap: 6px; padding: 10px 12px; border-inline-start: 2px solid var(--dsw-alias-border-l3, #9ca3af); }
.dfg-mode p, .dfg-check p { margin: 0; overflow-wrap: anywhere; }
.dfg-mode strong { margin-inline-end: 8px; }
.dfg-check { display: grid; gap: 8px; padding-block: 12px; border-block-start: 1px solid var(--dsw-alias-border-l2, #d1d5db); }
.dfg-check-header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.dfg-check-header h5 { margin: 0; font-size: inherit; }
.dfg-check-results { margin: 0; padding-inline-start: 18px; }
.dfg-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 14px 16px 16px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.24));
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.04));
}
.dfg-legend { padding: 0 6px; font-size: 13px; font-weight: 600; }
.dfg-group-hint { margin: 0; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 12px; }
.dfg-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.dfg-label { display: flex; flex: 1 1 240px; flex-direction: column; gap: 2px; min-width: 0; }
.dfg-label label { font-weight: 500; }
.dfg-hint { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 12px; }
.dfg-switch-control {
  --dfg-switch-accent: var(--dfg-action-bg);
  --dfg-switch-off: var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.36));
  position: relative;
  display: grid;
  place-items: center;
  flex: 0 0 54px;
  min-height: 32px;
}
.dfg-switch {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.dfg-switch-track {
  display: block;
  position: relative;
  width: 54px;
  height: 30px;
  box-sizing: border-box;
  border: 1px solid transparent;
  border-radius: 999px;
  background-color: var(--dfg-switch-off);
  pointer-events: none;
  transition: background-color 160ms ease-out;
}
.dfg-switch-track::before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background-color: #fff;
  transition: transform 160ms ease-out;
}
.dfg-switch:checked + .dfg-switch-track { background-color: var(--dfg-switch-accent); }
.dfg-switch:checked + .dfg-switch-track::before { transform: translateX(24px); background-color: var(--dfg-action-fg); }
.dfg-switch:focus-visible + .dfg-switch-track { outline: 2px solid var(--dfg-switch-accent); outline-offset: 2px; }
.dfg-switch:disabled { cursor: not-allowed; }
.dfg-switch:disabled + .dfg-switch-track { opacity: 0.55; }
@media (prefers-reduced-motion: reduce) {
  .dfg-switch-track, .dfg-switch-track::before { transition: none; }
}
@media (forced-colors: active) {
  .dfg-switch-track { forced-color-adjust: none; background-color: Canvas; border-color: ButtonText; }
  .dfg-switch-track::before { background-color: ButtonText; }
  .dfg-switch:checked + .dfg-switch-track { background-color: Highlight; }
  .dfg-switch:checked + .dfg-switch-track::before { background-color: HighlightText; }
  .dfg-switch:focus-visible + .dfg-switch-track { outline-color: Highlight; }
  .dfg-switch:disabled + .dfg-switch-track { opacity: 1; border-color: GrayText; background-color: Canvas; }
  .dfg-switch:disabled + .dfg-switch-track::before { background-color: GrayText; }
}
.dfg-number {
  width: 88px;
  padding: 5px 8px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.4));
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-module-platform, #fff);
  color: inherit;
  font: inherit;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.dfg-number:disabled { opacity: 0.55; }
.dfg-number[aria-invalid='true'] { border-color: var(--dsw-alias-state-error-primary, #d92d20); }
.dfg-error { margin: -4px 0 0; color: var(--dsw-alias-state-error-primary, #d92d20); font-size: 12px; }
.dfg-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.dfg-status { flex: 1 1 240px; margin: 0; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 12px; }
.dfg-status-saved { color: var(--dsw-alias-state-success-primary, #067647); }
.dfg-status-error { color: var(--dsw-alias-state-error-primary, #d92d20); }
.dfg-status-readonly { color: var(--dsw-alias-label-tertiary, #6b7280); }
.dfg-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.dfg-button {
  min-height: 32px;
  padding: 0 14px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.4));
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.dfg-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }
.dfg-button:disabled { opacity: 0.45; cursor: not-allowed; }
.dfg-primary {
  border-color: transparent;
  background: var(--dfg-action-bg);
  color: var(--dfg-action-fg);
}
.dfg-primary:hover:not(:disabled) { background: var(--dfg-action-bg); text-decoration: underline; }
.dfg-primary:disabled {
  opacity: 1;
  border-color: var(--dsw-alias-border-l3, GrayText);
  background: transparent;
  color: var(--dfg-action-bg);
}
.dfg-root :focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe);
  outline-offset: 2px;
}
.dfg-note { margin: 0; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 12px; }
@media (prefers-reduced-motion: no-preference) {
  .dfg-button { transition: background-color 160ms cubic-bezier(.2, .8, .2, 1), filter 160ms cubic-bezier(.2, .8, .2, 1); }
}
`
