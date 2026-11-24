/**
 * The guard diagnostic shown for one completed Turn: a compact summary of the
 * automatic record, an exact preview of the JSON this panel would save, and an
 * optional note the user types themselves. The component reads nothing beyond
 * the report it is handed, keeps no draft outside React state, and writes a file
 * only when the download control is pressed. Nothing here contacts the network
 * or copies conversation content into the payload.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import type { DiagnosticReport } from '../diagnostic-shared.js'
import type { GuardHit } from '../activity-shared.js'
import type { FeedbackDocument } from './feedback.js'
import { FeedbackPanel } from './feedback-panel.js'

/** The note ceiling, matching the textarea's own length limit. */
export const DIAGNOSTIC_NOTE_LIMIT = 500

/** Where the panel stands with the automatic record. */
export type DiagnosticLoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly report: DiagnosticReport }
  | { readonly status: 'empty' }
  | { readonly status: 'failed'; readonly reason: string }

/** The automatic record as saved: the shared payload plus the note, if any. */
export type DiagnosticAutomaticExport = Omit<DiagnosticReport, 'trace' | 'hostVersion' | 'pluginVersion'> & Partial<Pick<DiagnosticReport, 'trace' | 'hostVersion' | 'pluginVersion'>> & { readonly note?: string }

/**
 * A manual report: the note the user wrote and the build that wrote it. It
 * carries no counters, trace, or environment fields, so it cannot be mistaken
 * for an automatic record.
 */
export interface DiagnosticManualExport {
  readonly version: 1
  readonly kind: 'manual'
  readonly pluginVersion: string
  readonly note?: string
}

/** Either payload the download control can write. */
export type DiagnosticExportDocument = DiagnosticAutomaticExport | DiagnosticManualExport

/** One labelled fact shown above the preview. */
export interface DiagnosticPanelRow {
  readonly label: string
  readonly value: string
}

/** The one-line state message and its tone. */
export interface DiagnosticPanelMessage {
  readonly tone: 'info' | 'warn' | 'error'
  readonly text: string
}

/** Where the loader control stands: absent, ready, retrying, or in flight. */
export type DiagnosticLoaderState = 'none' | 'ready-to-load' | 'retry' | 'loading'

/** Everything the pure view needs, derived from the load state and the note. */
export interface DiagnosticPanelModel {
  readonly phase: DiagnosticLoadState['status']
  readonly source: 'automatic' | 'manual'
  readonly report: DiagnosticReport | null
  readonly note: string
  readonly noteLimit: number
  readonly noteCount: number
  readonly previewText: string
  readonly exportDocument: DiagnosticExportDocument
  readonly fileName: string
  readonly message: DiagnosticPanelMessage
  readonly rows: readonly DiagnosticPanelRow[]
  readonly structure: string
  readonly summaryText: string
  readonly loader: DiagnosticLoaderState
  readonly showManualEntry: boolean
  readonly noteHint: string
  readonly downloadHint: string
  readonly manualHint: string | null
}

/** Inputs of the pure derivation; the view renders its result verbatim. */
export interface DiagnosticPanelInput {
  readonly hasLoader: boolean
  readonly state: DiagnosticLoadState
  readonly note: string
  readonly pluginVersion?: string
  /** Fixed only so tests can pin the generated file name. */
  readonly at?: Date
  readonly includeVersions?: boolean
  readonly includeStructure?: boolean
}

/** The outcome of asking the report to be written as a local file. */
export interface DiagnosticExportOutcome {
  readonly ok: boolean
  readonly fileName: string
  readonly text: string
  readonly reason: 'unavailable' | 'failed' | null
}

/** Replacement for the browser save step; tests pass a sink. */
export interface DiagnosticDownloadPorts {
  readonly save?: (text: string, fileName: string) => boolean | void
}

const MODES: ReadonlySet<string> = new Set(['observe', 'enforce'])
const ACTIONS: ReadonlySet<string> = new Set(['observed', 'cut', 'resumed'])
const EVENT_KINDS: ReadonlySet<string> = new Set(['start', 'end', 'delta'])

