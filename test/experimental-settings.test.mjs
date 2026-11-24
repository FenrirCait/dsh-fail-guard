/**
 * The four experimental switches on the bundle configuration page: independent,
 * default-off settings inside the experiments group, each saved as its own
 * field by the same drafted/effective/atomic path as the other switches, and
 * each explained with what it records and what it never does. The built bundle
 * (lib/client.js) is evaluated the way the Host loads it; set
 * GUARD_CLIENT_BUNDLE to point at an isolated build.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import { DEFAULTS } from '../src/options.ts'

const DEFAULT_BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/** The four experimental fields, in page order. */
const EXPERIMENTS = [
  'fuzzyObserveEnabled',
  'crossTurnObserveEnabled',
  'activeSteerEnabled',
  'stopSimulationEnabled',
]

/** The ids each experimental row renders with (useId is stubbed to dfg-test). */
const EXPERIMENT_IDS = {
  fuzzyObserveEnabled: 'dfg-test-fuzzy-observe',
  crossTurnObserveEnabled: 'dfg-test-cross-turn-observe',
  activeSteerEnabled: 'dfg-test-active-steer',
  stopSimulationEnabled: 'dfg-test-stop-simulation',
}

/**
 * Evaluate lib/client.js the way the Host's module loader does and return the
 * factory's exports (apply, inject, ConfigForm, BUNDLE_CONFIG_SLOT).
 * @returns the bundle's module namespace.
 */
async function loadClient({ render = false } = {}) {
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
        useState: (initial) => [initial, () => {}],
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
    throw new Error('unexpected module request: ' + specifier)
  }
  let loaded
  const window = { __ModuleLoader__: { load(definition) { loaded = definition } } }
  const context = vm.createContext({ window: { ...window, setTimeout }, require: requireStub, console })
  new vm.Script(source, { filename: 'lib/client.js' }).runInContext(context)
  assert.ok(loaded, 'the bundle called window.__ModuleLoader__.load')
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
  const registrations = []
  const ctx = {
    slots: {
      inject(_name, callback) { return callback() },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
    configForms: { get() { return harness.form } },
    inject() {},
    effect(factory) {
      const disposer = factory()
      return () => { if (typeof disposer === 'function') disposer() }
    },
  }
  return { ctx, registrations }
}

/** Load the bundle, apply it to a fresh context, and expose the controller. */
async function boot(overrides = {}) {
  const client = await loadClient()
  const harness = createFormHarness(overrides)
  const env = createContext(harness)
  client.apply(env.ctx)
  const config = env.registrations.find(entry => entry.options.name === 'plugins.bundle.config')
  assert.ok(config, 'the bundle configuration page is registered')
  return { client, harness, controller: config.options.inject().controller }
}

/** A complete Host section with the four experiments explicitly off. */
function hostValue(patch = {}) {
  return {
    ...DEFAULTS,
    fuzzyObserveEnabled: false,
    crossTurnObserveEnabled: false,
    activeSteerEnabled: false,
    stopSimulationEnabled: false,
    ...patch,
  }
}

/** The same section with the experimental keys removed (an older accepted value). */
function withoutExperiments(value) {
  const copy = { ...value }
  for (const key of EXPERIMENTS) delete copy[key]
  return copy
}

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

/** The text inside one subtree. */
function textOf(node) {
  const text = []
  collect(node, [], text)
  return text.join(' ')
}

/** The switch input with one id. */
function inputById(view, id) {
  const input = view.elements.find(node => node.type === 'input' && node.props.id === id)
  assert.ok(input, 'renders input ' + id)
  return input
}

/** The hint paragraph wired to one switch through aria-describedby. */
function hintOf(view, id) {
  const input = inputById(view, id)
  const describedBy = input.props['aria-describedby']
  assert.ok(describedBy, id + ' is described by a hint')
  const hint = view.elements.find(node => node.props?.id === describedBy)
  assert.ok(hint, 'the hint element exists for ' + id)
  return textOf(hint)
}

/** The fieldset whose legend is the given group title. */
function groupOf(view, legend) {
  const group = view.elements.filter(node => node.type === 'fieldset')
    .find(node => node.props.children[0]?.props.children === legend)
  assert.ok(group, 'renders the ' + legend + ' group')
  return group
}

