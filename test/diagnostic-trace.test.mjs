// dsh-fail-guard · 复读诊断结构（第五参数 diagnostics）专项测试
// 运行：node --test test/diagnostic-trace.test.mjs
// 直接测源码：本任务按约定不重建 lib（lib 由主控统一构建后再做整包验收）。
// 所有流都是确定性合成片，断言精确的事件序列、等价行编号与上限，不依赖计时。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const libEntry = join(here, '..', 'lib', 'repetition', 'index.js');
const srcEntry = join(here, '..', 'src', 'repetition', 'index.ts');

/** 与 repetition.test.mjs 同一约定：lib 比 src 新才测构建产物，否则测源码（避免测到过期构建）。 */
function libIsFresh() {
  if (!existsSync(libEntry)) return false;
  if (!existsSync(srcEntry)) return true;
  try {
    return statSync(libEntry).mtimeMs >= statSync(srcEntry).mtimeMs;
  } catch {
    return false;
  }
}

async function loadModule() {
  if (libIsFresh()) {
    try {
      const loaded = await import(pathToFileURL(libEntry).href);
      if (typeof loaded.guardReasoning === 'function') return { mod: loaded, entry: 'lib/repetition/index.js' };
    } catch (error) {
      console.error('[diagnostic-trace.test] 构建产物加载失败，回退到源码：' + error.message);
    }
  }
  const loaded = await import(pathToFileURL(srcEntry).href);
  return { mod: loaded, entry: 'src/repetition/index.ts' };
}

const { mod, entry } = await loadModule();
console.log('[diagnostic-trace.test] 被测入口：' + entry);
const {
  guardReasoning,
  createLineScanner,
  SHORT_LINE_MAX_CHARS,
  MAX_ACTIVE_BLOCKS,
  TRACE_MAX_EVENTS,
  TRACE_MAX_GROUPS,
} = mod;

// ---------------------------------------------------------------------------
// 工具（与 repetition.test.mjs 同一套合成片，方便对照）
// ---------------------------------------------------------------------------

const start = (index, blockType) => ({ type: 'block-start', index, blockType });
const reasoning = (index, text) => ({ type: 'reasoning-delta', index, text });
const textDelta = (index, text) => ({ type: 'text-delta', index, text });
const toolDelta = (index, id, argumentsDelta) => ({ type: 'tool-call-delta', index, id, argumentsDelta });
const blockEnd = (index, block) => ({ type: 'block-end', index, block });
const finish = (reason = { kind: 'stop' }) => ({ type: 'finish', reason });
const repeats = (count, line = '做。\n', index = 0) =>
  Array.from({ length: count }, () => reasoning(index, line));

/** 手写源：精确统计 next() 与 return() 次数，用来验证开关不改变读取/关闭协议。 */
function makeSource(items) {
  const stats = { nexts: 0, returns: 0 };
  let cursor = 0;
  const iterator = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    async next() {
      stats.nexts += 1;
      if (cursor >= items.length) return { done: true, value: undefined };
      return { done: false, value: items[cursor++] };
    },
    async return() {
      stats.returns += 1;
      cursor = items.length;
      return { done: true, value: undefined };
    },
  };
  return { iterator, stats };
}

/** 跑一条流：总是收集 onCut 载荷，可额外指定 decide 与 diagnostics。 */
function run(items, limit, decide, diagnostics) {
  const source = makeSource(items);
  const cuts = [];
  const stream = guardReasoning(source.iterator, limit, cut => cuts.push(cut), decide, diagnostics);
  return { source, cuts, stream };
}