const MODE_TEXT: Record<DiagnosticReport['mode'], string> = {
  observe: '观察模式',
  enforce: '执行模式',
}
const ACTION_TEXT: Record<DiagnosticReport['action'], string> = {
  observed: '只记录',
  cut: '已截断本轮',
  resumed: '截断后已续跑',
}
const ACTION_SENTENCE: Record<DiagnosticReport['action'], string> = {
  observed: '只做了记录',
  cut: '已截断本轮输出',
  resumed: '截断后已续跑一轮',
}

/** True for a plain object (an array, null, or a primitive is not one). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True for a non-negative integer count. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Read a version label, falling back to a visible placeholder. */
function normalizeVersion(value: string | undefined): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' ? 'unknown' : text
}

/** True for the control characters that never belong in a short note. */
function isControlCharacter(codePoint: number): boolean {
  return codePoint <= 8 || codePoint === 11 || codePoint === 12 ||
    (codePoint >= 14 && codePoint <= 31) || codePoint === 127
}

/** Drop control characters, keeping newlines and ordinary text. */
function stripControl(value: string): string {
  let result = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (!isControlCharacter(codePoint)) result += character
  }
  return result
}

/** Use one newline style so the preview is stable across platforms. */
function normalizeNewlines(value: string): string {
  return value.split('\r\n').join('\n').split('\r').join('\n')
}

/**
 * Copy a report into a canonical object: known fields only, arrays duplicated,
 * so neither the preview nor the saved file can drift from later mutation.
 * @param report - the report to copy.
 * @returns the canonical copy.
 */
export function copyDiagnosticReport(report: DiagnosticReport): DiagnosticReport {
  return {
    version: 1,
    kind: 'automatic',
    pluginVersion: report.pluginVersion,
    hostVersion: report.hostVersion,
    threshold: report.threshold,
    mode: report.mode,
    count: report.count,
    action: report.action,
    trace: {
      events: report.trace.events.map((event) => ({ kind: event.kind, block: event.block })),
      groups: [...report.trace.groups],
    },
  }
}

/**
 * Validate a value handed over by the loader. Unknown extra fields are dropped;
 * a structural mismatch is reported instead of guessed.
 * @param value - the value the loader produced.
 * @returns the canonical report, or a refusal.
 */
export function readDiagnosticReport(value: unknown):
  | { readonly ok: true; readonly report: DiagnosticReport }
  | { readonly ok: false } {
  if (!isRecord(value)) return { ok: false }
  if (value.version !== 1 || value.kind !== 'automatic') return { ok: false }
  if (typeof value.pluginVersion !== 'string') return { ok: false }
  if (value.hostVersion !== null && typeof value.hostVersion !== 'string') return { ok: false }
  if (!isCount(value.threshold) || !isCount(value.count)) return { ok: false }
  if (typeof value.mode !== 'string' || !MODES.has(value.mode)) return { ok: false }
  if (typeof value.action !== 'string' || !ACTIONS.has(value.action)) return { ok: false }
  const trace = value.trace
  if (!isRecord(trace)) return { ok: false }
  const events = trace.events
  const groups = trace.groups
  if (!Array.isArray(events) || !Array.isArray(groups)) return { ok: false }
  const copiedEvents: { kind: 'start' | 'end' | 'delta'; block: number }[] = []
  for (const event of events) {
    if (!isRecord(event)) return { ok: false }
    if (typeof event.kind !== 'string' || !EVENT_KINDS.has(event.kind)) return { ok: false }
    if (!isCount(event.block)) return { ok: false }
    copiedEvents.push({ kind: event.kind as 'start' | 'end' | 'delta', block: event.block })
  }
  const copiedGroups: number[] = []
  for (const group of groups) {
    if (!isCount(group)) return { ok: false }
    copiedGroups.push(group)
  }
  return {
    ok: true,
    report: {
      version: 1,
      kind: 'automatic',
      pluginVersion: value.pluginVersion,
      hostVersion: value.hostVersion,
      threshold: value.threshold,
      mode: value.mode as DiagnosticReport['mode'],
      count: value.count,
      action: value.action as DiagnosticReport['action'],
      trace: { events: copiedEvents, groups: copiedGroups },
    },
  }
}

/** Inputs of the manual document: the user's note and the writing build. */
export interface DiagnosticManualDocumentInput {
  readonly note: string
  readonly pluginVersion?: string
}