test('renders the four experimental switches, default off, inside the experiments group', async () => {
  const client = await loadClient({ render: true })
  const { controller } = await boot({ value: hostValue() })
  const view = renderForm(client, controller)

  const experiment = groupOf(view, '实验功能')
  for (const name of EXPERIMENTS) {
    const box = inputById(view, EXPERIMENT_IDS[name])
    assert.equal(box.props.type, 'checkbox', name + ' is a pill switch')
    assert.equal(box.props.role, 'switch')
    assert.equal(box.props.checked, false, name + ' starts off')
    assert.equal(box.props.disabled, false, name + ' is editable')
    assert.ok(view.elements.some(node => node.type === 'label' && node.props.htmlFor === box.props.id), name + ' has a label')
    assert.ok(hintOf(view, EXPERIMENT_IDS[name]).length > 0, name + ' has a hint')
  }
  const experimentInputs = []
  collect(experiment, experimentInputs, [])
  assert.deepEqual(
    experimentInputs.filter(node => node.type === 'input').map(node => node.props.id),
    ['dfg-test-fragment-observe', ...EXPERIMENTS.map(name => EXPERIMENT_IDS[name])],
    'the experiments group holds the fragment toggle plus the four new switches, in page order',
  )
})

test('keeps the six existing switches and appends the four experiments', async () => {
  const client = await loadClient({ render: true })
  const { controller } = await boot({ value: hostValue() })
  const view = renderForm(client, controller)
  const boxes = view.elements.filter(node => node.type === 'input' && node.props.type === 'checkbox')
  assert.deepEqual(boxes.map(node => node.props.id), [
    'dfg-test-failure-enabled',
    'dfg-test-repeat-enabled',
    'dfg-test-resume-on-repeat',
    'dfg-test-observe-only',
    'dfg-test-fragment-observe',
    'dfg-test-fuzzy-observe',
    'dfg-test-cross-turn-observe',
    'dfg-test-active-steer',
    'dfg-test-stop-simulation',
    'dfg-test-diagnostics',
  ])
  assert.deepEqual(boxes.map(node => node.props.checked), [
    DEFAULTS.failureEnabled,
    DEFAULTS.repeatEnabled,
    DEFAULTS.resumeOnRepeat,
    DEFAULTS.observeOnly,
    false,
    false,
    false,
    false,
    false,
    false,
  ])
})

test('reads the four flags from the Host section and treats an absent key as off', async () => {
  const client = await loadClient({ render: true })
  const on = await boot({ value: hostValue({ fuzzyObserveEnabled: true, crossTurnObserveEnabled: true }) })
  const state = on.controller.getState()
  assert.equal(state.draft.fuzzyObserveEnabled, true)
  assert.equal(state.draft.crossTurnObserveEnabled, true)
  assert.equal(state.draft.activeSteerEnabled, false)
  assert.equal(state.draft.stopSimulationEnabled, false)
  assert.equal(state.effective.fuzzyObserveEnabled, true)
  assert.equal(state.effective.stopSimulationEnabled, false)
  const view = renderForm(client, on.controller)
  assert.equal(inputById(view, 'dfg-test-fuzzy-observe').props.checked, true)
  assert.equal(inputById(view, 'dfg-test-stop-simulation').props.checked, false)
  assert.match(view.text, /实验开关.*模糊复读仅记录.*跨轮重复仅记录.*主动引导关闭.*模拟停手记录关闭/)

  const absent = await boot({ value: withoutExperiments(DEFAULTS) })
  const absentState = absent.controller.getState()
  for (const name of EXPERIMENTS) assert.equal(absentState.draft[name], false, name + ' defaults off')
  assert.equal(absentState.effective.fuzzyObserveEnabled, false)
  assert.equal(absentState.dirty, false, 'an older section is not a pending write')
  assert.equal(await absent.controller.save(), false)
  assert.equal(absent.harness.calls.length, 0)
})