async function drain(stream) {
  const out = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

/** 事件形状："start@0" 这类字符串，便于一眼看出顺序与局部编号。 */
const shapes = trace => trace.events.map(event => event.kind + '@' + event.block);

/**
 * 逐片比较两条输出：转发片必须同一对象；唯一允许不同身份的是模块合成的终止片
 * （每次 yield 新建对象），它的内容仍需逐字段相同。
 */
function assertSameStream(actual, expected) {
  assert.equal(actual.length, expected.length, '输出片数');
  for (let i = 0; i < actual.length; i += 1) {
    if (actual[i] === expected[i]) continue;
    assert.equal(actual[i].type, 'finish', '第 ' + i + ' 片只有合成终止片允许是新对象');
    assert.deepEqual(actual[i], expected[i]);
  }
}

// ---------------------------------------------------------------------------
// 入口与上限常量
// ---------------------------------------------------------------------------

test('入口：导出开关、trace 上限常量与既有 API 不变', () => {
  assert.equal(typeof guardReasoning, 'function');
  assert.equal(typeof createLineScanner, 'function');
  assert.equal(TRACE_MAX_EVENTS, 64, '事件上限必须是 64');
  assert.equal(TRACE_MAX_GROUPS, 32, '等价行编号上限必须是 32');
  // 公开扫描器保持单参数行为：扫描结果仍只有 hit 与 count。
  const scanner = createLineScanner(3);
  const scanned = scanner.push('做。\n'.repeat(3));
  assert.deepEqual(Object.keys(scanned).sort(), ['count', 'hit']);
  assert.deepEqual(scanned, { hit: 3, count: 3 });
});

// ---------------------------------------------------------------------------
// 停用不采集：默认与显式 false 的载荷与旧版逐字段相同
// ---------------------------------------------------------------------------

const cutStream = () => [
  start(0, 'reasoning'),
  ...repeats(3),
  reasoning(0, '继续。\n'),
  finish(),
];

test('停用：默认调用（省略第五参数）时 onCut 载荷没有 trace', async () => {
  const { cuts, source, stream } = run(cutStream(), 3);
  const out = await drain(stream);
  assert.equal(cuts.length, 1);
  assert.deepEqual(cuts[0], { index: 0, count: 3 }, '默认载荷必须与旧版逐字段相同');
  assert.deepEqual(Object.keys(cuts[0]).sort(), ['count', 'index']);
  assert.equal('trace' in cuts[0], false, '停用时不得出现 trace 属性');
  assert.equal(out.at(-1).type, 'finish');
  assert.equal(source.stats.returns, 1);
});

test('停用：显式 diagnostics=false 与省略完全一致（载荷与输出）', async () => {
  const items = cutStream();
  const off = run(items, 3, undefined, false);
  const omitted = run(items, 3);
  const outOff = await drain(off.stream);
  const outOmitted = await drain(omitted.stream);
  assert.deepEqual(off.cuts, omitted.cuts);
  assertSameStream(outOff, outOmitted);
  assert.equal(off.source.stats.returns, omitted.source.stats.returns);
  assert.equal(off.source.stats.nexts, omitted.source.stats.nexts);
});

test('停用：放行路径（decide=false）载荷同样不带 trace', async () => {
  const items = [
    start(0, 'reasoning'),
    reasoning(0, '做。\n'), reasoning(0, '做。\n'), reasoning(0, '做。\n'),
    reasoning(0, '继续。\n'),
    finish(),
  ];
  const { cuts, source, stream } = run(items, 3, () => false);
  await drain(stream);
  assert.equal(cuts.length, 1);
  assert.deepEqual(Object.keys(cuts[0]).sort(), ['count', 'index']);
  assert.equal(source.stats.returns, 0, '停用诊断不得改变放行时的关闭协议');
});

// ---------------------------------------------------------------------------
// 结构事件：顺序、块边界、局部编号
// ---------------------------------------------------------------------------

test('事件：交错块按发生顺序记录，块边界与增量序列精确', async () => {
  const items = [
    start(0, 'reasoning'), start(1, 'reasoning'),
    reasoning(0, '做。\n'), reasoning(1, '甲\n'),
    reasoning(0, '做。\n'), reasoning(1, '乙\n'),
    blockEnd(1, { type: 'reasoning', text: '' }),
    reasoning(0, '做。\n'),
    reasoning(0, '继续。\n'),
    finish(),
  ];
  const { cuts, source, stream } = run(items, 3, undefined, true);
  const out = await drain(stream);
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].index, 0);
  assert.equal(cuts[0].count, 3);
  assert.ok(cuts[0].trace, '开启时必须附带 trace');
  assert.deepEqual(shapes(cuts[0].trace), [
    'start@0', 'start@1', 'delta@0', 'delta@1', 'delta@0', 'delta@1', 'end@1', 'delta@0',
  ]);
  assert.deepEqual(cuts[0].trace.groups, [0, 1, 0, 2, 0], '甲/乙 各成新等价类');
  assert.equal(out.length, 9, '8 片原样转发 + 1 个终止片');
  assert.equal(out.at(-1).type, 'finish');
  assert.equal(source.stats.returns, 1);
});

