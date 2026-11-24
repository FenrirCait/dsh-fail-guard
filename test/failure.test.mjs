// dsh-fail-guard · 连续失败内核测试（独立实现）
// 运行：node --test test/failure.test.mjs
// lib/failure/index.js 存在时测构建产物，否则用 Node 24 类型剥离直接测 src/failure/index.ts。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const libEntry = join(here, '..', 'lib', 'failure', 'index.js');
const srcEntry = join(here, '..', 'src', 'failure', 'index.ts');

async function loadFactory() {
  if (existsSync(libEntry)) {
    try {
      const mod = await import(pathToFileURL(libEntry).href);
      const factory = mod.createFailureTracker ?? mod.default?.createFailureTracker;
      if (typeof factory === 'function') return { factory, entry: 'lib/failure/index.js' };
    } catch (error) {
      console.error('[failure.test] 构建产物加载失败，回退到源码：' + error.message);
    }
  }
  const mod = await import(pathToFileURL(srcEntry).href);
  const factory = mod.createFailureTracker ?? mod.default?.createFailureTracker;
  return { factory, entry: 'src/failure/index.ts' };
}

const { factory: createFailureTracker, entry } = await loadFactory();
assert.equal(typeof createFailureTracker, 'function', '模块必须导出 createFailureTracker()');
console.log('[failure.test] 被测入口：' + entry);

const MSG = (tool, count, limit) =>
  '工具「' + tool + '」已连续失败 ' + count + ' 次（阈值 ' + limit + '）。' +
  '停止重复同一调用：检查错误原文，换用其它方式或向用户报告。';

const make = () => createFailureTracker();

function failCall(tracker, id, tool, turn, step, limit) {
  tracker.call(id, tool, turn, step);
  return tracker.result(id, turn, step, true, limit);
}

function okCall(tracker, id, tool, turn, step, limit = 3) {
  tracker.call(id, tool, turn, step);
  return tracker.result(id, turn, step, false, limit);
}

test('契约：实例暴露 call/result/clear/clearPending', () => {
  const tracker = make();
  for (const name of ['call', 'result', 'clear', 'clearPending']) {
    assert.equal(typeof tracker[name], 'function', name + ' 必须是函数');
  }
});

test('同一工具连续失败达到 limit 才返回通知', () => {
  const tracker = make();
  assert.equal(failCall(tracker, 'a1', 'terminal', 1, 1, 3), null);
  assert.equal(failCall(tracker, 'a2', 'terminal', 1, 2, 3), null);
  assert.equal(failCall(tracker, 'a3', 'terminal', 1, 3, 3), MSG('terminal', 3, 3));
});

test('limit=2 时第二次连续失败即通知', () => {
  const tracker = make();
  assert.equal(failCall(tracker, 'a1', 'shell', 1, 1, 2), null);
  assert.equal(failCall(tracker, 'a2', 'shell', 1, 2, 2), MSG('shell', 2, 2));
});

test('成功结果重置连续计数', () => {
  const tracker = make();
  failCall(tracker, 'a1', 'shell', 1, 1, 3);
  failCall(tracker, 'a2', 'shell', 1, 2, 3);
  assert.equal(okCall(tracker, 'a3', 'shell', 1, 3), null);
  assert.equal(failCall(tracker, 'a4', 'shell', 1, 4, 3), null);
  assert.equal(failCall(tracker, 'a5', 'shell', 1, 5, 3), null);
  assert.equal(failCall(tracker, 'a6', 'shell', 1, 6, 3), MSG('shell', 3, 3));
});

test('其它工具的结果会重置当前连续计数', () => {
  const tracker = make();
  failCall(tracker, 'a1', 'shell', 1, 1, 3);
  failCall(tracker, 'a2', 'shell', 1, 2, 3);
  assert.equal(failCall(tracker, 'b1', 'read', 1, 3, 3), null);
  assert.equal(failCall(tracker, 'a3', 'shell', 1, 4, 3), null);
  assert.equal(failCall(tracker, 'a4', 'shell', 1, 5, 3), null);
  assert.equal(failCall(tracker, 'a5', 'shell', 1, 6, 3), MSG('shell', 3, 3));
});