/**
 * Build the manual report. A missed detection has no automatic counters to
 * report, so this payload states its own kind and carries only the note and the
 * plugin build: no threshold, no trace, no environment fields.
 * @param input - the note and the plugin version label.
 * @returns the manual payload, with note present only when it is not empty.
 */
export function buildManualDocument(input: DiagnosticManualDocumentInput): DiagnosticManualExport {
  const text = sanitizeNote(input.note)
  const base: DiagnosticManualExport = {
    version: 1,
    kind: 'manual',
    pluginVersion: normalizeVersion(input.pluginVersion),
  }
  return text === '' ? base : { ...base, note: text }
}

/**
 * Normalize a user note: one newline style, no control characters, no outer
 * whitespace, at most the limit counted as characters rather than code units.
 * @param raw - what the textarea holds.
 * @param limit - the ceiling; defaults to DIAGNOSTIC_NOTE_LIMIT.
 * @returns the text that may be exported; an empty string means no note.
 */
export function sanitizeNote(raw: string, limit: number = DIAGNOSTIC_NOTE_LIMIT): string {
  const normalized = stripControl(normalizeNewlines(raw))
  const trimmed = normalized.trim()
  if (trimmed === '') return ''
  const characters = Array.from(trimmed)
  const capped = characters.length <= limit ? trimmed : characters.slice(0, Math.max(0, limit)).join('')
  return capped.trimEnd()
}

/**
 * Combine an automatic report and the note into the exact object that is saved.
 * @param report - the automatic record.
 * @param note - the raw textarea value; sanitized here.
 * @returns the payload, with the note present only when it is not empty.
 */
export function buildAutomaticDocument(report: DiagnosticReport, note: string): DiagnosticAutomaticExport {
  const base = copyDiagnosticReport(report)
  const text = sanitizeNote(note)
  return text === '' ? base : { ...base, note: text }
}

/** What the model hands the export: the record, if one exists, plus the note. */
export interface DiagnosticExportSource {
  readonly report: DiagnosticReport | null
  readonly note: string
  readonly pluginVersion?: string
}

/**
 * Choose the payload for the current state. A missing automatic record becomes
 * a manual document, never a zeroed automatic one.
 * @param input - record, note, and the plugin version label.
 * @returns the automatic or manual payload.
 */
export function buildExportDocument(input: DiagnosticExportSource): DiagnosticExportDocument {
  if (input.report === null) {
    return buildManualDocument({ note: input.note, pluginVersion: input.pluginVersion })
  }
  return buildAutomaticDocument(input.report, input.note)
}

/**
 * Serialize a payload exactly as the downloaded file holds it.
 * @param documentValue - the export payload.
 * @returns indented JSON with a trailing newline.
 */
export function serializeDiagnosticDocument(documentValue: DiagnosticExportDocument | FeedbackDocument): string {
  return JSON.stringify(documentValue, null, 2) + '\n'
}

/**
 * Name the download after the moment it was prepared, in UTC.
 * @param at - the timestamp to encode; defaults to now.
 * @returns a filesystem-safe JSON name.
 */
export function diagnosticFileName(at: Date = new Date()): string {
  let stampMs: number
  try { stampMs = Date.prototype.getTime.call(at) } catch { stampMs = NaN }
  const time = Number.isFinite(stampMs) ? new Date(stampMs) : new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = time.getUTCFullYear() + pad(time.getUTCMonth() + 1) + pad(time.getUTCDate()) +
    '-' + pad(time.getUTCHours()) + pad(time.getUTCMinutes()) + pad(time.getUTCSeconds())
  return 'dsh-fail-guard-diagnostic-' + stamp + '.json'
}

/** Write the text through a temporary object URL and a download link. */
function saveInBrowser(text: string, fileName: string): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  if (typeof Blob !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false
  const body = document.body
  if (body === null) return false
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = fileName
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => {
      try {
        URL.revokeObjectURL(href)
      } catch {
        // The file is already saved; a refused revoke leaks one URL until reload.
      }
    }, 0)
  }
  return true
}

/**
 * Write the payload to a local JSON file. Called only from the download control.
 * @param documentValue - the payload to save.
 * @param options - file name, timestamp, or a test port replacing the save step.
 * @returns what was written, and whether the environment allowed writing.
 */