test('事件：只有送进扫描器的 reasoning 增量记 delta，text/tool-call 只记 start', async () => {
  const items = [
    start(0, 'reasoning'), start(1, 'text'),
    textDelta(1, '正文'),
    toolDelta(1, 'call-1', '{"q":'),
    reasoning(0, '做。\n'), reasoning(0, '做。\n'),
    blockEnd(1, { type: 'text', text: '正文' }),
    reasoning(0, '做。\n'),
    reasoning(0, '继续。\n'),
    finish(),
  ];
  const { cuts, stream } = run(items, 3, undefined, true);
  await drain(stream);
  assert.equal(cuts.length, 1);
  assert.deepEqual(shapes(cuts[0].trace), ['start@0', 'start@1', 'delta@0', 'delta@0', 'end@1', 'delta@0']);
  assert.deepEqual(cuts[0].trace.groups, [0, 0, 0], '文本/工具块内容不参与等价行编号');
});

test('事件：delta-only 流先记隐式 start 再记 delta，且编号从 0 起', async () => {
  const items = [...repeats(3, '做。\n', 5), reasoning(5, '继续。\n'), finish()];
  const { cuts, stream } = run(items, 3, undefined, true);
  await drain(stream);
  assert.equal(cuts.length, 1);
  assert.deepEqual(shapes(cuts[0].trace), ['start@0', 'delta@0', 'delta@0', 'delta@0']);
  assert.deepEqual(cuts[0].trace.groups, [0, 0, 0]);
  assert.equal(cuts[0].index, 5, '上游 index 仍按原样出现在载荷 index 字段');
});

test('事件：同一 index 未收块又重新开始，沿用该局部编号', async () => {
  const items = [
    start(0, 'reasoning'),
    blockEnd(0, { type: 'reasoning', text: '' }),
    start(0, 'reasoning'),
    ...repeats(3),
    reasoning(0, '继续。\n'),
    finish(),
  ];
  const { cuts, stream } = run(items, 3, undefined, true);
  await drain(stream);
  assert.equal(cuts.length, 1);
  assert.deepEqual(shapes(cuts[0].trace), ['start@0', 'end@0', 'start@0', 'delta@0', 'delta@0', 'delta@0']);
});

test('事件：块结束后局部编号按最小空闲号复用', async () => {
  const items = [
    start(0, 'text'), start(1, 'text'),
    blockEnd(0, { type: 'text', text: '' }),
    start(2, 'reasoning'),
    reasoning(2, '做。\n'), reasoning(2, '做。\n'),
    blockEnd(1, { type: 'text', text: '' }),
    reasoning(2, '做。\n'),
    reasoning(2, '继续。\n'),
    finish(),
  ];
  const { cuts, stream } = run(items, 3, undefined, true);
  await drain(stream);
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].index, 2);
  assert.deepEqual(shapes(cuts[0].trace), [
    'start@0', 'start@1', 'end@0', 'start@0', 'delta@0', 'delta@0', 'end@1', 'delta@0',
  ]);
});

// ---------------------------------------------------------------------------
// 等价行编号：只来自完整合格行判据
// ---------------------------------------------------------------------------

test('等价行编号：同一文本跨块共享编号，等价关系不按块划分', async () => {
  const items = [
    start(0, 'reasoning'), start(1, 'reasoning'),
    reasoning(0, '做。\n'), reasoning(1, '做。\n'),
    blockEnd(1, { type: 'reasoning', text: '' }),
    reasoning(0, '做。\n'), reasoning(0, '做。\n'),
    reasoning(0, '继续。\n'),
    finish(),
  ];
  const { cuts, stream } = run(items, 3, undefined, true);
  await drain(stream);
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].count, 3, '计数仍按块独立累计');
  assert.deepEqual(cuts[0].trace.groups, [0, 0, 0, 0], '同一文本始终是编号 0');
  assert.deepEqual(shapes(cuts[0].trace), [
    'start@0', 'start@1', 'delta@0', 'delta@1', 'end@1', 'delta@0', 'delta@0',
  ]);
});