test('其它工具成功同样重置，不区分工具', () => {
  const tracker = make();
  failCall(tracker, 'a1', 'shell', 1, 1, 3);
  failCall(tracker, 'a2', 'shell', 1, 2, 3);
  assert.equal(okCall(tracker, 'b1', 'read', 1, 3), null);
  assert.equal(failCall(tracker, 'a3', 'shell', 1, 4, 3), null);
  assert.equal(failCall(tracker, 'a4', 'shell', 1, 5, 3), null);
  assert.equal(failCall(tracker, 'a5', 'shell', 1, 6, 3), MSG('shell', 3, 3));
});

test('未匹配结果被忽略，不影响连续计数', () => {
  const tracker = make();
  assert.equal(failCall(tracker, 'a1', 'shell', 1, 1, 2), null);
  assert.equal(tracker.result('ghost', 1, 2, false, 2), null);
  assert.equal(tracker.result('ghost', 1, 2, true, 2), null);
  assert.equal(tracker.result(undefined, 1, 2, true, 2), null);
  assert.equal(failCall(tracker, 'a2', 'shell', 1, 3, 2), MSG('shell', 2, 2));
});

test('坐标不一致的结果被忽略，pending 保留', () => {
  const tracker = make();
  tracker.call('a1', 'shell', 1, 2);
  assert.equal(tracker.result('a1', 1, 3, true, 2), null);
  assert.equal(tracker.result('a1', 2, 2, true, 2), null);
  assert.equal(tracker.result('a1', 1, 2, true, 2), null);
  tracker.call('a2', 'shell', 1, 4);
  assert.equal(tracker.result('a2', 1, 4, true, 2), MSG('shell', 2, 2));
});

test('每轮至多一次通知：同一轮内不同工具的连续段也不再通知', () => {
  const tracker = make();
  failCall(tracker, 'a1', 'shell', 1, 1, 2);
  assert.equal(failCall(tracker, 'a2', 'shell', 1, 2, 2), MSG('shell', 2, 2));
  assert.equal(failCall(tracker, 'b1', 'read', 1, 3, 2), null);
  assert.equal(failCall(tracker, 'b2', 'read', 1, 4, 2), null);
});

test('下一轮可再次通知', () => {
  const tracker = make();
  failCall(tracker, 'a1', 'shell', 1, 1, 2);
  assert.equal(failCall(tracker, 'a2', 'shell', 1, 2, 2), MSG('shell', 2, 2));
  assert.equal(failCall(tracker, 'a3', 'shell', 1, 3, 2), null);
  assert.equal(failCall(tracker, 'a4', 'shell', 2, 1, 2), MSG('shell', 4, 2));
});

test('连续失败段可跨轮累计', () => {
  const tracker = make();
  assert.equal(failCall(tracker, 'a1', 'shell', 1, 1, 3), null);
  assert.equal(failCall(tracker, 'a2', 'shell', 1, 2, 3), null);
  assert.equal(failCall(tracker, 'a3', 'shell', 2, 1, 3), MSG('shell', 3, 3));
});

test('clearPending 只丢弃在途调用，保留连续计数', () => {
  const tracker = make();
  failCall(tracker, 'a1', 'shell', 1, 1, 3);
  failCall(tracker, 'a2', 'shell', 1, 2, 3);
  tracker.call('p1', 'shell', 1, 3);
  tracker.clearPending();
  assert.equal(tracker.result('p1', 1, 3, true, 3), null);
  assert.equal(failCall(tracker, 'a3', 'shell', 1, 4, 3), MSG('shell', 3, 3));
});

test('clear 全量重置在途、计数、通知记忆与坐标游标', () => {
  const tracker = make();
  failCall(tracker, 'a1', 'shell', 1, 1, 2);
  assert.equal(failCall(tracker, 'a2', 'shell', 1, 2, 2), MSG('shell', 2, 2));
  tracker.call('p2', 'shell', 1, 3);
  tracker.clear();
  assert.equal(tracker.result('p2', 1, 3, true, 2), null);
  assert.equal(failCall(tracker, 'a3', 'shell', 1, 1, 2), null);
  assert.equal(failCall(tracker, 'a4', 'shell', 1, 2, 2), MSG('shell', 2, 2));
});