export function exportDiagnosticDocument(
  documentValue: DiagnosticExportDocument | FeedbackDocument,
  options: { readonly at?: Date; readonly fileName?: string; readonly ports?: DiagnosticDownloadPorts } = {},
): DiagnosticExportOutcome {
  const text = serializeDiagnosticDocument(documentValue)
  const defaultName = () => {
    const name = diagnosticFileName(options.at)
    return documentValue.kind === 'feedback' ? name.replace('-diagnostic-', '-feedback-') : name
  }
  const fileName = options.fileName ?? defaultName()
  const save = options.ports?.save ?? saveInBrowser
  try {
    const result: unknown = save(text, fileName)
    const ok = result !== false
    return { ok, fileName, text, reason: ok ? null : 'unavailable' }
  } catch {
    return { ok: false, fileName, text, reason: 'failed' }
  }
}

/** Turn a load failure into a short, single-line explanation. */
export function describeLoadFailure(error: unknown): string {
  let raw = typeof error === 'string' ? error : ''
  if (error !== null && typeof error === 'object') {
    // Errors from a different JavaScript realm have a different constructor.
    try {
      const message: unknown = Reflect.get(error, 'message')
      if (typeof message === 'string') raw = message
    } catch { /* An unreadable message falls back to the generic label. */ }
  }
  const text = stripControl(raw).split('\n').map((line) => line.trim()).filter((line) => line !== '').join(' ').replace(/ {2,}/g, ' ')
  if (text === '') return '未知原因'
  return Array.from(text).slice(0, 160).join('')
}

/**
 * Start one load and report its terminal state once. The returned function
 * cancels the attempt: a late result then changes nothing.
 * @param load - the loader supplied by the caller.
 * @param sink - receives exactly one of ready, empty, or failed, unless cancelled.
 * @returns the cancel function.
 */
export function beginDiagnosticLoad(
  load: () => Promise<DiagnosticReport | null>,
  sink: (state: DiagnosticLoadState) => void,
): () => void {
  let cancelled = false
  const settle = (next: DiagnosticLoadState): void => {
    if (!cancelled) sink(next)
  }
  const accept = (value: unknown): void => {
    if (value === null || value === undefined) {
      settle({ status: 'empty' })
      return
    }
    const parsed = readDiagnosticReport(value)
    settle(parsed.ok ? { status: 'ready', report: parsed.report } : { status: 'failed', reason: '记录格式无法识别' })
  }
  let pending: Promise<DiagnosticReport | null>
  try {
    pending = Promise.resolve(load())
  } catch (error) {
    settle({ status: 'failed', reason: describeLoadFailure(error) })
    return () => {
      cancelled = true
    }
  }
  pending.then(accept, (error: unknown) => {
    settle({ status: 'failed', reason: describeLoadFailure(error) })
  })
  return () => {
    cancelled = true
  }
}

/** Describe the bounded repetition structure without dumping every event. */
function describeStructure(report: DiagnosticReport): string {
  const events = report.trace.events.length
  const groups = report.trace.groups
  if (events === 0 && groups.length === 0) return '结构：没有事件记录。'
  const shown = groups.slice(0, 8).join(', ')
  const more = groups.length > 8 ? ' 等 ' + groups.length + ' 组' : ''
  const groupText = groups.length === 0 ? '没有分组' : '组大小 ' + shown + more
  return '结构：' + events + ' 个事件 · ' + groups.length + ' 组（' + groupText + '）。'
}

/**
 * Derive everything the view shows from the load state and the note. Pure, so
 * the preview, the rows, and the saved payload cannot disagree.
 * @param input - load state, raw note, version labels, optional clock.
 * @returns the view model.
 */