test('saves each experimental switch alone as one atomic mutation', async () => {
  for (const name of EXPERIMENTS) {
    const { controller, harness } = await boot({ value: hostValue() })
    controller.edit(name, true)
    assert.equal(controller.getState().dirty, true, name + ' makes the draft dirty')
    assert.equal(controller.getState().canSave, true)
    assert.equal(await controller.save(), true)
    assert.equal(harness.calls.length, 1, name + ' writes once')
    assert.deepEqual(harness.calls[0].ops, [{ op: 'set', path: [name], value: true }])
    const state = controller.getState()
    assert.equal(state.effective[name], true)
    for (const other of EXPERIMENTS.filter(key => key !== name)) {
      assert.equal(state.effective[other], false, other + ' is not written with ' + name)
    }
    assert.equal(state.draft[name], true)
    assert.equal(state.dirty, false)
  }
})

test('writes several experiment edits in page order', async () => {
  const { controller, harness } = await boot({ value: hostValue() })
  controller.edit('stopSimulationEnabled', true)
  controller.edit('fuzzyObserveEnabled', true)
  assert.deepEqual(harness.calls, [])
  assert.equal(await controller.save(), true)
  assert.deepEqual(harness.calls[0].ops, [
    { op: 'set', path: ['fuzzyObserveEnabled'], value: true },
    { op: 'set', path: ['stopSimulationEnabled'], value: true },
  ])
})

test('keeps the saved and previewed experiment lines distinct until accepted', async () => {
  const client = await loadClient({ render: true })
  const { controller } = await boot({ value: hostValue() })
  controller.edit('fuzzyObserveEnabled', true)
  const pending = renderForm(client, controller)
  assert.match(pending.text, /实验开关.*模糊复读不观察/)
  assert.match(pending.text, /未保存预览/)
  assert.match(pending.text, /实验项预览.*模糊复读仅记录/)
  assert.equal(await controller.save(), true)
  const saved = renderForm(client, controller)
  assert.match(saved.text, /实验开关.*模糊复读仅记录/)
  assert.doesNotMatch(saved.text, /未保存预览/)
  assert.doesNotMatch(saved.text, /实验项预览/)
})

test('observation mode suppresses active steer but leaves the observing switches usable', async () => {
  const client = await loadClient({ render: true })
  const { controller } = await boot({ value: hostValue({ activeSteerEnabled: true }) })
  controller.edit('observeOnly', true)
  const view = renderForm(client, controller)
  assert.equal(inputById(view, 'dfg-test-active-steer').props.disabled, true)
  assert.equal(inputById(view, 'dfg-test-resume-on-repeat').props.disabled, true)
  for (const name of ['fuzzyObserveEnabled', 'crossTurnObserveEnabled', 'stopSimulationEnabled']) {
    assert.equal(inputById(view, EXPERIMENT_IDS[name]).props.disabled, false, name + ' stays editable')
  }
  assert.match(view.text, /实验开关.*主动引导开启（观察抑制）/)
  assert.equal(await controller.save(), true)
  const notice = controller.getState().notice
  assert.equal(notice.kind, 'saved')
  assert.equal(notice.text, '已保存。')
})

test('each experimental hint states what the switch does and does not do', async () => {
  const client = await loadClient({ render: true })
  const { controller } = await boot({ value: hostValue() })
  const view = renderForm(client, controller)
  assert.match(hintOf(view, 'dfg-test-fuzzy-observe'), /整行相近但不完全相同的复读只在回合末计数/)
  assert.match(hintOf(view, 'dfg-test-fuzzy-observe'), /不提示模型、不截断、不续跑/)
  assert.match(hintOf(view, 'dfg-test-cross-turn-observe'), /相邻回合重复同一操作（同一工具、同一参数）只在回合末计数/)
  assert.match(hintOf(view, 'dfg-test-cross-turn-observe'), /不提示模型、不拦截工具调用/)
  assert.match(hintOf(view, 'dfg-test-active-steer'), /只在现有精确复读已截断的回合收尾发送一次引导/)
  assert.match(hintOf(view, 'dfg-test-active-steer'), /每轮最多一次/)
  assert.match(hintOf(view, 'dfg-test-active-steer'), /与「复读后自动续跑」互斥/)
  assert.match(hintOf(view, 'dfg-test-active-steer'), /观察模式下不发送/)
  assert.match(hintOf(view, 'dfg-test-stop-simulation'), /只生成一条模拟停手记录/)
  assert.match(hintOf(view, 'dfg-test-stop-simulation'), /不会取消本轮、不会取消工具调用/)
  assert.match(textOf(groupOf(view, '实验功能')), /观察类开关只记录命中/)
})

