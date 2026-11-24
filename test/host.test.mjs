import assert from 'node:assert/strict';
import test from 'node:test';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { Session, pluginRecordOf } from '@deepseek-ai/dsh-session';
import { foldActivity } from '../lib/activity.js';
import { apply, Config, name } from '../lib/index.js';
import { DEFAULTS, ENTRY_ID } from '../lib/options.js';

function events() {
  const listeners = new Map();
  return {
    listeners,
    on(name, handler) {
      assert.ok(!listeners.has(name));
      listeners.set(name, handler);
      return () => listeners.delete(name);
    },
    dispatch(name, ...args) { return listeners.get(name)?.(...args); },
  };
}

function fixture(overrides = {}) {
  const host = events();
  const agentEvents = events();
  const session = Session.create('fixture-session');
  const messages = [];
  const agent = { session, ctx: agentEvents, steer: m => messages.push(m), cancel: () => assert.fail('the guard must not cancel the turn') };
  const scope = { ...host, agents: { list: () => [agent] }, inject() {}, effect(f) { this.cleanup = f(); } };
  apply(scope, Config(overrides));
  const event = (type, data, surfaceOp) => agentEvents.dispatch('session/event', session, { type, data, surfaceOp });
  const begin = (turn = 1) => event('turn/start', { turn });
  const end = (turn = 1, kind = 'completed') => event('turn/end', { turn, reason: { kind } });
  let id = 0;
  const result = ({ turn = 1, step = 1, tool = 'fixture', args = '{}', isError = true, meta, surfaceOp } = {}) => {
    const callId = 'call-' + ++id;
    event('tool/call', { turn, step, callId, name: tool, arguments: args });
    event('tool/result', { turn, step, message: { toolCallId: callId, isError }, meta }, surfaceOp);
  };
  const stopping = (turn = 1, signal = new AbortController().signal) => host.dispatch('agent/turn-stopping', { agent, turn, signal });
  const stream = (source, options = {}) => host.dispatch('llm/stream', { sessionId: session.id, ...options }, () => source);
  return { scope, host, agent, session, agentEvents, messages, begin, end, result, stopping, stream };
}

function repetitive() {
  const text = '这里需要核对一次构建记录。';
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: (text + '\n').repeat(6) },
    { type: 'reasoning-delta', index: 0, text: '然后核对输出。' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: (text + '\n').repeat(6) + '然后核对输出。' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}
const iterable = chunks => (async function* () { yield* chunks; })();

test('single fresh configuration schema has only the supported options', () => {
  assert.equal(name, 'dsh-fail-guard');
  assert.equal(ENTRY_ID, 'dsh-fail-guard-standalone');
  const live = Config({});
  assert.deepEqual(Object.keys(live).sort(), Object.keys(DEFAULTS).sort());
  assert.deepEqual(Object.fromEntries(Object.keys(live).map(k => [k, live[k].get()])), DEFAULTS);
});

test('matched failures steer once; a new turn starts a fresh streak', () => {
  const f = fixture();
  f.begin();
  f.result(); f.result();
  assert.equal(f.messages.length, 0);
  f.result(); f.result();
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].source.kind, 'plugin:fail-guard-standalone');
  f.begin(2);
  for (let i = 0; i < 3; i++) f.result({ turn: 2 });
  assert.equal(f.messages.length, 2);
});

test('shell metadata counts, history replacements do not', () => {
  const f = fixture({ failureLimit: 2 });
  f.begin();
  f.result({ surfaceOp: { op: 'replace' } });
  f.result({ isError: false, meta: { opsShell: { exitCode: 1 } } });
  assert.equal(f.messages.length, 0);
  f.result({ isError: false, meta: { opsShell: { exitCode: '2' } } });
  assert.equal(f.messages.length, 1);
});