export function deriveDiagnosticPanelModel(input: DiagnosticPanelInput): DiagnosticPanelModel {
  const state = input.state
  const report = state.status === 'ready' ? state.report : null
  const exportDocument = buildExportDocument({
    report,
    note: input.note,
    pluginVersion: input.pluginVersion,
  })
  if (exportDocument.kind === 'automatic') {
    if (input.includeVersions === false) {
      delete exportDocument.pluginVersion
      delete exportDocument.hostVersion
    }
    if (input.includeStructure === false) delete exportDocument.trace
  }
  const previewText = serializeDiagnosticDocument(exportDocument)
  const note = input.note
  const noteEmpty = sanitizeNote(note) === ''
  let message: DiagnosticPanelMessage
  let summaryText: string
  switch (state.status) {
    case 'loading':
      message = { tone: 'info', text: '正在读取本次回合的自动记录…' }
      summaryText = '正在读取…'
      break
    case 'ready':
      message = state.report.count > 0
        ? { tone: 'info', text: '本次回合命中 ' + state.report.count + ' 次：' + ACTION_SENTENCE[state.report.action] + '。' }
        : { tone: 'info', text: '本次回合没有命中，自动记录仍然可以导出。' }
      summaryText = state.report.count > 0
        ? '命中 ' + state.report.count + ' 次 · ' + ACTION_TEXT[state.report.action]
        : '无命中记录'
      break
    case 'empty':
      message = { tone: 'info', text: '本次回合没有自动记录：可以在下方填写备注，导出手动报告。' }
      summaryText = '无自动记录'
      break
    case 'failed':
      message = {
        tone: 'error',
        text: '读取本次记录失败（' + state.reason + '）。可以重试，或直接填写备注导出手动报告。',
      }
      summaryText = '读取失败'
      break
    default:
      message = { tone: 'info', text: '没有自动记录：下方填写的备注会作为手动报告导出。' }
      summaryText = '手动报告'
  }
  const loader: DiagnosticLoaderState = input.hasLoader
    ? state.status === 'loading'
      ? 'loading'
      : state.status === 'ready'
        ? 'none'
        : state.status === 'failed' || state.status === 'empty'
          ? 'retry'
          : 'ready-to-load'
    : 'none'
  const versionRow: DiagnosticPanelRow = report === null
    ? { label: '版本', value: '插件 ' + normalizeVersion(input.pluginVersion) }
    : { label: '版本', value: '插件 ' + report.pluginVersion + ' · 宿主 ' + (report.hostVersion ?? '未知') }
  const rows: DiagnosticPanelRow[] = report === null
    ? [{ label: '来源', value: '手动报告' }, versionRow]
    : [
        { label: '来源', value: '自动记录' },
        { label: '模式', value: MODE_TEXT[report.mode] },
        { label: '动作', value: ACTION_TEXT[report.action] },
        { label: '命中', value: report.count + ' 次' },
        { label: '阈值', value: String(report.threshold) },
        versionRow,
      ]
  const downloadHint = report === null
    ? noteEmpty
      ? '还没有备注：手动报告只有插件版本；填写后导出更有用。预览就是文件内容。'
      : '手动报告只含这段备注和插件版本；下载只在本机生成 JSON 文件。'
    : '预览就是下载文件的内容；只有点击按钮才会写入本地。'
  return {
    phase: state.status,
    source: report === null ? 'manual' : 'automatic',
    report,
    note,
    noteLimit: DIAGNOSTIC_NOTE_LIMIT,
    noteCount: note.length,
    previewText,
    exportDocument,
    fileName: diagnosticFileName(input.at),
    message,
    rows,
    structure: report === null ? '' : describeStructure(report),
    summaryText,
    loader,
    showManualEntry: report === null,
    noteHint: '可选，最多 ' + DIAGNOSTIC_NOTE_LIMIT + ' 字；首尾空白和不可见字符不会导出，备注只保存在当前页面，不会自动保存。',
    downloadHint,
    manualHint: report === null ? '手动报告标记为 manual，只含插件版本和这段备注；不含阈值、结构或环境字段。' : null,
  }
}

/** Element ids shared between the component and the pure view. */
export interface DiagnosticElementIds {
  readonly note: string
  readonly noteHint: string
  readonly noteCount: string
  readonly previewLabel: string
  readonly downloadHint: string
  readonly live: string
}

/** Callbacks the view forwards; tests may omit them. */
export interface DiagnosticViewHandlers {
  readonly onToggle?: (open: boolean) => void
  readonly onNoteChange?: (value: string) => void
  readonly onManualFocus?: () => void
  readonly onLoaderAction?: () => void
  readonly onVersionsChange?: (checked: boolean) => void
  readonly onStructureChange?: (checked: boolean) => void
  readonly onDownload?: () => void
}