test('a read-only or saving host disables the experimental switches', async () => {
  const client = await loadClient({ render: true })
  const readOnly = await boot({ value: hostValue(), writable: false })
  const readOnlyView = renderForm(client, readOnly.controller)
  const readOnlyBoxes = readOnlyView.elements.filter(node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(readOnlyBoxes.length, 10)
  assert.ok(readOnlyBoxes.every(node => node.props.disabled === true))
  for (const name of EXPERIMENTS) assert.equal(inputById(readOnlyView, EXPERIMENT_IDS[name]).props.disabled, true)
  assert.match(readOnlyView.text, /只读/)

  const saving = await boot({ value: hostValue() })
  let release
  saving.harness.setHandler(() => new Promise((resolve) => { release = resolve }))
  saving.controller.edit('fuzzyObserveEnabled', true)
  const pending = saving.controller.save()
  const savingView = renderForm(client, saving.controller)
  assert.equal(saving.controller.getState().saving, true)
  for (const name of EXPERIMENTS) assert.equal(inputById(savingView, EXPERIMENT_IDS[name]).props.disabled, true)
  release(true)
  assert.equal(await pending, true)
  assert.equal(saving.controller.getState().saving, false)
})

test('keeps an edited experiment after a refused write and retries on the latest revision', async () => {
  const client = await loadClient({ render: true })
  const { controller, harness } = await boot({ value: hostValue() })
  controller.edit('stopSimulationEnabled', true)
  harness.setHandler(async () => false)
  assert.equal(await controller.save(), false)
  const refused = controller.getState()
  assert.equal(refused.notice.kind, 'conflict')
  assert.equal(harness.calls[0].expectedRevision, 7)
  assert.equal(refused.draft.stopSimulationEnabled, true, 'the refused draft survives')
  assert.equal(refused.effective.stopSimulationEnabled, false)
  const refusedView = renderForm(client, controller)
  assert.equal(inputById(refusedView, 'dfg-test-stop-simulation').props.checked, true)
  assert.match(refusedView.text, /实验项预览.*模拟停手记录开启/)

  harness.setHandler(null)
  assert.equal(await controller.save(), true)
  assert.equal(harness.calls.length, 2)
  assert.equal(harness.calls[1].expectedRevision, undefined, 'the retry lets the Host supply its latest revision')
  assert.deepEqual(harness.calls[1].ops, [{ op: 'set', path: ['stopSimulationEnabled'], value: true }])
  assert.equal(controller.getState().effective.stopSimulationEnabled, true)
})

test('names why active steer cannot fire: observation, resume, or nothing', async () => {
  const client = await loadClient({ render: true })
  const resume = await boot({ value: hostValue({ activeSteerEnabled: true, resumeOnRepeat: true }) })
  const resumeView = renderForm(client, resume.controller)
  assert.match(resumeView.text, /实验开关.*主动引导开启（续跑优先）/)
  assert.equal(inputById(resumeView, 'dfg-test-active-steer').props.disabled, false, 'the switch stays independent')

  const observing = await boot({ value: hostValue({ activeSteerEnabled: true, observeOnly: true }) })
  assert.match(renderForm(client, observing.controller).text, /实验开关.*主动引导开启（观察抑制）/)

  const plain = await boot({ value: hostValue({ activeSteerEnabled: true, repeatEnabled: false, resumeOnRepeat: true }) })
  assert.match(renderForm(client, plain.controller).text, /实验开关.*主动引导开启(?!（)/)
})

test('turning an experimental switch off writes only that field', async () => {
  const { controller, harness } = await boot({
    value: hostValue({ fuzzyObserveEnabled: true, activeSteerEnabled: true }),
  })
  controller.edit('fuzzyObserveEnabled', false)
  assert.equal(await controller.save(), true)
  assert.deepEqual(harness.calls[0].ops, [{ op: 'set', path: ['fuzzyObserveEnabled'], value: false }])
  const state = controller.getState()
  assert.equal(state.effective.fuzzyObserveEnabled, false)
  assert.equal(state.effective.activeSteerEnabled, true, 'the other experiment keeps its value')
})