test('both feature toggles disable their corresponding hooks', async () => {
  const f = fixture({ failureEnabled: false, repeatEnabled: false });
  f.begin();
  for (let i = 0; i < 5; i++) f.result();
  const source = iterable(repetitive());
  assert.equal(f.stream(source), source);
  assert.equal(f.messages.length, 0);
});

test('auxiliary and unattributed streams are passed through unchanged', () => {
  const f = fixture();
  f.begin();
  const source = iterable(repetitive());
  assert.equal(f.stream(source, { purpose: 'title' }), source);
  assert.equal(f.stream(source, { sessionId: undefined }), source);
});

test('normal turn cuts repeat; no automatic resume by default', async () => {
  const f = fixture();
  f.begin();
  const input = repetitive();
  const output = await Array.fromAsync(f.stream(iterable(input)));
  assert.deepEqual(output, [input[0], input[1], input.at(-1)]);
  const assembler = new BlockAssembler();
  for (const frame of output) assembler.push(frame);
  assert.equal(assembler.finish.kind, 'stop');
  assert.deepEqual(assembler.blocks(), [{ type: 'reasoning', text: input[1].text }]);
  f.stopping();
  assert.equal(f.messages.length, 0);
});

test('optional resume is once per turn; failure notification takes precedence', async () => {
  const f = fixture({ resumeOnRepeat: true, failureLimit: 2 });
  f.begin();
  await Array.fromAsync(f.stream(iterable(repetitive())));
  f.stopping(1, AbortSignal.abort());
  assert.equal(f.messages.length, 0);
  f.stopping(); f.stopping();
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].source.summary, /续跑一次/);
  f.begin(2);
  await Array.fromAsync(f.stream(iterable(repetitive())));
  f.result({ turn: 2 }); f.result({ turn: 2 });
  f.stopping(2);
  assert.equal(f.messages.length, 2);
  assert.equal(f.messages[1].source.summary, '连续失败防护');
});

test('failure notice does not disable a later repetition cut in the same turn', async () => {
  const f = fixture({ resumeOnRepeat: true, failureLimit: 2 });
  f.begin();
  f.result(); f.result();
  assert.deepEqual(f.messages.map(message => message.source.summary), ['连续失败防护']);
  const input = repetitive();
  const source = iterable(input);
  const guarded = f.stream(source);
  assert.notEqual(guarded, source);
  assert.deepEqual(await Array.fromAsync(guarded), [input[0], input[1], input.at(-1)]);
  f.stopping(); f.stopping();
  assert.deepEqual(f.messages.map(message => message.source.summary), ['连续失败防护']);
});

test('observe only preserves the original stream and emits display-only records for both rules', async () => {
  const f = fixture({ observeOnly: true, resumeOnRepeat: true });
  f.begin();
  for (let i = 0; i < 6; i++) f.result({ tool: 'fixture-tool-private' });
  const input = repetitive();
  const output = await Array.fromAsync(f.stream(iterable(input)));
  assert.deepEqual(output, input);
  assert.equal(output.every((frame, i) => frame === input[i]), true);
  f.stopping(); f.stopping();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.messages, []);
  const events = f.session.snapshotEvents();
  const expected = [{ turn: 1, rule: 'failure', count: 3, action: 'observed' },
    { turn: 1, rule: 'repeat', count: 6, action: 'observed' }];
  assert.deepEqual(events.map(event => pluginRecordOf(event)?.data), expected);
  assert.deepEqual(events.reduce(foldActivity, []), expected);
  assert.ok(events.every(e => e.ignorable === true && e.surfaceOp === undefined));

  // Feed the real folded records to the built client, not a second fixture.
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const react = await import('react');
  const jsx = await import('react/jsx-runtime');
  let registration;
  const window = { __ModuleLoader__: { load(entry) { registration = entry; } } };
  runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), { window });
  assert.equal(registration.id, 'dsh-fail-guard');
  const client = registration.factory(id => {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return jsx;
    throw new Error('Unexpected client dependency: ' + id);
  });
  const view = events.reduce(foldActivity, []);
  const useProjection = key => {
    assert.equal(key, 'dsh-fail-guard:activity');
    return view;
  };
  const tail = client.GuardActivityTail({ turn: { turn: 1 }, useProjection });
  const summary = tail.props.children.find(node => node.props.className === 'dfg-tail-text');
  assert.equal(summary.props.children, '连续失败 3 次（仅记录） · 复读 6 行（仅记录）');
  assert.equal(client.GuardActivityTail({ turn: { turn: 2 }, useProjection }), null);
});

