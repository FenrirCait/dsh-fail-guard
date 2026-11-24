/**
 * Behavioral tests for the Turn diagnostic panel. The panel is tested as shipped:
 * the built client bundle is preferred when it re-exports this module (the client
 * entry can add that line later), otherwise src/client/diagnostic-panel.tsx is
 * compiled with esbuild in memory and imported through a data: URL, so the test
 * needs no writable temp directory. Both paths run the same assertions, so the
 * tests work before and after the bundle wiring.
 *
 * Run: node --test test/diagnostic-ui.test.mjs
 * Force a bundle: GUARD_CLIENT_BUNDLE=/absolute/path/to/client.js
 *
 * The shared report type lives in src/diagnostic-shared.ts (owned elsewhere); the
 * panel imports it as a type only, so the standalone compile needs no runtime file.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PANEL_SOURCE = join(PROJECT_ROOT, 'src', 'client', 'diagnostic-panel.tsx')
const DEFAULT_BUNDLE = join(PROJECT_ROOT, 'lib', 'client.js')
const BUNDLE = process.env.GUARD_CLIENT_BUNDLE ?? DEFAULT_BUNDLE

const REQUIRED_EXPORTS = [
  'DiagnosticPanel',
  'DiagnosticView',
  'buildManualDocument',
  'buildAutomaticDocument',
  'buildExportDocument',
  'serializeDiagnosticDocument',
  'diagnosticFileName',
  'sanitizeNote',
  'readDiagnosticReport',
  'copyDiagnosticReport',
  'deriveDiagnosticPanelModel',
  'exportDiagnosticDocument',
  'beginDiagnosticLoad',
  'describeLoadFailure',
]

const BASE_KEYS = [
  'version',
  'kind',
  'pluginVersion',
  'hostVersion',
  'threshold',
  'mode',
  'count',
  'action',
  'trace',
]

const IDS = {
  note: 'dfg-note',
  noteHint: 'dfg-note-hint',
  noteCount: 'dfg-note-count',
  previewLabel: 'dfg-preview-label',
  downloadHint: 'dfg-download-hint',
  live: 'dfg-live',
}

function sampleReport(overrides = {}) {
  return {
    version: 1,
    kind: 'automatic',
    pluginVersion: '0.4.0-alpha.3',
    hostVersion: '0.2.2-rc.5',
    threshold: 5,
    mode: 'enforce',
    count: 2,
    action: 'cut',
    trace: {
      events: [
        { kind: 'start', block: 0 },
        { kind: 'delta', block: 0 },
        { kind: 'end', block: 0 },
        { kind: 'start', block: 1 },
        { kind: 'delta', block: 1 },
      ],
      groups: [2, 2],
    },
    ...overrides,
  }
}

async function loadFromBuiltBundle() {
  let source
  try {
    source = await readFile(BUNDLE, 'utf8')
  } catch {
    return null
  }
  let definition
  const reactModule = await import('react')
  const jsxRuntime = await import('react/jsx-runtime')
  const requireStub = (specifier) => {
    if (specifier === 'react') return reactModule
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    throw new Error('unexpected module request: ' + specifier)
  }
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(value) { definition = value } } },
    require: requireStub,
    console,
  })
  new vm.Script(source, { filename: BUNDLE }).runInContext(context)
  if (definition === undefined) return null
  const exported = definition.factory(requireStub)
  if (typeof exported.DiagnosticPanel !== 'function') return null
  if (typeof exported.buildExportDocument !== 'function') return null
  return { module: exported, via: 'bundle ' + BUNDLE }
}

async function loadFromCompiler() {
  // write:false keeps the build in memory; a data: URL imports it without a
  // writable temp directory, which locked-down sandboxes refuse.
  const result = await build({
    absWorkingDir: PROJECT_ROOT,
    entryPoints: [PANEL_SOURCE],
    outfile: 'diagnostic-panel.mjs',
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
  })
  const compiledText = result.outputFiles[0].text
  const encoded = Buffer.from(compiledText, 'utf8').toString('base64')
  const module = await import('data:text/javascript;base64,' + encoded)
  return { module, via: 'esbuild compile of ' + PANEL_SOURCE, compiledText }
}

const loadedPromise = (async () => (await loadFromBuiltBundle()) ?? (await loadFromCompiler()))()
const loaded = () => loadedPromise

function derive(module, overrides = {}) {
  const state = overrides.state ?? { status: 'ready', report: module.readDiagnosticReport(sampleReport()).report }
  return module.deriveDiagnosticPanelModel({
    hasLoader: true,
    note: '',
    pluginVersion: '0.4.0-alpha.3',
    at: new Date('2026-11-24T03:56:16Z'),
    ...overrides,
    state,
  })
}

test('deselected automatic sections are absent from both preview and download', async () => {
  const { module } = await loaded();
  const model = derive(module, { includeVersions: false, includeStructure: false, note: 'synthetic note' });
  let downloaded;
  const result = module.exportDiagnosticDocument(model.exportDocument, { ports: { save(text) { downloaded = text; } } });
  assert.equal(result.ok, true);
  assert.equal(downloaded, model.previewText);
  const doc = JSON.parse(downloaded);
  assert.equal(doc.kind, 'automatic');
  assert.equal(doc.note, 'synthetic note');
  for (const key of ['pluginVersion', 'hostVersion', 'trace']) assert.ok(!(key in doc));
});

function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') return
  if (typeof node !== 'object') return
  if (node.props === undefined) return
  visit(node)
  walk(node.props.children, visit)
}

function elementsOf(tree, type, predicate = () => true) {
  const found = []
  walk(tree, (element) => {
    if (element.type === type && predicate(element)) found.push(element)
  })
  return found
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => textOf(child)).join('')
  if (typeof node === 'object' && node.props !== undefined) return textOf(node.props.children)
  return ''
}

function buttonByText(tree, label) {
  return elementsOf(tree, 'button', (element) => textOf(element.props.children) === label)[0]
}

function deferred() {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue
    rejectPromise = rejectValue
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function tick() {
  return new Promise((resolveValue) => setImmediate(resolveValue))
}

test('loads the panel from the bundle or a standalone compile', async (t) => {
  const result = await loaded()
  t.diagnostic('panel module: ' + result.via)
  for (const name of REQUIRED_EXPORTS) {
    assert.equal(typeof result.module[name], 'function', name + ' is exported')
  }
  assert.equal(result.module.DIAGNOSTIC_NOTE_LIMIT, 500)
  if (result.compiledText !== undefined) {
    assert.equal(result.compiledText.includes('diagnostic-shared'), false, 'the type-only import is erased')
  }
})

test('sanitizeNote keeps ordinary text and drops what must not travel', async () => {
  const { module } = await loaded()
  const sanitize = module.sanitizeNote
  assert.equal(sanitize(''), '')
  assert.equal(sanitize('   '), '')
  assert.equal(sanitize('  补一句  '), '补一句')
  assert.equal(sanitize('第一行\r\n第二行\r第三行'), '第一行\n第二行\n第三行')
  assert.equal(sanitize('a\u0000b\u0007c\u007Fd'), 'abcd')
  assert.equal(sanitize('保留\n换行'), '保留\n换行')
  assert.equal(sanitize('abc', 0), '')
  assert.equal(Array.from(sanitize('字'.repeat(600))).length, 500)
  const emoji = sanitize('😀'.repeat(600))
  assert.equal(Array.from(emoji).length, 500)
  assert.equal(emoji.isWellFormed(), true, 'no split surrogate pair')
})

test('readDiagnosticReport accepts the shared shape, copies it, and refuses the rest', async () => {
  const { module } = await loaded()
  const parsed = module.readDiagnosticReport(sampleReport())
  assert.equal(parsed.ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.report)), sampleReport())

  const source = sampleReport()
  const copied = module.readDiagnosticReport(source)
  source.trace.events.push({ kind: 'delta', block: 7 })
  source.trace.groups[0] = 99
  source.count = 9
  assert.equal(copied.report.count, 2)
  assert.equal(copied.report.trace.events.length, 5)
  assert.equal(copied.report.trace.groups[0], 2)
  copied.report.trace.events[0].block = 4
  assert.equal(source.trace.events[0].block, 0)

  const withExtras = {
    ...sampleReport(),
    environment: { platform: 'win32' },
    trace: { ...sampleReport().trace, raw: 'not exported' },
  }
  const trimmed = module.readDiagnosticReport(withExtras)
  assert.equal(trimmed.ok, true)
  assert.equal('environment' in trimmed.report, false)
  assert.equal('raw' in trimmed.report.trace, false)

  const invalid = [
    null,
    undefined,
    42,
    'report',
    [],
    {},
    { ...sampleReport(), version: 2 },
    { ...sampleReport(), kind: 'manual' },
    { ...sampleReport(), pluginVersion: 7 },
    { ...sampleReport(), hostVersion: undefined },
    { ...sampleReport(), threshold: -1 },
    { ...sampleReport(), count: 1.5 },
    { ...sampleReport(), mode: 'silent' },
    { ...sampleReport(), action: 'notified' },
    { ...sampleReport(), trace: null },
    { ...sampleReport(), trace: { events: [], groups: 'x' } },
    { ...sampleReport(), trace: { events: [{}], groups: [] } },
    { ...sampleReport(), trace: { events: [{ kind: 'start', block: -1 }], groups: [] } },
    { ...sampleReport(), trace: { events: [], groups: [1.5] } },
  ]
  for (const value of invalid) {
    assert.equal(module.readDiagnosticReport(value).ok, false)
  }
})

test('a manual report states its own kind and carries no automatic fields', async () => {
  const { module } = await loaded()
  const manual = module.buildManualDocument({ note: '  漏掉了  ', pluginVersion: '  1.2.3  ' })
  assert.deepEqual(JSON.parse(JSON.stringify(manual)), { version: 1, kind: 'manual', pluginVersion: '1.2.3', note: '漏掉了' })
  for (const absent of ['trace', 'threshold', 'count', 'mode', 'action', 'hostVersion']) {
    assert.equal(absent in manual, false, 'manual payload has no ' + absent)
  }

  const bare = module.buildManualDocument({ note: '   ' })
  assert.deepEqual(JSON.parse(JSON.stringify(bare)), { version: 1, kind: 'manual', pluginVersion: 'unknown' })
  assert.equal('note' in bare, false)

  const automatic = module.buildExportDocument({ report: sampleReport(), note: '', pluginVersion: 'x' })
  assert.equal(automatic.kind, 'automatic')
  assert.equal('trace' in automatic, true)
  const manualChoice = module.buildExportDocument({ report: null, note: 'miss', pluginVersion: 'x' })
  assert.equal(manualChoice.kind, 'manual')
  assert.equal('trace' in manualChoice, false)
})

test('buildAutomaticDocument adds the note only when there is one', async () => {
  const { module } = await loaded()
  const plain = module.buildAutomaticDocument(sampleReport(), '   ')
  assert.equal('note' in plain, false)
  assert.deepEqual(Object.keys(plain), BASE_KEYS)

  const annotated = module.buildAutomaticDocument(sampleReport(), '  补一句\r\n漏掉了  ')
  assert.equal(annotated.note, '补一句\n漏掉了')
  assert.deepEqual(Object.keys(annotated), [...BASE_KEYS, 'note'])

  const source = sampleReport()
  const documentValue = module.buildAutomaticDocument(source, '')
  source.trace.events.push({ kind: 'delta', block: 3 })
  source.threshold = 1
  assert.equal(documentValue.trace.events.length, 5)
  assert.equal(documentValue.threshold, 5)
})

test('serializeDiagnosticDocument is the file text itself', async () => {
  const { module } = await loaded()
  const documentValue = module.buildAutomaticDocument(sampleReport(), '补一句')
  const text = module.serializeDiagnosticDocument(documentValue)
  assert.equal(text.endsWith('\n'), true)
  assert.equal(text.includes('\n  "version": 1'), true)
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(documentValue)))
})

test('diagnosticFileName is a UTC stamp that stays filesystem-safe', async () => {
  const { module } = await loaded()
  assert.equal(
    module.diagnosticFileName(new Date('2026-11-24T03:56:16Z')),
    'dsh-fail-guard-diagnostic-20261124-035616.json',
  )
  assert.match(module.diagnosticFileName(), /^dsh-fail-guard-diagnostic-\d{8}-\d{6}\.json$/)
  assert.match(module.diagnosticFileName(new Date('not a date')), /^dsh-fail-guard-diagnostic-\d{8}-\d{6}\.json$/)
})

test('exportDiagnosticDocument writes exactly the preview through an explicit port', async () => {
  const { module } = await loaded()
  const documentValue = module.buildAutomaticDocument(sampleReport(), '补一句')
  const calls = []
  const outcome = module.exportDiagnosticDocument(documentValue, {
    fileName: 'fixed.json',
    ports: { save(text, fileName) { calls.push({ text, fileName }) } },
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.reason, null)
  assert.equal(outcome.fileName, 'fixed.json')
  assert.equal(outcome.text, module.serializeDiagnosticDocument(documentValue))
  assert.deepEqual(calls, [{ text: outcome.text, fileName: 'fixed.json' }])

  const unavailable = module.exportDiagnosticDocument(documentValue, { fileName: 'fixed.json' })
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.reason, 'unavailable', 'Node has no DOM: no save happens')

  const failed = module.exportDiagnosticDocument(documentValue, {
    fileName: 'fixed.json',
    ports: { save() { throw new Error('denied') } },
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'failed')
  assert.equal(failed.text, outcome.text)
})

test('diagnostic failure messages can cross realms and unreadable messages fall back', async () => {
  const { module } = await loaded()
  assert.equal(module.describeLoadFailure(vm.runInNewContext('new Error("fixture cross realm")')), 'fixture cross realm')
  assert.equal(module.describeLoadFailure({ get message() { throw new Error('fixture getter') } }), '未知原因')
})

test('beginDiagnosticLoad reports one terminal state and forgets cancelled attempts', async () => {
  const { module } = await loaded()
  const readyStates = []
  module.beginDiagnosticLoad(() => Promise.resolve(sampleReport()), (state) => readyStates.push(state))
  await tick()
  assert.equal(readyStates.length, 1)
  assert.equal(readyStates[0].status, 'ready')

  const emptyStates = []
  module.beginDiagnosticLoad(() => Promise.resolve(null), (state) => emptyStates.push(state))
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(emptyStates)), [{ status: 'empty' }])

  const rejected = []
  module.beginDiagnosticLoad(() => Promise.reject(new Error('boom')), (state) => rejected.push(state))
  await tick()
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].status, 'failed')
  assert.match(rejected[0].reason, /boom/)

  const thrown = []
  module.beginDiagnosticLoad(() => { throw new Error('sync boom') }, (state) => thrown.push(state))
  assert.equal(thrown.length, 1)
  assert.match(thrown[0].reason, /sync boom/)

  const malformed = []
  module.beginDiagnosticLoad(() => Promise.resolve({ version: 2 }), (state) => malformed.push(state))
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(malformed)), [{ status: 'failed', reason: '记录格式无法识别' }])

  const first = deferred()
  const second = deferred()
  const order = []
  const cancelFirst = module.beginDiagnosticLoad(() => first.promise, (state) => order.push(['first', state]))
  module.beginDiagnosticLoad(() => second.promise, (state) => order.push(['second', state]))
  cancelFirst()
  second.resolve(null)
  await tick()
  first.resolve(sampleReport())
  await tick()
  assert.deepEqual(order.map((entry) => entry[0]), ['second'])

  const settled = []
  const cancelSettled = module.beginDiagnosticLoad(() => Promise.resolve(sampleReport()), (state) => settled.push(state))
  await tick()
  cancelSettled()
  assert.equal(settled.length, 1)
})

test('the derived model mirrors each load state and keeps preview and payload in step', async () => {
  const { module } = await loaded()
  const ready = derive(module, { note: '补一句' })
  assert.equal(ready.source, 'automatic')
  assert.deepEqual(JSON.parse(JSON.stringify(ready.rows.map((row) => row.label))), ['来源', '模式', '动作', '命中', '阈值', '版本'])
  assert.equal(ready.rows[0].value, '自动记录')
  assert.equal(ready.rows[1].value, '执行模式')
  assert.equal(ready.rows[2].value, '已截断本轮')
  assert.equal(ready.rows[3].value, '2 次')
  assert.equal(ready.rows[4].value, '5')
  assert.match(ready.rows[5].value, /插件 0\.4\.0-alpha\.3 · 宿主 0\.2\.2-rc\.5/)
  assert.match(ready.structure, /5 个事件 · 2 组/)
  assert.match(ready.structure, /组大小 2, 2/)
  assert.match(ready.summaryText, /命中 2 次 · 已截断本轮/)
  assert.equal(ready.loader, 'none')
  assert.equal(ready.showManualEntry, false)
  assert.equal(ready.noteCount, 3)
  const saved = module.exportDiagnosticDocument(ready.exportDocument, {
    fileName: ready.fileName,
    ports: { save() {} },
  })
  assert.equal(saved.text, ready.previewText)
  assert.equal(JSON.parse(ready.previewText).note, '补一句')

  const zero = derive(module, {
    state: { status: 'ready', report: module.readDiagnosticReport(sampleReport({ count: 0, action: 'observed' })).report },
  })
  assert.match(zero.summaryText, /无命中记录/)
  assert.match(zero.message.text, /没有命中/)

  const loading = derive(module, { state: { status: 'loading' } })
  assert.equal(loading.loader, 'loading')
  assert.match(loading.message.text, /正在读取/)
  assert.equal(loading.source, 'manual')

  const failed = derive(module, { state: { status: 'failed', reason: 'boom' } })
  assert.equal(failed.message.tone, 'error')
  assert.match(failed.message.text, /boom/)
  assert.equal(failed.loader, 'retry')
  assert.equal(failed.showManualEntry, true)

  const empty = derive(module, { state: { status: 'empty' } })
  assert.equal(empty.loader, 'retry')
  assert.match(empty.message.text, /没有自动记录/)

  assert.equal(derive(module, { hasLoader: true, state: { status: 'idle' } }).loader, 'ready-to-load')
  assert.equal(derive(module, { hasLoader: false, state: { status: 'idle' } }).loader, 'none')

  const manual = derive(module, {
    hasLoader: false,
    state: { status: 'idle' },
    pluginVersion: '1.2.3',
  })
  assert.equal(manual.source, 'manual')
  assert.equal(manual.showManualEntry, true)
  assert.equal(manual.rows[0].value, '手动报告')
  assert.equal(manual.rows[1].value, '插件 1.2.3')
  assert.equal(manual.structure, '')
  assert.deepEqual(JSON.parse(manual.previewText), { version: 1, kind: 'manual', pluginVersion: '1.2.3' })
  assert.match(manual.downloadHint, /插件版本/)

  const manualNote = derive(module, {
    hasLoader: false,
    state: { status: 'idle' },
    note: '同一段重复 6 行没有被截断',
    pluginVersion: '1.2.3',
  })
  assert.deepEqual(JSON.parse(manualNote.previewText), {
    version: 1,
    kind: 'manual',
    pluginVersion: '1.2.3',
    note: '同一段重复 6 行没有被截断',
  })

  const manyGroups = derive(module, {
    state: {
      status: 'ready',
      report: module.readDiagnosticReport(sampleReport({
        trace: { events: [{ kind: 'start', block: 0 }], groups: [1, 1, 1, 1, 1, 1, 1, 1, 1] },
      })).report,
    },
  })
  assert.match(manyGroups.structure, /等 9 组/)
  assert.match(derive(module, { at: new Date('not a date') }).fileName, /^dsh-fail-guard-diagnostic-\d{8}-\d{6}\.json$/)
})

test('the view renders the disclosure, the payload preview, and accessible controls', async () => {
  const { module } = await loaded()
  const model = derive(module, { note: '补一句' })
  const calls = { toggle: [], note: [], manual: 0, loader: 0, download: 0 }
  const tree = module.DiagnosticView({
    model,
    ids: IDS,
    open: true,
    exportStatus: null,
    handlers: {
      onToggle(open) { calls.toggle.push(open) },
      onNoteChange(value) { calls.note.push(value) },
      onManualFocus() { calls.manual += 1 },
      onLoaderAction() { calls.loader += 1 },
      onDownload() { calls.download += 1 },
    },
  })
  const [details] = elementsOf(tree, 'details')
  assert.equal(details.props.open, true)
  assert.ok(textOf(details).includes('防护诊断'))
  assert.ok(textOf(details).includes('命中 2 次 · 已截断本轮'))

  const [textarea] = elementsOf(tree, 'textarea')
  assert.equal(textarea.props.id, IDS.note)
  assert.equal(textarea.props.value, '补一句')
  assert.equal(textarea.props.maxLength, 500)
  assert.equal(textarea.props.rows, 3)
  assert.equal(textarea.props['aria-describedby'], IDS.noteHint + ' ' + IDS.noteCount)
  assert.equal(elementsOf(tree, 'label')[0].props.htmlFor, IDS.note)

  const [pre] = elementsOf(tree, 'pre')
  assert.equal(pre.props.children, model.previewText)
  assert.equal(pre.props.tabIndex, 0)
  assert.equal(pre.props.role, 'region')
  assert.equal(pre.props['aria-labelledby'], IDS.previewLabel)
  assert.ok(pre.props.children.includes('"count": 2'))

  const [live] = elementsOf(tree, 'span', (element) => element.props.id === IDS.live)
  assert.equal(live.props.role, 'status')
  assert.equal(live.props['aria-live'], 'polite')
  assert.ok(textOf(live).includes(model.message.text))

  const download = buttonByText(tree, '下载 JSON')
  assert.ok(download)
  assert.equal(download.props.type, 'button')
  assert.equal(download.props['aria-describedby'], IDS.downloadHint)
  download.props.onClick()
  assert.equal(calls.download, 1)

  textarea.props.onChange({ currentTarget: { value: '改动' } })
  assert.deepEqual(calls.note, ['改动'])

  details.props.onToggle({ currentTarget: { open: false } })
  assert.deepEqual(calls.toggle, [false])

  walk(tree, (element) => {
    assert.equal('dangerouslySetInnerHTML' in element.props, false, 'no raw HTML in ' + element.type)
  })
})

test('without a loader the manual entry stays available and a click is the only save trigger', async () => {
  const { module } = await loaded()
  const model = derive(module, {
    hasLoader: false,
    state: { status: 'idle' },
    pluginVersion: '1.2.3',
  })
  const tree = module.DiagnosticView({ model, ids: IDS, open: true, exportStatus: null, handlers: {} })
  const manual = buttonByText(tree, '填写手动报告')
  assert.ok(manual)
  assert.equal(manual.props['aria-controls'], IDS.note)
  assert.equal(buttonByText(tree, '下载 JSON') !== undefined, true)

  const saved = []
  const outcome = module.exportDiagnosticDocument(model.exportDocument, {
    fileName: model.fileName,
    ports: { save(text, fileName) { saved.push({ text, fileName }) } },
  })
  assert.equal(outcome.ok, true)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].fileName, model.fileName)
  assert.equal(saved[0].text, model.previewText)
  const payload = JSON.parse(saved[0].text)
  assert.deepEqual(payload, { version: 1, kind: 'manual', pluginVersion: '1.2.3' })
  assert.equal('trace' in payload, false)
  assert.equal('threshold' in payload, false)
  assert.equal('hostVersion' in payload, false)

  const collapsed = module.DiagnosticView({ model, ids: IDS, open: false, exportStatus: '已保存 a.json', handlers: {} })
  assert.equal(elementsOf(collapsed, 'details')[0].props.open, false)
  const [live] = elementsOf(collapsed, 'span', (element) => element.props.id === IDS.live)
  assert.ok(textOf(live).includes('已保存 a.json'))
})

test('the panel cannot read conversation state, keep a draft, or reach the network', async () => {
  const sources = [
    ['diagnostic-panel.tsx', ['react', 'react', '../diagnostic-shared.js', '../activity-shared.js', './feedback.js', './feedback-panel.js']],
    ['feedback-panel.tsx', ['react', '../activity-shared.js', './feedback.js']],
    ['feedback.ts', ['../activity-shared.js']],
  ]
  const forbidden = [
    [/\bfetch\s*\(/, 'fetch()'],
    [/XMLHttpRequest/, 'XMLHttpRequest'],
    [/sendBeacon/, 'sendBeacon'],
    [/WebSocket|EventSource/, 'streaming connection'],
    [/localStorage|sessionStorage|indexedDB|document\.cookie/, 'browser storage'],
    [/navigator\.(clipboard|sendBeacon)/, 'browser send API'],
    [/dangerouslySetInnerHTML/, 'HTML injection'],
    [/\bnew Function\b|\beval\s*\(/, 'dynamic code'],
    [/useProjection|useSyncExternalStore|useContext|\bctx\./, 'host state'],
    [/from\s+'@deepseek-ai\//, 'host package import'],
    [/from\s+'react-dom'/, 'DOM renderer'],
  ]
  for (const [file, imports] of sources) {
    const source = await readFile(join(PROJECT_ROOT, 'src', 'client', file), 'utf8')
    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(source, pattern, file + ' must not contain ' + label)
    }
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
    assert.deepEqual(specifiers, imports, file + ' dependency allowlist')
  }
})