test('等价行编号：与扫描器同一 trim 判据（含 CRLF），不引入新相似度', async () => {
  const items = [
    start(0, 'reasoning'),
    reasoning(0, '  做。  \n'),
    reasoning(0, '做。\n'),
    reasoning(0, '做。\r\n'),
    reasoning(0, '继续。\n'),
    finish(),
  ];
  const scanner = createLineScanner(3);
  const direct = scanner.push('  做。  \n做。\n做。\r\n');
  assert.equal(direct.hit, 3, '同一判据在扫描器上命中 3');
  const { cuts, stream } = run(items, 3, undefined, true);
  await drain(stream);
  assert.equal(cuts.length, 1);
  assert.deepEqual(cuts[0].trace.groups, [0, 0, 0]);
});

test('等价行编号：空行、纯标点、结构行与长行不占编号', async () => {
  const longLine = 'x'.repeat(SHORT_LINE_MAX_CHARS + 1) + '\n';
  const items = [
    start(0, 'reasoning'),
    reasoning(0, '\n'),
    reasoning(0, '。。。\n'),
    reasoning(0, '```ts\n'),
    reasoning(0, longLine),
    ...repeats(3),
    reasoning(0, '继续。\n'),
    finish(),
  ];
  const { cuts, stream } = run(items, 3, undefined, true);
  await drain(stream);
  assert.equal(cuts.length, 1);
  assert.deepEqual(cuts[0].trace.groups, [0, 0, 0], '只有三条“做。”进入编号');
  assert.deepEqual(shapes(cuts[0].trace), [
    'start@0', 'delta@0', 'delta@0', 'delta@0', 'delta@0', 'delta@0', 'delta@0', 'delta@0',
  ]);
});

test('等价行编号：上限 32 条，满额后不再追加', async () => {
  const items = [start(0, 'reasoning')];
  for (let i = 0; i < 40; i += 1) items.push(reasoning(0, 'L' + i + '\n'));
  items.push(...repeats(3, 'ZZZ\n'), reasoning(0, '继续。\n'), finish());
  const { cuts, stream } = run(items, 3, undefined, true);
  await drain(stream);
  assert.equal(cuts.length, 1, '40 条互异行后仍能靠 3 条相同行命中');
  assert.equal(cuts[0].trace.groups.length, TRACE_MAX_GROUPS);
  for (const group of cuts[0].trace.groups) {
    assert.ok(Number.isInteger(group) && group >= 0 && group < TRACE_MAX_GROUPS, '编号必须有界：' + group);
  }
  assert.equal(new Set(cuts[0].trace.groups).size, TRACE_MAX_GROUPS, '前 32 条互异行各占一个编号');
});

// ---------------------------------------------------------------------------
// 有界：事件上限、局部编号不泄漏上游 index
// ---------------------------------------------------------------------------

test('有界：事件最多 64 条，超出部分直接丢弃', async () => {
  const items = [];
  for (let i = 0; i < 40; i += 1) {
    items.push(start(i, 'text'), blockEnd(i, { type: 'text', text: '' }));
  }
  items.push(start(100, 'reasoning'), ...repeats(3, '做。\n', 100), reasoning(100, '继续。\n'), finish());
  const { cuts, stream } = run(items, 3, undefined, true);
  await drain(stream);
  assert.equal(cuts.length, 1, '诊断有界不影响命中');
  const trace = cuts[0].trace;
  assert.equal(trace.events.length, TRACE_MAX_EVENTS);
  assert.ok(JSON.stringify(trace).length < 4096, '上限之内的结构必须是小对象');
  for (const event of trace.events) {
    assert.deepEqual(Object.keys(event).sort(), ['block', 'kind']);
    assert.ok(Number.isInteger(event.block) && event.block >= 0 && event.block < MAX_ACTIVE_BLOCKS);
  }
});