test('pending 有界：最旧调用被淘汰，最新调用仍可匹配', () => {
  const tracker = make();
  for (let i = 0; i < 200; i += 1) tracker.call('call-' + i, 'probe', 1, i + 1);
  assert.equal(tracker.result('call-199', 1, 200, true, 2), null);
  assert.equal(tracker.result('call-0', 1, 1, true, 2), null);
  assert.equal(failCall(tracker, 'fresh', 'probe', 1, 201, 2), MSG('probe', 2, 2));
});

test('历史回放：旧坐标与新 callId 的调用被忽略', () => {
  const tracker = make();
  failCall(tracker, 'a1', 'shell', 1, 1, 3);
  failCall(tracker, 'a2', 'shell', 1, 2, 3);
  tracker.call('old-1', 'shell', 1, 1);
  assert.equal(tracker.result('old-1', 1, 1, true, 3), null);
  assert.equal(failCall(tracker, 'a3', 'shell', 2, 1, 3), MSG('shell', 3, 3));
});

test('历史回放：已处理 callId 再次出现时被忽略，结果不重复计数', () => {
  const tracker = make();
  failCall(tracker, 'a1', 'shell', 1, 1, 3);
  failCall(tracker, 'a2', 'shell', 1, 2, 3);
  tracker.call('a1', 'shell', 1, 1);
  tracker.call('a2', 'shell', 1, 2);
  assert.equal(tracker.result('a1', 1, 1, true, 3), null);
  assert.equal(tracker.result('a2', 1, 2, true, 3), null);
  assert.equal(failCall(tracker, 'a3', 'shell', 2, 1, 3), MSG('shell', 3, 3));
});

test('非法 limit 不返回通知', () => {
  const tracker = make();
  assert.equal(failCall(tracker, 'a1', 'shell', 1, 1, 1), null);
  assert.equal(failCall(tracker, 'a2', 'shell', 1, 2, 0), null);
  assert.equal(failCall(tracker, 'a3', 'shell', 1, 3, Number.NaN), null);
  assert.equal(failCall(tracker, 'a4', 'shell', 1, 4, 2), MSG('shell', 4, 2));
});

test('同一 callId 重复记录以最后一次坐标为准', () => {
  const tracker = make();
  tracker.call('a1', 'shell', 1, 1);
  tracker.call('a1', 'shell', 1, 2);
  assert.equal(tracker.result('a1', 1, 1, true, 2), null);
  assert.equal(failCall(tracker, 'a2', 'shell', 1, 3, 2), null);
  assert.equal(failCall(tracker, 'a3', 'shell', 1, 4, 2), MSG('shell', 2, 2));
});

test('非法调用参数不进入 pending', () => {
  const tracker = make();
  tracker.call(null, 'shell', 1, 1);
  tracker.call(undefined, 'shell', 1, 2);
  tracker.call('', 'shell', 1, 3);
  tracker.call('x', '', 1, 4);
  tracker.call('y', 123, 1, 5);
  for (const id of [null, undefined, '', 'x', 'y']) {
    assert.equal(tracker.result(id, 1, 1, true, 2), null);
  }
  assert.equal(failCall(tracker, 'a1', 'shell', 1, 6, 2), null);
  assert.equal(failCall(tracker, 'a2', 'shell', 1, 7, 2), MSG('shell', 2, 2));
});

test('同一结果重复投递不会重复计数', () => {
  const tracker = make();
  tracker.call('a1', 'shell', 1, 1);
  assert.equal(tracker.result('a1', 1, 1, true, 2), null);
  assert.equal(tracker.result('a1', 1, 1, true, 2), null);
  tracker.call('a2', 'shell', 1, 2);
  assert.equal(tracker.result('a2', 1, 2, true, 2), MSG('shell', 2, 2));
});

test('同一步的并行调用各自匹配，按结果到达顺序计数', () => {
  const tracker = make();
  tracker.call('a', 'shell', 1, 5);
  tracker.call('b', 'shell', 1, 5);
  tracker.call('c', 'shell', 1, 5);
  assert.equal(tracker.result('b', 1, 5, true, 3), null);
  assert.equal(tracker.result('a', 1, 5, true, 3), null);
  assert.equal(tracker.result('c', 1, 5, true, 3), MSG('shell', 3, 3));
});