test('enforcement records notifications and cuts as separate actions without content', async () => {
  const f = fixture();
  f.begin();
  for (let i = 0; i < 3; i++) f.result();
  await Array.fromAsync(f.stream(iterable(repetitive())));
  await new Promise(resolve => setImmediate(resolve));
  const events = f.session.snapshotEvents();
  assert.deepEqual(events.reduce(foldActivity, []), [
    { turn: 1, rule: 'failure', count: 3, action: 'notified' },
    { turn: 1, rule: 'repeat', count: 6, action: 'cut' },
  ]);
});

test('projection ignores malformed data, limits history and deduplicates actions', () => {
  const evt = data => ({type: 'plugin:dsh-fail-guard/hit', ignorable: true, seq: 0, time: 0, data});
  const start = [];
  assert.equal(foldActivity(start, evt({turn: 1, rule: 'failure', count: 2, action: 'cut'})), start);
  let state = start;
  for (let turn = 0; turn < 300; turn++) state = foldActivity(state, evt({turn, rule: 'repeat', count: 5, action: 'observed'}));
  assert.equal(state.length, 256);
  assert.equal(state[0].turn, 44);
  assert.equal(foldActivity(state, evt(state.at(-1))), state);
  assert.equal(foldActivity(state, evt({...state.at(-1), action: 'cut'})).at(-1).action, 'cut');
});

const fragmented = () => {
  const text = '做。\n好。\n执行。\n'.repeat(4);
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
};

for (const enabled of [false, true]) {
  test('fragment observation preserves identical frames and dedupes per turn: ' + enabled, async () => {
    const f = fixture({ fragmentObserveEnabled: enabled, repeatEnabled: false, resumeOnRepeat: true });
    for (const turn of [1, 2]) {
      f.begin(turn);
      for (const purpose of ['fixture-aux', undefined, undefined]) {
        const frames = fragmented();
        const raw = iterable(frames);
        const wrapped = f.stream(raw, { purpose });
        if (!enabled || purpose !== undefined) assert.equal(wrapped, raw, 'no observation wrapper');
        const out = await Array.fromAsync(wrapped);
        assert.ok(out.length === frames.length && out.every((frame, i) => frame === frames[i]));
      }
      f.stopping(turn);
    }
    await new Promise(resolve => setImmediate(resolve));
    const hits = f.session.snapshotEvents().map(pluginRecordOf).filter(r => r?.type === 'plugin:dsh-fail-guard/hit').map(r => r.data);
    assert.deepEqual(hits, enabled ? [1, 2].map(turn => ({ turn, rule: 'fragment', count: 8, action: 'observed' })) : []);
    assert.deepEqual(f.messages, [], 'no steer or resume');
    f.scope.cleanup();
  });
}

test('fragment-only hit cannot cut or resume when the existing guards are active', async () => {
  const f = fixture({ fragmentObserveEnabled: true, resumeOnRepeat: true });
  f.begin();
  assert.deepEqual(await Array.fromAsync(f.stream(iterable(fragmented()))), fragmented());
  f.stopping();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.session.snapshotEvents().reduce(foldActivity, []), [{ turn: 1, rule: 'fragment', count: 8, action: 'observed' }]);
});