test('有界：局部块编号有界，不出现上游 index 或正文', async () => {
  const items = [
    start(1000000, 'reasoning'),
    ...repeats(3, '做。\n', 1000000),
    reasoning(1000000, '继续。\n'),
    finish(),
  ];
  const { cuts, stream } = run(items, 3, undefined, true);
  await drain(stream);
  assert.equal(cuts.length, 1);
  const text = JSON.stringify(cuts[0].trace);
  assert.deepEqual(shapes(cuts[0].trace), ['start@0', 'delta@0', 'delta@0', 'delta@0']);
  assert.equal(text.includes('1000000'), false, '不得泄漏上游 index');
  assert.equal(text.includes('做'), false, '不得输出原文');
  assert.equal(text.includes('继续'), false);
  assert.equal(/[0-9a-f]{32,}/.test(text), false, '不得出现哈希形态');
});

test('有界：大量合格行下结构仍封顶且保持小对象', async () => {
  const items = [start(0, 'reasoning')];
  for (let i = 0; i < 2000; i += 1) items.push(reasoning(0, 'K' + i + '\n'));
  items.push(...repeats(3, '尾部\n'), reasoning(0, '继续。\n'), finish());
  const { cuts, stream } = run(items, 3, undefined, true);
  await drain(stream);
  assert.equal(cuts.length, 1);
  const trace = cuts[0].trace;
  assert.equal(trace.events.length, TRACE_MAX_EVENTS);
  assert.equal(trace.groups.length, TRACE_MAX_GROUPS);
  assert.ok(JSON.stringify(trace).length < 4096);
  assert.equal(JSON.stringify(trace).includes('K1'), false, '不保留任何行文本');
});

// ---------------------------------------------------------------------------
// 无行为变化：输出、关闭协议、读取次数、超限停机
// ---------------------------------------------------------------------------

test('无行为变化：开/关诊断时输出片逐片相同（截断路径）', async () => {
  const items = cutStream();
  const on = run(items, 3, undefined, true);
  const off = run(items, 3, undefined, false);
  const outOn = await drain(on.stream);
  const outOff = await drain(off.stream);
  assertSameStream(outOn, outOff);
  assert.equal(on.source.stats.nexts, off.source.stats.nexts);
  assert.equal(on.source.stats.returns, off.source.stats.returns);
  assert.equal(on.cuts[0].index, off.cuts[0].index);
  assert.equal(on.cuts[0].count, off.cuts[0].count);
});

test('无行为变化：开/关诊断时输出与关闭协议相同（放行路径）', async () => {
  const items = [
    start(0, 'reasoning'),
    ...repeats(3),
    reasoning(0, '继续。\n'),
    ...repeats(3),
    reasoning(0, '继续。\n'),
    reasoning(0, '后续正文\n'),
    blockEnd(0, { type: 'reasoning', text: '' }),
    finish(),
  ];
  const on = run(items, 3, () => false, true);
  const off = run(items, 3, () => false, false);
  const outOn = await drain(on.stream);
  const outOff = await drain(off.stream);
  assert.equal(outOn.length, items.length);
  assert.equal(outOff.length, items.length);
  for (let i = 0; i < items.length; i += 1) {
    assert.strictEqual(outOn[i], items[i]);
    assert.strictEqual(outOff[i], items[i]);
  }
  assert.equal(on.cuts.length, 2);
  assert.equal(off.cuts.length, 2);
  for (let i = 0; i < 2; i += 1) {
    assert.equal(on.cuts[i].count, off.cuts[i].count);
    assert.equal(on.cuts[i].index, off.cuts[i].index);
  }
  assert.equal(on.source.stats.returns, 0);
  assert.equal(off.source.stats.returns, 0);
  assert.equal(on.source.stats.nexts, off.source.stats.nexts);
});

