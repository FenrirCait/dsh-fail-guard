/**
 * Behavioral tests for the built client bundle. The bundle is the artifact the
 * Host loads (lib/client.js), evaluated in a VM with a minimal module loader
 * and a fake React, so registration and the save state machine are tested as
 * shipped rather than as source.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import { DEFAULTS, LIMITS } from '../src/options.ts'

const DEFAULT_BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/**
 * Evaluate lib/client.js the way the Host's module loader does and return the
 * factory's exports (apply, inject, ConfigForm, BUNDLE_CONFIG_SLOT).
 * @returns the bundle's module namespace.
 */
async function loadClient({ render = false, useState, browser = {} } = {}) {
  const path = process.env.GUARD_CLIENT_BUNDLE ?? DEFAULT_BUNDLE
  const source = await readFile(path, 'utf8')
  const jsxRuntime = await import('react/jsx-runtime')
  const reactModule = await import('react')
  const reactStub = render
    ? {
        ...reactModule,
        useId: () => 'dfg-test',
        useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
        useMemo: (calculate) => calculate(),
        useCallback: (callback) => callback,
        useState: useState ?? ((initial) => [initial, () => {}]),
        useRef: (initial) => ({ current: initial }),
        useEffect: () => {},
      }
    : {
        Fragment: Symbol('Fragment'),
        createElement: () => null,
        jsx: jsxRuntime.jsx,
        jsxs: jsxRuntime.jsxs,
        useId: () => 'dfg-test',
        useSyncExternalStore: () => { throw new Error('the component is not rendered in these tests') },
      }
  const requireStub = (specifier) => {
    if (specifier === 'react') return reactStub
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected module request: ${specifier}`)
  }
  let loaded
  const window = { __ModuleLoader__: { load(definition) { loaded = definition } } }
  const context = vm.createContext({
    ...browser,
    window: { ...window, setTimeout },
    require: requireStub,
    console,
  })
  new vm.Script(source, { filename: 'lib/client.js' }).runInContext(context)
  assert.ok(loaded, 'the bundle called window.__ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-fail-guard')
  return loaded.factory(requireStub)
}

/** A Host ConfigForm double: accepted values, revision fencing, and outcomes. */
function createFormHarness(overrides = {}) {
  let state = {
    status: 'ready',
    value: { ...DEFAULTS },
    base: undefined,
    user: undefined,
    revision: 7,
    writable: true,
    ...overrides,
  }
  const listeners = new Set()
  const calls = []
  let handler = null

  const emit = () => {
    for (const listener of [...listeners]) listener()
  }
  const accept = (ops) => {
    const value = { ...state.value }
    for (const op of ops) value[op.path[0]] = op.value
    state = { ...state, value, revision: (state.revision ?? 0) + 1 }
    emit()
    return true
  }
  const form = {
    getSnapshot() { return state },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate(ops, expectedRevision) {
      calls.push({ ops: structuredClone(ops), expectedRevision })
      if (handler !== null) return handler(ops, expectedRevision)
      return Promise.resolve(accept(ops))
    },
  }
  return {
    form,
    calls,
    accept,
    setHandler(next) { handler = next },
    update(patch) { state = { ...state, ...patch }; emit() },
    getState() { return state },
  }
}

/** A fake browser plugin context and the calls it records. */
function createContext(harness) {
  const injected = []
  const registrations = []
  const effects = []
  const configFormsGets = []
  const ctx = {
    slots: {
      inject(name, callback) {
        injected.push(name)
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    configForms: {
      get(id) {
        configFormsGets.push(id)
        return harness.form
      },
    },
    inject() {},
    effect(factory, label) {
      effects.push(label)
      const disposer = factory()
      return () => { if (typeof disposer === 'function') disposer() }
    },
  }
  return { ctx, injected, registrations, effects, configFormsGets }
}

/** Load the bundle, apply it to a fresh context, and expose the controller. */
async function boot(overrides = {}) {
  const client = await loadClient()
  const harness = createFormHarness(overrides)
  const env = createContext(harness)
  client.apply(env.ctx)
  const config = env.registrations.find(entry => entry.options.name === 'plugins.bundle.config')
  assert.ok(config, 'the bundle configuration page is registered')
  const face = config.options.inject()
  return { client, harness, env, controller: face.controller }
}

test('registers exactly one plugins.bundle.config entry keyed by package name', async () => {
  const client = await loadClient()
  assert.deepEqual(Array.from(client.inject), ['slots', 'configForms'])
  const harness = createFormHarness()
  const env = createContext(harness)
  client.apply(env.ctx)

  assert.deepEqual(env.injected, ['plugins.bundle.config', 'conversation.chat.turnTail'])
  assert.equal(env.registrations.length, 2)
  const config = env.registrations.find(entry => entry.options.name === 'plugins.bundle.config')
  const tail = env.registrations.find(entry => entry.options.name === 'conversation.chat.turnTail')
  assert.ok(config, 'the configuration page is registered')
  assert.ok(tail, 'the turn-tail summary is registered')
  assert.equal(config.options.key, 'dsh-fail-guard')
  assert.equal(config.options.id, undefined, 'a keyed entry is addressed by key, not id')
  assert.equal(config.options.locale, undefined)
  assert.equal(config.component, client.ConfigForm)
  assert.equal(typeof config.component, 'function')
  assert.equal(tail.options.id, 'dsh-fail-guard')
  assert.equal(tail.component, client.GuardActivityTail)
  assert.equal(client.BUNDLE_CONFIG_SLOT, 'plugins.bundle.config')
  assert.equal(client.TURN_TAIL_SLOT, 'conversation.chat.turnTail')
  assert.deepEqual(env.configFormsGets, ['dsh-fail-guard-standalone'])
  assert.ok(env.effects.length >= 3, 'every registration is tied to the plugin effect')
  assert.ok(!env.injected.includes('settings.section'), 'no settings section is registered')
})

test('starts clean from the Host values and counts no pending write', async () => {
  const { controller, harness } = await boot()
  const state = controller.getState()
  assert.equal(state.status, 'ready')
  assert.equal(state.writable, true)
  assert.equal(state.draft.failureEnabled, DEFAULTS.failureEnabled)
  assert.equal(state.draft.failureLimit, String(DEFAULTS.failureLimit))
  assert.equal(state.draft.repeatEnabled, DEFAULTS.repeatEnabled)
  assert.equal(state.draft.repeatLimit, String(DEFAULTS.repeatLimit))
  assert.equal(state.draft.resumeOnRepeat, DEFAULTS.resumeOnRepeat)
  assert.equal(state.draft.observeOnly, DEFAULTS.observeOnly)
  assert.equal(state.draft.observeOnly, false)
  assert.equal(state.failureLimit.invalid, false)
  assert.equal(state.repeatLimit.invalid, false)
  assert.equal(state.dirty, false)
  assert.equal(state.canSave, false)
  assert.equal(state.canDiscard, false)
  assert.equal(await controller.save(), false)
  assert.equal(harness.calls.length, 0, 'a clean form writes nothing')
})

test('submits every changed field in one atomic mutation and ignores duplicates', async () => {
  const { controller, harness } = await boot()
  controller.edit('failureLimit', '5')
  controller.edit('repeatEnabled', false)
  controller.edit('resumeOnRepeat', true)
  controller.edit('observeOnly', true)
  assert.equal(controller.getState().dirty, true)
  assert.equal(controller.getState().canSave, true)

  const first = controller.save()
  const second = controller.save()
  const third = controller.save()
  assert.equal(harness.calls.length, 1, 'only one write reaches the Host')
  assert.equal(await second, false)
  assert.equal(await third, false)
  assert.equal(await first, true)

  assert.deepEqual(harness.calls[0].ops, [
    { op: 'set', path: ['failureLimit'], value: 5 },
    { op: 'set', path: ['repeatEnabled'], value: false },
    { op: 'set', path: ['resumeOnRepeat'], value: true },
    { op: 'set', path: ['observeOnly'], value: true },
  ])
  assert.equal(harness.calls[0].expectedRevision, 7)
  const state = controller.getState()
  assert.equal(state.saving, false)
  assert.equal(state.dirty, false)
  assert.equal(state.touched, false)
  assert.equal(state.notice.kind, 'saved')
  assert.equal(state.draft.failureLimit, '5')
  assert.equal(state.draft.repeatEnabled, false)
  assert.equal(state.draft.resumeOnRepeat, true)
  assert.equal(state.draft.observeOnly, true)
})

test('keeps a refused draft and retries against the latest revision', async () => {
  const { controller, harness } = await boot()
  controller.edit('failureLimit', '7')
  // Another writer advanced the document after this draft started.
  harness.update({ revision: 9 })
  assert.equal(controller.getState().draft.failureLimit, '7', 'a Host update does not clobber the draft')

  harness.setHandler(async () => false)
  assert.equal(await controller.save(), false)
  assert.equal(harness.calls[0].expectedRevision, 7, 'the draft fences on the revision it read')
  let state = controller.getState()
  assert.equal(state.notice.kind, 'conflict')
  assert.equal(state.draft.failureLimit, '7', 'the refused draft survives')
  assert.equal(state.dirty, true)
  assert.equal(state.canSave, true, 'the save control becomes the retry control')

  harness.setHandler(async (ops) => harness.accept(ops))
  assert.equal(await controller.save(), true)
  assert.equal(harness.calls.length, 2)
  assert.equal(harness.calls[1].expectedRevision, undefined, 'the retry lets the Host supply its latest revision')
  assert.deepEqual(harness.calls[1].ops, [{ op: 'set', path: ['failureLimit'], value: 7 }])
  state = controller.getState()
  assert.equal(state.notice.kind, 'saved')
  assert.equal(state.dirty, false)
  assert.equal(state.draft.failureLimit, '7')
})

test('keeps the draft after a transport failure and allows a retry', async () => {
  const { controller, harness } = await boot()
  controller.edit('repeatLimit', '8')
  harness.setHandler(async () => { throw new Error('socket closed') })
  assert.equal(await controller.save(), false)
  let state = controller.getState()
  assert.equal(state.notice.kind, 'error')
  assert.match(state.notice.text, /socket closed/)
  assert.equal(state.draft.repeatLimit, '8')
  assert.equal(state.dirty, true)
  assert.equal(state.canSave, true)
  assert.equal(state.saving, false)

  harness.setHandler(async (ops) => harness.accept(ops))
  assert.equal(await controller.save(), true)
  assert.equal(harness.calls[1].expectedRevision, undefined)
  state = controller.getState()
  assert.equal(state.notice.kind, 'saved')
  assert.equal(state.draft.repeatLimit, '8')
})

test('blocks invalid enabled limits without calling the Host', async () => {
  const { controller, harness } = await boot()
  const invalidValues = ['', '4.5', '1', '13', 'abc', '-2']
  for (const value of invalidValues) {
    controller.edit('failureLimit', value)
    const state = controller.getState()
    assert.equal(state.failureLimit.invalid, true, `${JSON.stringify(value)} is invalid`)
    assert.match(state.failureLimit.message, new RegExp(`${LIMITS.failureLimit.min}–${LIMITS.failureLimit.max}`))
    assert.equal(state.canSave, false)
    assert.equal(await controller.save(), false)
    assert.equal(harness.calls.length, 0)
  }
  controller.edit('failureLimit', '5')
  assert.equal(controller.getState().failureLimit.invalid, false)
  assert.equal(controller.getState().canSave, true)
})

test('does not let a disabled guard block the write with unused text', async () => {
  const { controller, harness } = await boot()
  controller.edit('failureEnabled', false)
  controller.edit('failureLimit', '99')
  const state = controller.getState()
  assert.equal(state.failureLimit.invalid, false)
  assert.equal(state.canSave, true)
  assert.equal(await controller.save(), true)
  assert.deepEqual(harness.calls[0].ops, [{ op: 'set', path: ['failureEnabled'], value: false }])
})

test('renders loading and read-only states from the Host snapshot', async () => {
  const client = await loadClient()
  const harness = createFormHarness({
    status: 'loading',
    value: undefined,
    writable: false,
    revision: undefined,
  })
  const env = createContext(harness)
  client.apply(env.ctx)
  const controller = env.registrations[0].options.inject().controller

  let state = controller.getState()
  assert.equal(state.status, 'loading')
  assert.equal(state.canSave, false)
  controller.edit('failureLimit', '6')
  assert.equal(controller.getState().draft.failureLimit, String(DEFAULTS.failureLimit), 'edits wait for the Host values')

  harness.update({ status: 'ready', value: { ...DEFAULTS }, writable: false, revision: 2 })
  state = controller.getState()
  assert.equal(state.status, 'ready')
  assert.equal(state.writable, false)
  assert.equal(state.canSave, false)
  assert.equal(await controller.save(), false)
  assert.equal(harness.calls.length, 0)

  // A read-only snapshot still follows Host values while untouched.
  harness.update({ value: { ...DEFAULTS, repeatLimit: 9 }, writable: true })
  assert.equal(controller.getState().draft.repeatLimit, '9')
})

test('discards edits back to the Host values', async () => {
  const { controller } = await boot()
  controller.edit('repeatLimit', '9')
  controller.edit('observeOnly', true)
  assert.equal(controller.getState().canDiscard, true)
  controller.discard()
  const state = controller.getState()
  assert.equal(state.draft.repeatLimit, String(DEFAULTS.repeatLimit))
  assert.equal(state.draft.observeOnly, DEFAULTS.observeOnly)
  assert.equal(state.dirty, false)
  assert.equal(state.touched, false)
  assert.equal(state.canDiscard, false)
  assert.equal(state.notice, null)
})
/** Collect every element and string in a jsx-runtime tree. */
function collect(node, elements, text) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') { text.push(String(node)); return }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, elements, text)
    return
  }
  if (typeof node === 'object' && node.$$typeof === Symbol.for('react.element')) {
    elements.push(node)
    if (node.type === 'style') return
    if (typeof node.type === 'function') {
      // The page has plain (hook-free) helper components; render them too.
      collect(node.type(node.props), elements, text)
      return
    }
    collect(node.props?.children, elements, text)
  }
}

/** Render the component through the jsx runtime without a DOM renderer. */
function renderForm(client, controller, view = 'page') {
  const tree = client.ConfigForm({ view, controller })
  const elements = [], text = []
  collect(tree, elements, text)
  return { tree, elements, text: text.join(' ') }
}

test('renders exactly twelve fields and keeps save disabled until edited', async () => {
  const client = await loadClient({ render: true })
  const { controller } = await boot()
  const first = renderForm(client, controller)
  const inputs = first.elements.filter(node => node.type === 'input')
  assert.equal(inputs.filter(node => node.props.type === 'checkbox').length, 10)
  assert.equal(inputs.filter(node => node.props.type === 'number').length, 2)
  assert.equal(inputs.length, 12)
  const switches = inputs.filter(node => node.props.type === 'checkbox')
  assert.deepEqual(switches.map(node => node.props.checked), [true, true, ...Array(8).fill(false)])
  const wrappers = first.elements.filter(node => node.props.className === 'dfg-switch-control')
  assert.equal(wrappers.length, 10)
  for (const [i, wrapper] of wrappers.entries()) {
    const [control, track] = wrapper.props.children
    assert.equal(control, switches[i], 'the native input is the sole control')
    assert.equal(control.props.role, 'switch')
    assert.ok(first.elements.some(node => node.type === 'label' && node.props.htmlFor === control.props.id))
    if (control.props['aria-describedby']) {
      assert.ok(first.elements.some(node => node.props.id === control.props['aria-describedby']))
    }
    assert.equal(track.props.className, 'dfg-switch-track')
    assert.equal(track.props['aria-hidden'], 'true')
  }
  const styles = first.elements.find(node => node.type === 'style').props.children
  assert.match(styles, /\.dfg-switch-track\s*\{[^}]*width: 54px;[^}]*height: 30px;[^}]*border-radius: 999px;/s)
  assert.match(styles, /\.dfg-switch:checked \+ \.dfg-switch-track::before\s*\{ transform: translateX\(24px\);/)
  assert.match(styles, /\.dfg-switch:focus-visible \+ \.dfg-switch-track/)
  assert.match(styles, /\.dfg-switch:disabled \+ \.dfg-switch-track/)
  assert.match(styles, /prefers-reduced-motion: reduce/)
  assert.match(styles, /forced-colors: active/)
  assert.match(styles, /--dfg-action-bg: var\(--dsw-alias-label-primary, CanvasText\)/)
  assert.match(styles, /--dfg-action-fg: var\(--dsw-alias-bg-module-platform, Canvas\)/)
  assert.match(styles, /\.dfg-primary\s*\{[^}]*background: var\(--dfg-action-bg\);[^}]*color: var\(--dfg-action-fg\);/)
  assert.match(styles, /\.dfg-primary:disabled\s*\{[^}]*opacity: 1;[^}]*background: transparent;[^}]*color: var\(--dfg-action-bg\);/)
  assert.match(styles, /\.dfg-switch:checked \+ \.dfg-switch-track::before\s*\{[^}]*background-color: var\(--dfg-action-fg\);/)
  for (const label of ['启用连续失败防护', '连续失败上限', '启用复读防护', '连续相同短行上限', '复读后自动续跑', '启用观察模式']) {
    assert.ok(first.text.includes(label), `renders the ${label} label`)
  }
  assert.match(first.text, /提示只是建议，不会强制中断本轮/, 'the stop hint is a notice, not a hard stop')
  const save = first.elements.find(node => node.type === 'button' && node.props.type === 'submit')
  assert.equal(save.props.disabled, true, 'a clean form cannot be submitted')

  controller.edit('failureLimit', '6')
  const second = renderForm(client, controller)
  const saveAfter = second.elements.find(node => node.type === 'button' && node.props.type === 'submit')
  assert.equal(saveAfter.props.disabled, false)
  const limit = second.elements.find(node => node.type === 'input' && node.props.type === 'number')
  assert.equal(limit.props.value, '6')
})

test('renders loading, unavailable, read-only, retry, and summary states', async () => {
  const client = await loadClient({ render: true })

  const loading = await boot({ status: 'loading', value: undefined, writable: false, revision: undefined })
  assert.match(renderForm(client, loading.controller).text, /正在读取配置/)

  const unavailable = await boot({ status: 'unavailable', writable: false })
  assert.match(renderForm(client, unavailable.controller).text, /当前环境未提供这项配置/)

  const readOnly = await boot({ writable: false })
  const readOnlyView = renderForm(client, readOnly.controller)
  assert.match(readOnlyView.text, /只读/)
  const readOnlyInputs = readOnlyView.elements.filter(node => node.type === 'input')
  assert.equal(readOnlyInputs.length, 12)
  assert.ok(readOnlyInputs.every(node => node.props.disabled === true))
  const readOnlySave = readOnlyView.elements.find(node => node.type === 'button' && node.props.type === 'submit')
  assert.equal(readOnlySave.props.disabled, true)

  const retry = await boot()
  retry.controller.edit('failureLimit', '7')
  retry.harness.setHandler(async () => false)
  assert.equal(await retry.controller.save(), false)
  const retryView = renderForm(client, retry.controller)
  const retrySave = retryView.elements.find(node => node.type === 'button' && node.props.type === 'submit')
  assert.equal(retrySave.props.disabled, false)
  assert.match(retryView.text, /重试保存/)
  assert.match(retryView.text, /草稿已保留/)

  assert.equal(renderForm(client, retry.controller, 'summary').tree, null)
})

test('observeOnly switches both hints, disables resume, and saves as one field', async () => {
  const client = await loadClient({ render: true })
  const { controller, harness } = await boot()
  controller.edit('observeOnly', true)

  const view = renderForm(client, controller)
  assert.match(view.text, /只记录命中，不提示、不截断、不续跑/)
  assert.match(view.text, /达到上限时只记录/)
  assert.match(view.text, /只记录，不截断/)
  assert.match(view.text, /观察模式不续跑/)

  const boxes = view.elements.filter(node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(boxes.length, 10)
  assert.equal(boxes[3].props.checked, true, 'the observation switch is on')
  assert.equal(boxes[2].props.disabled, true, 'resume is unavailable while observing')

  assert.equal(await controller.save(), true)
  assert.deepEqual(harness.calls[0].ops, [{ op: 'set', path: ['observeOnly'], value: true }])
})

test('fragment observation has a separate default-off setting and only saves its own field', async () => {
  const client = await loadClient({ render: true })
  const { controller, harness } = await boot()
  const first = renderForm(client, controller)
  const groups = first.elements.filter(node => node.type === 'fieldset')
  const experiment = groups.find(node => node.props.children[0]?.props.children === '实验功能')
  const diagnostics = groups.find(node => node.props.children[0]?.props.children === '复读诊断')
  assert.ok(experiment && diagnostics, 'experiments and diagnostics are separate groups')
  const groupText = node => { const text = []; collect(node, [], text); return text.join(' ') }
  assert.match(groupText(experiment), /观察短碎片复读（实验）/)
  assert.doesNotMatch(groupText(diagnostics), /短碎片/)
  assert.match(groupText(diagnostics), /本地记录复读诊断/)
  assert.match(first.text, /当前生效.*短碎片观察关闭/)
  const control = first.elements.find(node => node.type === 'input' && node.props.id === 'dfg-test-fragment-observe')
  assert.equal(control.props.checked, false)
  control.props.onChange({ currentTarget: { checked: true } })
  const changed = renderForm(client, controller)
  assert.match(changed.text, /当前生效.*短碎片观察关闭.*未保存预览.*短碎片观察开启/)
  assert.equal(controller.getState().effective.fragmentObserveEnabled, false)
  assert.equal(await controller.save(), true)
  assert.deepEqual(harness.calls[0].ops, [{ op: 'set', path: ['fragmentObserveEnabled'], value: true }])
  assert.match(renderForm(client, controller).text, /当前生效.*短碎片观察开启/)
})

test('fragment-only summary exposes a count but cannot query an automatic report', async () => {
  const client = await loadClient({ render: true })
  const fragment = { turn: 1, rule: 'fragment', count: 8, action: 'observed' }
  const reportForTurn = () => { throw Error('must load only on explicit user request') }
  const assertTail = (hits, hasLoader) => {
    const elements = [], texts = []
    collect(client.GuardActivityTail({ turn: { turn: 1 }, useProjection: () => hits, reportForTurn }), elements, texts)
    const panel = elements.find(node => node.type === client.DiagnosticPanel)
    assert.equal(typeof panel.props.load === 'function', hasLoader)
    assert.match(texts.join(' '), /短碎片疑似复读 8 段（仅观察）/)
  }
  assertTail([fragment], false)
  assertTail([fragment, { turn: 1, rule: 'repeat', count: 5, action: 'cut' }], true)
  assert.equal(client.summarizeActivity([{ ...fragment, action: 'cut' }, { ...fragment, count: 129 }], 1), null)
})

test('saved mode and draft preview stay distinct through a rejected save', async () => {
  const client = await loadClient({ render: true })
  const { controller, harness } = await boot()
  assert.match(renderForm(client, controller).text, /当前生效\s+正常防护/)
  controller.edit('observeOnly', true)
  assert.match(renderForm(client, controller).text, /未保存预览\s+仅观察/)
  harness.setHandler(async () => false)
  assert.equal(await controller.save(), false)
  assert.match(renderForm(client, controller).text, /当前生效\s+正常防护/)
  harness.setHandler(null)
  assert.equal(await controller.save(), true)
  const saved = renderForm(client, controller)
  assert.match(saved.text, /当前生效\s+仅观察/)
  assert.doesNotMatch(saved.text, /未保存预览/)
})

test('self-check reads effective state only and clears stale results after save', async () => {
  const client = await loadClient({ render: true })
  const { controller, harness } = await boot()
  controller.edit('observeOnly', true)
  const before = renderForm(client, controller)
  const run = before.elements.find(node => node.type === 'button' && node.props.children === '运行自检')
  assert.equal(run.props.type, 'button')
  await controller.selfCheck()
  assert.ok(renderForm(client, controller).text.includes('会发送停手提示'))
  assert.ok(renderForm(client, controller).text.includes('会截断复读'))
  assert.equal(harness.calls.length, 0)
  assert.equal(await controller.save(), true)
  assert.equal(controller.getState().selfCheck, null)
  await controller.selfCheck()
  assert.equal(controller.getState().selfCheck.kind, 'result')
  assert.ok(controller.getState().selfCheck.results.every(row => row.action === 'observed'))
  assert.equal(harness.calls.length, 1)
})

test('activity summary keeps only the closing turn and combines at most two rules', async () => {
  const client = await loadClient()
  const hits = [
    { turn: 1, rule: 'failure', count: 9, action: 'notified' },
    { turn: 2, rule: 'failure', count: 3, action: 'notified' },
    { turn: 2, rule: 'repeat', count: 5, action: 'cut' },
  ]
  assert.equal(client.summarizeActivity(hits, 2), '连续失败 3 次（已提示停手） · 复读 5 行（已截断）')
  assert.equal(client.summarizeActivity(hits, 3), null, 'another turn renders nothing')
  assert.equal(client.summarizeActivity(undefined, 2), null, 'a missing projection renders nothing')
  assert.equal(client.summarizeActivity(null, 2), null)
  assert.equal(client.summarizeActivity([{ turn: 2, rule: 'repeat', count: 4, action: 'notified' }], 2), null,
    'a rule/action pair outside the wire schema is ignored')
  assert.equal(client.summarizeActivity([{ turn: 2, rule: 'failure', count: 2, action: 'observed' }], 2),
    '连续失败 2 次（仅记录）')
  assert.equal(client.summarizeActivity([{ turn: 2, rule: 'repeat', count: 4, action: 'observed' }], 2),
    '复读 4 行（仅记录）')
})

test('turn-tail component reads the shared activity key and renders one line', async () => {
  const client = await loadClient({ render: true })
  const base = { turn: { turn: 2 }, seq: 9 }
  assert.equal(client.GuardActivityTail(base), null, 'a host without the projection reader renders nothing')
  let seenKey
  assert.equal(client.GuardActivityTail({
    ...base,
    useProjection: (key) => { seenKey = key; return [] },
  }), null)
  assert.equal(seenKey, 'dsh-fail-guard:activity', 'the shared projection key is used')

  assert.equal(client.GuardActivityTail({
    ...base,
    useProjection: () => [{ turn: 1, rule: 'failure', count: 3, action: 'notified' }],
  }), null, 'a hit from another turn renders nothing')

  const tree = client.GuardActivityTail({
    ...base,
    useProjection: () => [
      { turn: 2, rule: 'failure', count: 3, action: 'observed' },
      { turn: 2, rule: 'repeat', count: 5, action: 'cut' },
    ],
  })
  const elements = [], text = []
  collect(tree, elements, text)
  assert.match(text.join(' '), /防护/)
  assert.match(text.join(' '), /连续失败 3 次（仅记录） · 复读 5 行（已截断）/)
  assert.equal(elements.filter(node => node.type === 'style').length, 1)
})

test('registered turn tail previews the package version for a manual report without a loader', async () => {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const client = await loadClient({ render: true })
  const { ctx, registrations } = createContext(createFormHarness())
  client.apply(ctx)
  const tail = registrations.find(entry => entry.options.name === 'conversation.chat.turnTail')
  assert.ok(tail)
  const elements = []
  collect(tail.component({
    ...tail.options.inject('synthetic-fixture'),
    turn: { turn: 1 },
    useProjection: () => [],
  }), elements, [])
  assert.equal(elements.find(node => node.type === client.DiagnosticPanel)?.props.load, undefined)
  const preview = elements.find(node => node.type === 'pre' && node.props.className === 'dfg-diag-pre')
  assert.ok(preview, 'the built panel renders a JSON preview')
  assert.deepEqual(JSON.parse(preview.props.children), { version: 1, kind: 'manual', pluginVersion: version })
})

test('diagnostic RPC uses the injected namespace and only reads on demand', async () => {
  const client = await loadClient()
  const { ctx, registrations } = createContext(createFormHarness())
  const calls = []
  const unavailable = () => { throw Error('cannot get property "remote.guardDiagnostics" without inject') }
  let namespace
  let stopMount
  let stopReader
  let connect
  const rpc = { async getReport(request) { calls.push(JSON.parse(JSON.stringify(request))); return { ok: true, value: null } } }
  ctx.inject = (dependencies, mount) => {
    assert.deepEqual(Array.from(dependencies), ['remote'])
    mount({
      inject(deps, use) {
        assert.deepEqual(Array.from(deps), ['remote.guardDiagnostics'])
        connect = () => use({ get(key) { assert.equal(key, 'remote.guardDiagnostics'); return namespace }, effect(run) { stopReader = run() } })
      },
      get(key) {
        assert.equal(key, 'remote')
        return {
          get guardDiagnostics() { return unavailable() },
          async $mount(contribution) {
            assert.equal(contribution.descriptors[0].id, 'dsh-fail-guard#guardDiagnostics/getReport')
            namespace = rpc
            connect?.()
            return async () => { namespace = undefined; stopReader?.() }
          },
        }
      },
      effect(run) { stopMount = run() },
    })
  }
  client.apply(ctx)
  const tail = registrations.find(entry => entry.options.name === 'conversation.chat.turnTail')
  const { reportForTurn } = tail.options.inject('synthetic-fixture')
  await Promise.resolve()
  assert.deepEqual(calls, [])
  assert.equal(await reportForTurn(2), null)
  assert.deepEqual(calls, [{ sessionId: 'synthetic-fixture', turn: 2 }])
  stopMount()
  await assert.rejects(reportForTurn(2), /本地诊断读取暂不可用/)
  assert.equal(calls.length, 1)
})

test('built turn feedback exports only the previewed fields on an explicit click', async () => {
  const state = [], saves = []
  let cursor = 0, blob
  const reject = () => { throw Error('feedback must not send network requests') }
  const client = await loadClient({ render: true, useState(initial) {
    const i = cursor++
    if (!(i in state)) state[i] = initial
    return [state[i], value => { state[i] = value }]
  }, browser: {
    Blob, fetch: reject, XMLHttpRequest: reject,
    URL: { createObjectURL(value) { blob = value; return 'blob:fixture' }, revokeObjectURL() {} },
    document: { body: { appendChild() {} }, createElement() { return {
      style: {}, click() { saves.push({ file: this.download, blob }) }, remove() {},
    } } },
  } })
  const hits = [{ turn: 1, rule: 'fragment', count: 8, action: 'observed', note: 'private marker', sessionId: 'private ID' }]
  const render = (projection = hits) => {
    cursor = 0
    const nodes = [], text = []
    collect(client.GuardActivityTail({turn:{turn:1}, useProjection:()=>projection, reportForTurn:reject}), nodes, text)
    const feedback = nodes.find(n=>n.type==='details'&&n.props.className==='dfg-feedback')
    const panel = nodes.find(n=>n.type==='details'&&n.props.className==='dfg-diag-details')
    const form = [], formText = []
    if (feedback) collect(feedback, form, formText)
    const find = (type, suffix) => form.find(n=>n.type===type&&n.props.id?.endsWith(suffix))
    const preview = form.find(n=>n.type==='pre')?.props.children
    return { panel, feedback, find, preview,
      options: form.filter(n=>n.type==='option').map(n=>n.props.value),
      checks: form.filter(n=>n.type==='input'&&n.props.type==='checkbox'),
      download: form.find(n=>n.type==='button'&&n.props.children==='下载反馈 JSON') }
  }
  const choose = (el, value) => el.props.onChange({currentTarget:{value}})
  assert.equal(render().feedback, undefined, 'feedback is not mounted while diagnostics is closed')
  render().panel.props.onToggle({currentTarget:{open:true}})
  assert.equal(render().preview, undefined)
  assert.equal(render().download, undefined)
  choose(render().find('select','-rule'),'fragment')
  assert.ok(render().options.includes('correct_hit')&&render().options.includes('false_positive'))
  assert.ok(!render().options.includes('false_negative'))
  choose(render().find('select','-label'),'correct_hit')
  const {version} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(JSON.parse(render().preview), { version:1, kind:'feedback', rule:'fragment', label:'correct_hit', detection:'recorded_hit', enablement:'observed_enabled', exporterVersion:version, count:8, action:'observed' })
  choose(render().find('select','-label'),'false_positive')
  for(const input of render().checks) input.props.onChange({currentTarget:{checked:false}})
  const reduced = render().preview
  assert.deepEqual(JSON.parse(reduced), {version:1, kind:'feedback', rule:'fragment', label:'false_positive', detection:'recorded_hit', enablement:'observed_enabled'})
  assert.deepEqual(saves, [])
  render().download.props.onClick()
  assert.equal(saves.length,1)
  assert.match(saves[0].file,/^dsh-fail-guard-feedback-\d{8}-\d{6}\.json$/)
  assert.deepEqual(Buffer.from(await saves[0].blob.arrayBuffer()), Buffer.from(reduced,'utf8'))
  const noHits = () => render([])
  assert.equal(noHits().download,undefined,'stale hit label cannot be exported')
  assert.ok(noHits().options.includes('false_negative')&&!noHits().options.includes('false_positive'))
  choose(noHits().find('select','-label'),'false_negative')
  choose(noHits().find('select','-enabled'),'enabled')
  assert.deepEqual(JSON.parse(noHits().preview), {version:1,kind:'feedback',rule:'fragment',label:'false_negative',detection:'unknown',enablement:'reported_enabled'})
  assert.equal(saves.length,1)
  noHits().download.props.onClick()
  assert.equal(saves.length,2)
  assert.deepEqual(Buffer.from(await saves[1].blob.arrayBuffer()), Buffer.from(noHits().preview,'utf8'))
})