test('cross-turn and simulated stop only emit a bounded count, never steer or cancel', async () => {
  const f = fixture({ failureEnabled: false, failureLimit: 2, crossTurnObserveEnabled: true, stopSimulationEnabled: true });
  const args = '{"target":"synthetic-private-value"}';
  f.begin(1);
  f.result({ turn: 1, args });
  f.end(1);
  f.host.dispatch('agent/status', { agent: f.agent, status: 'idle' });
  f.begin(2);
  f.result({ turn: 2, args });
  f.result({ turn: 2, args });
  f.result({ turn: 2, args });
  f.stopping(2);
  f.end(2);
  await Promise.resolve();
  const activity = f.session.snapshotEvents().reduce(foldActivity, []);
  assert.deepEqual(activity, [
    { turn: 2, rule: 'cross-turn', count: 2, action: 'observed' },
    { turn: 2, rule: 'stop-simulation', count: 2, action: 'would-stop' },
  ]);
  assert.doesNotMatch(JSON.stringify(f.session.snapshotEvents()), /synthetic-private-value/);
  assert.deepEqual(f.messages, []);
});

test('an aborted previous turn or different parameters do not carry failures across', async () => {
  for (const [endKind, secondArgs] of [['aborted','{"target":1}'],['completed','{"target":2}']]) {
    const f = fixture({ failureEnabled: false, failureLimit: 2, crossTurnObserveEnabled: true, stopSimulationEnabled: true });
    f.begin(1);
    f.result({ turn: 1, args: '{"target":1}' });
    f.end(1, endKind);
    f.begin(2);
    f.result({ turn: 2, args: secondArgs });
    await Promise.resolve();
    assert.deepEqual(f.session.snapshotEvents().reduce(foldActivity, []), []);
    assert.deepEqual(f.messages, []);
  }
});

test('experimental steering queues once after a verified exact cut', async () => {
  const f = fixture({ activeSteerEnabled: true });
  f.begin();
  f.stopping();
  assert.deepEqual(f.messages, []);
  await Array.fromAsync(f.stream(iterable(repetitive())));
  f.stopping();
  f.stopping();
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].source.summary, '复读引导（实验）');
  await Promise.resolve();
  assert.deepEqual(f.session.snapshotEvents().reduce(foldActivity, []), [
    { turn: 1, rule: 'repeat', count: 6, action: 'cut' },
    { turn: 1, rule: 'steer', count: 1, action: 'steer-queued' },
  ]);
});

test('legacy resume takes precedence when both switches are enabled', async () => {
  const f = fixture({ activeSteerEnabled: true, resumeOnRepeat: true });
  f.begin();
  await Array.fromAsync(f.stream(iterable(repetitive())));
  f.stopping();
  f.stopping();
  await Promise.resolve();
  assert.deepEqual(f.messages.map(m => m.source.summary), ['复读打断 · 续跑一次']);
  assert.ok(!f.session.snapshotEvents().reduce(foldActivity, []).some(hit => hit.rule==='steer'));
});

test('observing, a stop signal, or a prior failure notice suppresses experimental steering', async () => {
  for (const mode of ['observe','abort','failure']) {
    const f = fixture({ activeSteerEnabled: true, observeOnly: mode==='observe', failureLimit: 2 });
    f.begin();
    if(mode==='failure') { f.result(); f.result(); }
    const before = f.messages.length;
    await Array.fromAsync(f.stream(iterable(repetitive())));
    f.stopping(1, mode==='abort' ? AbortSignal.abort() : new AbortController().signal);
    await Promise.resolve();
    assert.equal(f.messages.length,before);
    assert.ok(!f.session.snapshotEvents().reduce(foldActivity, []).some(hit => hit.rule==='steer'));
  }
});

test('disposal clears the agent and host subscriptions', () => {
  const f = fixture();
  f.begin();
  f.host.dispatch('agent/disposed', { agent: f.agent });
  assert.equal(f.agentEvents.listeners.size, 0);
  f.scope.cleanup();
  assert.equal(f.host.listeners.size, 0);
});