test('无行为变化：活动块超限停机时开关不改变透传与关闭协议', async () => {
  const items = [];
  for (let i = 0; i < MAX_ACTIVE_BLOCKS + 1; i += 1) items.push(start(i, 'text'));
  items.push(...repeats(3), reasoning(0, '继续。\n'), finish());
  const on = run(items, 3, undefined, true);
  const off = run(items, 3, undefined, false);
  const outOn = await drain(on.stream);
  const outOff = await drain(off.stream);
  assert.equal(outOn.length, items.length);
  for (let i = 0; i < items.length; i += 1) assert.strictEqual(outOn[i], outOff[i]);
  assert.equal(on.cuts.length, 0);
  assert.equal(off.cuts.length, 0);
  assert.equal(on.source.stats.returns, 0);
  assert.equal(off.source.stats.returns, 0);
});

// ---------------------------------------------------------------------------
// 快照：冻结、与后续采集隔离
// ---------------------------------------------------------------------------

test('快照：已交付的 trace 冻结且不随后续命中增长', async () => {
  const items = [
    start(0, 'reasoning'),
    reasoning(0, '做。\n'), reasoning(0, '做。\n'), reasoning(0, '做。\n'),
    reasoning(0, '继续。\n'),
    reasoning(0, '做。\n'), reasoning(0, '做。\n'), reasoning(0, '做。\n'),
    reasoning(0, '继续。\n'),
    finish(),
  ];
  const { cuts, stream } = run(items, 3, () => false, true);
  await drain(stream);
  assert.equal(cuts.length, 2);
  const first = cuts[0].trace;
  const second = cuts[1].trace;
  assert.notEqual(first.events, second.events);
  assert.deepEqual(shapes(first), ['start@0', 'delta@0', 'delta@0', 'delta@0']);
  assert.deepEqual(first.groups, [0, 0, 0]);
  assert.deepEqual(shapes(second).length, 8);
  assert.deepEqual(second.groups, [0, 0, 0, 1, 0, 0, 0]);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.events));
  assert.ok(Object.isFrozen(first.groups));
  assert.ok(Object.isFrozen(first.events[0]));
  assert.throws(() => first.groups.push(9), TypeError, '快照必须不可变');
  assert.equal(first.groups.length, 3, '第一次快照不随后续采集变化');
});

test('快照：事件对象只有 kind 与 block，不含正文与上游 index', async () => {
  const items = cutStream();
  const { cuts, stream } = run(items, 3, undefined, true);
  await drain(stream);
  const trace = cuts[0].trace;
  for (const event of trace.events) {
    assert.deepEqual(Object.keys(event).sort(), ['block', 'kind']);
    assert.ok(['start', 'end', 'delta'].includes(event.kind));
    assert.equal(typeof event.block, 'number');
  }
  for (const group of trace.groups) assert.equal(typeof group, 'number');
  const text = JSON.stringify(trace);
  assert.equal(text.includes('做'), false);
  assert.equal(text.includes('继续'), false);
});

// ---------------------------------------------------------------------------
// 参数与开关
// ---------------------------------------------------------------------------

test('参数：diagnostics 必须是布尔值或省略', () => {
  for (const value of ['yes', 1, 0, null, {}, [], () => true]) {
    assert.throws(
      () => guardReasoning(makeSource([]).iterator, 3, undefined, undefined, value),
      TypeError,
      'diagnostics=' + String(value),
    );
  }
  assert.doesNotThrow(() => guardReasoning(makeSource([]).iterator, 3, undefined, undefined, true));
  assert.doesNotThrow(() => guardReasoning(makeSource([]).iterator, 3, undefined, undefined, false));
  assert.doesNotThrow(() => guardReasoning(makeSource([]).iterator, 3, undefined, undefined));
});

test('开关：开启但无命中时 onCut 不调用、输出原样转发', async () => {
  const items = [
    start(0, 'reasoning'),
    reasoning(0, '正常思考\n'),
    blockEnd(0, { type: 'reasoning', text: '' }),
    finish(),
  ];
  const source = makeSource(items);
  const stream = guardReasoning(source.iterator, 3, () => assert.fail('不应调用 onCut'), undefined, true);
  const out = await drain(stream);
  assert.equal(out.length, items.length);
  for (let i = 0; i < items.length; i += 1) assert.strictEqual(out[i], items[i]);
  assert.equal(source.stats.returns, 0);
});