/** What the pure view needs; the component supplies refs and handlers. */
export interface DiagnosticViewProps {
  readonly model: DiagnosticPanelModel
  readonly ids: DiagnosticElementIds
  readonly open: boolean
  readonly exportStatus: string | null
  readonly handlers?: DiagnosticViewHandlers
  readonly noteRef?: Ref<HTMLTextAreaElement>
  readonly feedback?: ReactNode
}

/**
 * Render the panel from a prepared model. No hooks, no side effects: calling it
 * produces the element tree only, which keeps the accessibility contract and
 * the payload preview testable without a DOM.
 * @param props - model, ids, disclosure state, status line, handlers.
 * @returns the panel element tree.
 */
export function DiagnosticView(props: DiagnosticViewProps): ReactNode {
  const model = props.model
  const ids = props.ids
  const handlers = props.handlers ?? {}
  const liveText = [model.message.text, props.exportStatus]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' ')
  const showToolbar = model.loader !== 'none' || model.showManualEntry
  return (
    <div className="dfg-diag" data-dfg-source={model.source} data-dfg-phase={model.phase}>
      <style>{STYLES}</style>
      <span className="dfg-diag-live" id={ids.live} role="status" aria-live="polite" aria-atomic="true">
        {liveText}
      </span>
      <details
        className="dfg-diag-details"
        open={props.open}
        onToggle={(event) => { handlers.onToggle?.(event.currentTarget.open) }}
      >
        <summary className="dfg-diag-summary">
          <span className="dfg-diag-summary-title">防护诊断</span>
          <span className="dfg-diag-summary-text">{model.summaryText}</span>
        </summary>
        <div className="dfg-diag-body">
          <p className="dfg-diag-message" data-tone={model.message.tone}>{model.message.text}</p>
          {showToolbar ? (
            <div className="dfg-diag-toolbar">
              {model.loader === 'none' ? null : (
                <button
                  type="button"
                  className="dfg-diag-button"
                  disabled={model.loader === 'loading'}
                  onClick={() => { handlers.onLoaderAction?.() }}
                >
                  {model.loader === 'loading' ? '正在读取…' : model.loader === 'retry' ? '重新读取本次记录' : '读取本次记录'}
                </button>
              )}
              {model.showManualEntry ? (
                <button
                  type="button"
                  className="dfg-diag-button dfg-diag-button-quiet"
                  aria-controls={ids.note}
                  onClick={() => { handlers.onManualFocus?.() }}
                >
                  填写手动报告
                </button>
              ) : null}
            </div>
          ) : null}
          <dl className="dfg-diag-rows">
            {model.rows.map((row) => (
              <div className="dfg-diag-row" key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
          {model.report === null ? null : <p className="dfg-diag-structure">{model.structure}</p>}
          <div className="dfg-diag-field">
            <label className="dfg-diag-label" htmlFor={ids.note}>备注（可选）</label>
            <p className="dfg-diag-hint" id={ids.noteHint}>{model.noteHint}</p>
            <textarea
              ref={props.noteRef}
              id={ids.note}
              className="dfg-diag-textarea"
              value={model.note}
              maxLength={model.noteLimit}
              rows={3}
              placeholder="例如：同一段思考重复了 6 行，但没有被截断。请勿填写凭据或个人信息。"
              aria-describedby={ids.noteHint + ' ' + ids.noteCount}
              onChange={(event) => { handlers.onNoteChange?.(event.currentTarget.value) }}
            />
            <p className="dfg-diag-count" id={ids.noteCount}>{model.noteCount} / {model.noteLimit} 字</p>
            {model.manualHint === null ? null : <p className="dfg-diag-hint">{model.manualHint}</p>}
          </div>
          {model.exportDocument.kind === 'automatic' ? <fieldset className="dfg-diag-field">
            <legend>包含在下载文件中</legend>
            <label><input type="checkbox" checked={model.exportDocument.pluginVersion !== undefined}
              onChange={event => handlers.onVersionsChange?.(event.currentTarget.checked)} /> 版本信息</label>
            <label><input type="checkbox" checked={model.exportDocument.trace !== undefined}
              onChange={event => handlers.onStructureChange?.(event.currentTarget.checked)} /> 复读结构</label>
          </fieldset> : null}
          <div className="dfg-diag-preview">
            <p className="dfg-diag-preview-label" id={ids.previewLabel}>导出内容预览</p>
            <pre
              className="dfg-diag-pre"
              tabIndex={0}
              role="region"
              aria-labelledby={ids.previewLabel}
            >
              {model.previewText}
            </pre>
          </div>
          <div className="dfg-diag-footer">
            <button
              type="button"
              className="dfg-diag-button dfg-diag-primary"
              aria-describedby={ids.downloadHint}
              onClick={() => { handlers.onDownload?.() }}
            >
              下载 JSON
            </button>
            <p className="dfg-diag-hint" id={ids.downloadHint}>{model.downloadHint}</p>
          </div>
          {props.feedback}
        </div>
      </details>
    </div>
  )
}

/** Props the host binds when it mounts the panel under a Turn. */
export interface DiagnosticPanelProps {
  /** Reads this Turn's automatic record; absent means manual reports only. */
  readonly load?: () => Promise<DiagnosticReport | null>
  /** The build label written into a manual report. */
  readonly pluginVersion?: string
  /** Current-turn hits from the existing projection. An empty list permits feedback about missed hits. */
  readonly feedbackHits?: readonly GuardHit[]
  /** Start expanded; the default keeps the Turn list quiet. */
  readonly defaultOpen?: boolean
}

/**
 * The Turn's diagnostic entry. Reads only on explicit user request,
 * and never keeps the note anywhere but React state.
 * @param props - the loader and version labels.
 * @returns the panel.
 */
export function DiagnosticPanel(props: DiagnosticPanelProps): ReactNode {
  const uid = useId()
  const ids = useMemo<DiagnosticElementIds>(() => ({
    note: uid + '-note',
    noteHint: uid + '-note-hint',
    noteCount: uid + '-note-count',
    previewLabel: uid + '-preview-label',
    downloadHint: uid + '-download-hint',
    live: uid + '-live',
  }), [uid])
  const [state, setState] = useState<DiagnosticLoadState>({ status: 'idle' })
  const [includeVersions, setIncludeVersions] = useState(true)
  const [includeStructure, setIncludeStructure] = useState(true)
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(props.defaultOpen === true)
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  const loadRef = useRef<DiagnosticPanelProps['load']>(props.load)
  loadRef.current = props.load
  const cancelRef = useRef<null | (() => void)>(null)
  const noteRef = useRef<HTMLTextAreaElement | null>(null)

  const runLoad = useCallback(() => {
    cancelRef.current?.()
    cancelRef.current = null
    const load = loadRef.current
    if (!load) {
      setState({ status: 'idle' })
      return
    }
    setState({ status: 'loading' })
    setExportStatus(null)
    cancelRef.current = beginDiagnosticLoad(load, setState)
  }, [])

  useEffect(() => {
    return () => {
      cancelRef.current?.()
      cancelRef.current = null
    }
  }, [])

  const model = useMemo(() => deriveDiagnosticPanelModel({
    hasLoader: typeof props.load === 'function',
    state,
    note,
    pluginVersion: props.pluginVersion,
    includeVersions, includeStructure,
  }), [props.load, props.pluginVersion, state, note, includeVersions, includeStructure])

  const handlers = useMemo<DiagnosticViewHandlers>(() => ({
    onToggle: (next: boolean) => { setOpen(next) },
    onNoteChange: (value: string) => { setNote(value) },
    onManualFocus: () => { noteRef.current?.focus() },
    onLoaderAction: () => { runLoad() },
    onVersionsChange: setIncludeVersions,
    onStructureChange: setIncludeStructure,
    onDownload: () => {
      const outcome = exportDiagnosticDocument(model.exportDocument, { fileName: model.fileName })
      setExportStatus(outcome.ok ? '已保存 ' + outcome.fileName : '当前环境不能写入本地文件，可复制上面的预览。')
    },
  }), [model.exportDocument, model.fileName, runLoad])

  return (
    <DiagnosticView
      model={model}
      ids={ids}
      open={open}
      exportStatus={exportStatus}
      handlers={handlers}
      noteRef={noteRef}
      feedback={open && props.feedbackHits !== undefined ? (
        <FeedbackPanel hits={props.feedbackHits} exporterVersion={props.pluginVersion}
          serialize={serializeDiagnosticDocument} download={(document) => exportDiagnosticDocument(document).ok} />
      ) : null}
    />
  )
}

const STYLES = `
.dfg-diag {
  margin: 6px 0 0;
  color: var(--dsw-alias-label-primary, #1f2329);
  font-size: 12px;
  line-height: 1.55;
}
.dfg-diag-live {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.dfg-diag-details > summary {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
  color: var(--dsw-alias-label-tertiary, #58616e);
  cursor: pointer;
}
.dfg-diag-summary-title {
  color: var(--dsw-alias-label-secondary, #3b4350);
  font-weight: 500;
}
.dfg-diag-summary-text { min-width: 0; }
.dfg-diag-body {
  display: grid;
  gap: 10px;
  max-width: min(640px, 100%);
  margin: 8px 0 0 18px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.24));
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.04));
}
.dfg-diag-message { margin: 0; overflow-wrap: anywhere; }
.dfg-diag-message[data-tone=warn] { color: var(--dsw-alias-state-warning-primary, #8a4b0f); }
.dfg-diag-message[data-tone=error] { color: var(--dsw-alias-state-error-primary, #b42318); }
.dfg-diag-toolbar { display: flex; flex-wrap: wrap; gap: 8px; }
.dfg-diag-rows { display: grid; gap: 3px; margin: 0; }
.dfg-diag-row { display: flex; flex-wrap: wrap; gap: 8px; }
.dfg-diag-row dt { flex: none; min-width: 32px; color: var(--dsw-alias-label-tertiary, #58616e); }
.dfg-diag-row dd { margin: 0; font-weight: 500; overflow-wrap: anywhere; }
.dfg-diag-structure { margin: 0; color: var(--dsw-alias-label-tertiary, #58616e); }
.dfg-diag-field { display: grid; gap: 4px; }
.dfg-feedback { border-top: 1px solid var(--dsw-alias-line-1, #9ca3af55); padding-top: 8px; min-width: 0; }
.dfg-feedback > summary { width: fit-content; cursor: pointer; font-weight: 500; }
.dfg-feedback > .dfg-diag-field { margin-top: 8px; gap: 8px; min-width: 0; }
.dfg-feedback fieldset { min-width: 0; }
.dfg-feedback select { min-width: 0; max-width: 100%; font: inherit; color: inherit; background: var(--dsw-alias-bg-base, Canvas); }
.dfg-feedback button { justify-self: start; }
.dfg-diag-label { font-weight: 500; }
.dfg-diag-hint { margin: 0; color: var(--dsw-alias-label-tertiary, #58616e); font-size: 11px; line-height: 1.5; }
.dfg-diag-textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 64px;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.4));
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-module-platform, #fff);
  color: inherit;
  font: inherit;
  resize: vertical;
}
.dfg-diag-count { margin: 0; color: var(--dsw-alias-label-tertiary, #58616e); font-size: 11px; text-align: end; }
.dfg-diag-preview { display: grid; gap: 4px; }
.dfg-diag-preview-label { margin: 0; font-weight: 500; }
.dfg-diag-pre {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.24));
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-module-platform, #fff);
  color: var(--dsw-alias-label-primary, #1f2329);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre;
  tab-size: 2;
}
.dfg-diag-footer { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.dfg-diag-footer .dfg-diag-hint { flex: 1 1 220px; }
.dfg-diag-button {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.4));
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.dfg-diag-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }
.dfg-diag-button:disabled { cursor: progress; opacity: 0.55; }
.dfg-diag-button-quiet { border-color: transparent; color: var(--dsw-alias-label-secondary, #3b4350); }
.dfg-diag-primary {
  --dfg-action-bg: var(--dsw-alias-label-primary, CanvasText);
  --dfg-action-fg: var(--dsw-alias-bg-module-platform, Canvas);
  border-color: transparent;
  background: var(--dfg-action-bg);
  color: var(--dfg-action-fg);
}
.dfg-diag-primary:hover:not(:disabled) { background: var(--dfg-action-bg); text-decoration: underline; }
.dfg-diag :focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 2px; }
@media (prefers-reduced-motion: no-preference) {
  .dfg-diag-button { transition: background-color 160ms cubic-bezier(.2, .8, .2, 1), filter 160ms cubic-bezier(.2, .8, .2, 1); }
}
@media (max-width: 520px) {
  .dfg-diag-body { margin-inline-start: 0; }
}
`
