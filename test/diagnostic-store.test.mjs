import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDiagnosticStore, TTL_MS } from '../lib/diagnostic-store.js';
import { GuardDiagnostics } from '../lib/diagnostic-remote.js';

const sample = { version: 1, kind: 'automatic', pluginVersion: '0.4.0-alpha.4', hostVersion: null,
  threshold: 5, mode: 'observe', count: 6, action: 'observed',
  trace: { events: [{ kind: 'start', block: 0 }, { kind: 'delta', block: 0 }], groups: [0, 0] } };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'guard-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 10000;
  return { file: join(root, 'dsh-fail-guard', 'diagnostics-v1.json'), store: createDiagnosticStore(root, () => now),
    advance: delta => { now += delta; } };
}

test('an unused diagnostic store does not write a file', async t => {
  const { file, store } = await fixture(t);
  await store.prune();
  assert.equal(await store.get('session-a', 5), null);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('store strips extra fields and reads only an exact session and turn', async t => {
  const { file, store } = await fixture(t);
  assert.equal(await store.put('session-a', 5, { ...sample, note: 'private-fixture', trace: {
    ...sample.trace, events: [{ ...sample.trace.events[0], text: 'private-fixture' }, sample.trace.events[1]],
  } }), true);
  assert.doesNotMatch(await readFile(file, 'utf8'), /private-fixture/);
  assert.equal(await store.get('session-b', 5), null);
  assert.equal(await store.get('session-a', 6), null);
  assert.deepEqual(await store.get('session-a', 5), sample);
});

test('capacity is 20 and a resumed update does not extend retention', async t => {
  const { file, store, advance } = await fixture(t);
  for (let turn = 0; turn < 21; turn++) assert.equal(await store.put('session-a', turn, sample), true);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 20);
  assert.equal(await store.get('session-a', 0), null);
  advance(TTL_MS - 1);
  assert.equal(await store.put('session-a', 20, { ...sample, mode: 'enforce', action: 'resumed' }), true);
  assert.equal((await store.get('session-a', 20)).action, 'resumed');
  advance(1);
  assert.equal(await store.get('session-a', 20), null);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('diagnostic reader checks owner before touching the store', async () => {
  let reads = 0;
  const request = { sessionId: 'session-a', turn: 5 };
  const getReport = GuardDiagnostics.prototype.getReport;
  const local = { ctx: {}, store: { get: async (sessionId, turn) => { reads++; assert.deepEqual({ sessionId, turn }, request); return sample; } } };
  assert.equal(await getReport.call(local, request), null);
  local.ctx.invocation = { peer: { principal: { kind: 'guest' } } };
  assert.equal(await getReport.call(local, request), null);
  assert.equal(reads, 0);
  local.ctx.invocation.peer.principal.kind = 'owner';
  assert.equal(await getReport.call(local, { ...request, turn: -1 }), null);
  assert.deepEqual(await getReport.call(local, request), sample);
  assert.equal(reads, 1);
});
