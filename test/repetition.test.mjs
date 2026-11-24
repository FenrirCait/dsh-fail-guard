// dsh-fail-guard · 思考流复读防护测试（独立实现）
// 运行：node --test test/repetition.test.mjs
// lib/repetition/index.js 存在且不比源码旧时测构建产物；否则用 Node 24 类型剥离直接测 src/repetition/index.ts。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const libEntry = join(here, '..', 'lib', 'repetition', 'index.js');
const srcEntry = join(here, '..', 'src', 'repetition', 'index.ts');

/** lib 比 src 新（或 src 不存在）才认为构建产物可用，避免测到过期构建。 */
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
      const mod = await import(pathToFileURL(libEntry).href);
      if (typeof mod.guardReasoning === 'function') return { mod, entry: 'lib/repetition/index.js' };
    } catch (error) {
      console.error('[repetition.test] 构建产物加载失败，回退到源码：' + error.message);
    }
  }
  const mod = await import(pathToFileURL(srcEntry).href);
  return { mod, entry: 'src/repetition/index.ts' };
}

const { mod, entry } = await loadModule();
const { guardReasoning, createLineScanner, SHORT_LINE_MAX_CHARS, MAX_ACTIVE_BLOCKS } = mod;
assert.equal(typeof guardReasoning, 'function', '模块必须导出 guardReasoning()');
assert.equal(typeof createLineScanner, 'function', '模块必须导出 createLineScanner()');
assert.equal(typeof SHORT_LINE_MAX_CHARS, 'number');
assert.equal(MAX_ACTIVE_BLOCKS, 64, '模块必须导出常量 MAX_ACTIVE_BLOCKS = 64');
console.log('[repetition.test] 被测入口：' + entry);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const start = (index, blockType) => ({ type: 'block-start', index, blockType });
const reasoning = (index, text) => ({ type: 'reasoning-delta', index, text });
const textDelta = (index, text) => ({ type: 'text-delta', index, text });
const toolDelta = (index, id, argumentsDelta) => ({ type: 'tool-call-delta', index, id, argumentsDelta });
const blockEnd = (index, block) => ({ type: 'block-end', index, block });
const finish = (reason = { kind: 'stop' }) => ({ type: 'finish', reason });
const usage = () => ({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } });

const repeats = (count, line = '做。\n', index = 0) =>
  Array.from({ length: count }, () => reasoning(index, line));

/** 手写源：精确统计 next() 与 return() 次数，用来验证关闭协议。 */
function makeSource(items) {
  const stats = { nexts: 0, returns: 0, done: false };
  let cursor = 0;
  const iterator = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    async next() {
      stats.nexts += 1;
      if (cursor >= items.length) {
        stats.done = true;
        return { done: true, value: undefined };
      }
      return { done: false, value: items[cursor++] };
    },
    async return() {
      stats.returns += 1;
      stats.done = true;
      return { done: true, value: undefined };
    },
  };
  return { iterator, stats };
}

function guard(items, limit, onCut, decide) {
  const source = makeSource(items);
  const cuts = [];
  const stream = guardReasoning(source.iterator, limit, (cut) => {
    cuts.push(cut);
    if (onCut) onCut(cut);
  }, decide);
  return { source, cuts, stream };
}

async function drain(stream) {
  const out = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function assertIdentical(out, items) {
  assert.equal(out.length, items.length, '输出片数');
  for (let i = 0; i < items.length; i += 1) assert.strictEqual(out[i], items[i], '第 ' + i + ' 片必须原样转发');
}

/** 只核对前 count 片原样转发（截断场景后面还有合成的终止片）。 */
function assertPrefix(out, items, count) {
  assert.ok(out.length >= count, '输出片数不足：' + out.length + ' < ' + count);
  for (let i = 0; i < count; i += 1) assert.strictEqual(out[i], items[i], '第 ' + i + ' 片必须原样转发');
}

// ---------------------------------------------------------------------------
// 正常收尾
// ---------------------------------------------------------------------------

test('正常收尾：命中行后接 block-end 与 finish，全部原样转发且不截断', async () => {
  const items = [
    start(0, 'reasoning'),
    ...repeats(5),
    blockEnd(0, { type: 'reasoning', text: '做。\n'.repeat(5) }),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);
  assertIdentical(out, items);
  assert.equal(cuts.length, 0, '正常收尾不应触发 onCut');
  assert.equal(source.stats.returns, 0, '正常读尽不应主动关闭上游');
});

test('正常收尾：命中行后源直接结束，不截断也不补片', async () => {
  const items = [start(0, 'reasoning'), ...repeats(5)];
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);
  assertIdentical(out, items);
  assert.equal(cuts.length, 0);
  assert.equal(source.stats.returns, 0);
});

test('正常收尾：命中后下一片是 finish，原样转发且不补片', async () => {
  const items = [...repeats(5), finish()];
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);
  assertIdentical(out, items);
  assert.equal(cuts.length, 0);
  assert.equal(source.stats.returns, 0);
});

test('正常收尾：未封行的末尾重复不参与判定', async () => {
  const items = [
    start(0, 'reasoning'),
    ...repeats(4),
    reasoning(0, '做。'),
    reasoning(0, '做。'),
    blockEnd(0, { type: 'reasoning', text: '' }),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);
  assertIdentical(out, items);
  assert.equal(cuts.length, 0, '未封行的尾巴不能凑成第 5 次命中');
  assert.equal(source.stats.returns, 0);
});

test('正常收尾：空源与空思考片不报错、不截断', async () => {
  {
    const { source, cuts, stream } = guard([], 5);
    assert.deepEqual(await drain(stream), []);
    assert.equal(cuts.length, 0);
    assert.equal(source.stats.returns, 0);
  }
  {
    const items = [
      start(0, 'reasoning'),
      reasoning(0, ''),
      reasoning(0, '   '),
      reasoning(0, '\n\n'),
      reasoning(0, '正常思考\n'),
      blockEnd(0, { type: 'reasoning', text: '正常思考' }),
      usage(),
      finish(),
    ];
    const { source, cuts, stream } = guard(items, 5);
    const out = await drain(stream);
    assertIdentical(out, items);
    assert.equal(cuts.length, 0);
    assert.equal(source.stats.returns, 0);
  }
});

// ---------------------------------------------------------------------------
// 截断与关闭协议
// ---------------------------------------------------------------------------

test('截断：同块非空续写且无其它活动块，停止转发、补终止片、关闭上游一次', async () => {
  const items = [
    start(0, 'reasoning'),
    ...repeats(5),
    reasoning(0, '继续。\n做。\n'),
    reasoning(0, '后续正文\n'),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);

  assertPrefix(out, items, 6);
  assert.equal(out.length, 7, '只允许补一个终止片');
  assert.equal(out[6].type, 'finish');
  assert.deepEqual(out[6].reason, { kind: 'stop' });
  assert.equal(cuts.length, 1);
  assert.deepEqual(cuts[0], { index: 0, count: 5 });
  assert.equal(source.stats.returns, 1, '上游必须被关闭一次');
  assert.equal(source.stats.nexts, 7, '块起始 + 5 片 + 探读 1 片');
  assert.deepEqual(await stream.next(), { done: true, value: undefined }, '截断后生成器已结束');
  assert.equal(source.stats.returns, 1, '再次读取不得二次关闭上游');
});

test('截断：onCut 载荷只含位置与行数，不含思考正文', async () => {
  const items = [start(0, 'reasoning'), ...repeats(5), reasoning(0, '继续。\n'), finish()];
  const { cuts, stream } = guard(items, 5);
  await drain(stream);
  assert.equal(cuts.length, 1);
  assert.deepEqual(Object.keys(cuts[0]).sort(), ['count', 'index']);
  assert.ok(!JSON.stringify(cuts[0]).includes('做'), '回调不得携带思考文本');
});

test('正常收尾：命中后下一片只是空白，不算同块非空续写', async () => {
  const items = [
    start(0, 'reasoning'),
    ...repeats(5),
    reasoning(0, '\n'),
    blockEnd(0, { type: 'reasoning', text: '做。\n'.repeat(5) }),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);
  assertIdentical(out, items);
  assert.equal(cuts.length, 0);
  assert.equal(source.stats.returns, 0);
});

test('取消：消费者提前 return，上游只关闭一次且不触发 onCut', async () => {
  const items = [start(0, 'reasoning'), ...repeats(10), finish()];
  const { source, cuts, stream } = guard(items, 5);
  await stream.next();
  await stream.next();
  await stream.return();
  assert.equal(source.stats.returns, 1);
  assert.equal(cuts.length, 0);
  assert.deepEqual(await stream.next(), { done: true, value: undefined });
});

test('取消：for-await 提前 break，同样只关闭一次', async () => {
  const items = [start(0, 'reasoning'), ...repeats(10), blockEnd(0, { type: 'reasoning', text: '' }), finish()];
  const { source, cuts, stream } = guard(items, 5);
  let seen = 0;
  for await (const chunk of stream) {
    void chunk;
    seen += 1;
    if (seen === 2) break;
  }
  assert.equal(seen, 2);
  assert.equal(source.stats.returns, 1);
  assert.equal(cuts.length, 0);
});

// ---------------------------------------------------------------------------
// 交错块与多活动块
// ---------------------------------------------------------------------------

test('交错：不同 index 的行互不合并；跨块探读不算本块延续', async () => {
  const items = [
    start(0, 'reasoning'),
    start(1, 'reasoning'),
    reasoning(0, '做。\n'), reasoning(1, '分析一\n'),
    reasoning(0, '做。\n'), reasoning(1, '分析二\n'),
    reasoning(0, '做。\n'), reasoning(1, '分析三\n'),
    reasoning(0, '做。\n'), reasoning(1, '分析四\n'),
    reasoning(0, '做。\n'),
    reasoning(1, '分析五\n'),
    reasoning(0, '做。\n'),
    blockEnd(1, { type: 'reasoning', text: '' }),
    blockEnd(0, { type: 'reasoning', text: '' }),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);
  assertIdentical(out, items);
  assert.equal(cuts.length, 0, '跨 index 探读不能算本块续写');
  assert.equal(source.stats.returns, 0);
});

test('交错：块 0 的连续计数不被块 1 的行打断，只有本块活动时可截断', async () => {
  const items = [
    start(0, 'reasoning'),
    start(1, 'reasoning'),
    reasoning(0, '做。\n'), reasoning(1, '分析一\n'),
    reasoning(0, '做。\n'), reasoning(1, '分析二\n'),
    reasoning(0, '做。\n'), reasoning(1, '分析三\n'),
    reasoning(0, '做。\n'), reasoning(1, '分析四\n'),
    blockEnd(1, { type: 'reasoning', text: '' }),
    reasoning(0, '做。\n'),
    reasoning(0, '继续。\n'),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);
  assertPrefix(out, items, 12);
  assert.equal(out[12].type, 'finish');
  assert.equal(cuts.length, 1);
  assert.deepEqual(cuts[0], { index: 0, count: 5 });
  assert.equal(source.stats.returns, 1);
});

test('多活动块：文本块未闭合时同块续写保守放行，闭合后再命中才截断', async () => {
  const items = [
    start(0, 'reasoning'),
    start(1, 'text'),
    ...repeats(5),
    reasoning(0, '继续。\n'),
    blockEnd(1, { type: 'text', text: '正文' }),
    ...repeats(5),
    reasoning(0, '继续。\n'),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);

  assertPrefix(out, items, 14);
  assert.equal(out.length, 15);
  assert.equal(out[14].type, 'finish');
  assert.equal(cuts.length, 1);
  assert.deepEqual(cuts[0], { index: 0, count: 5 });
  assert.equal(source.stats.returns, 1);
});

test('多活动块：工具调用块未闭合时不截断', async () => {
  const items = [
    start(0, 'reasoning'),
    start(1, 'tool-call'),
    ...repeats(3),
    reasoning(0, '继续。\n'),
    toolDelta(1, 'call-1', '{"q":'),
    blockEnd(1, { type: 'tool-call', id: 'call-1', name: 'shell', arguments: '{}' }),
    blockEnd(0, { type: 'reasoning', text: '' }),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 3);
  const out = await drain(stream);
  assertIdentical(out, items);
  assert.equal(cuts.length, 0);
  assert.equal(source.stats.returns, 0);
});

// ---------------------------------------------------------------------------
// 行判定边界
// ---------------------------------------------------------------------------

test('行判定：空行、纯标点、明显结构行被放过且不打断连续（CRLF 归一）', async () => {
  const items = [
    start(0, 'reasoning'),
    reasoning(0, '做。\r\n'),
    reasoning(0, '\r\n'),
    reasoning(0, '。。。\n'),
    reasoning(0, '---\n'),
    reasoning(0, '```ts\n'),
    reasoning(0, '> \n'),
    reasoning(0, '做。\r\n'),
    reasoning(0, '做。\n'),
    reasoning(0, '做。\n'),
    reasoning(0, '做。\n'),
    reasoning(0, '继续。\n'),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);

  assertPrefix(out, items, 11);
  assert.equal(out.length, 12);
  assert.equal(out[11].type, 'finish');
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].count, 5);
  assert.equal(source.stats.returns, 1);
});

test('行判定：长行打断连续计数', async () => {
  const longLine = '正常分析内容'.repeat(10) + '\n';
  assert.ok(longLine.length > SHORT_LINE_MAX_CHARS);
  const items = [
    start(0, 'reasoning'),
    ...repeats(4),
    reasoning(0, longLine),
    ...repeats(4),
    reasoning(0, '继续。\n'),
    blockEnd(0, { type: 'reasoning', text: '' }),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);
  assertIdentical(out, items);
  assert.equal(cuts.length, 0);
  assert.equal(source.stats.returns, 0);
});

test('行判定：不同的短行重置连续计数', async () => {
  const items = [
    start(0, 'reasoning'),
    ...repeats(4),
    reasoning(0, '好。\n'),
    ...repeats(4),
    reasoning(0, '继续。\n'),
    blockEnd(0, { type: 'reasoning', text: '' }),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 5);
  assertIdentical(await drain(stream), items);
  assert.equal(cuts.length, 0);
});

test('行判定：同片尾部打断已命中的连续段，后续原样通过', async () => {
  for (const tail of ['已转向正常内容\n', '正常分析内容'.repeat(10) + '\n']) {
    for (const parts of [['做。\n'.repeat(3) + tail], ['做。\n', '做。\n', '做。\n' + tail]]) {
      const scanner = createLineScanner(3);
      const scanned = parts.map(part => scanner.push(part));
      assert.equal(scanned.at(-1).hit, null);
      const items = [start(0, 'reasoning'), ...parts.map(part => reasoning(0, part)),
        reasoning(0, '后续内容\n'), blockEnd(0, { type: 'reasoning', text: parts.join('') + '后续内容\n' }), finish()];
      const { cuts, stream, source } = guard(items, 3);
      assertIdentical(await drain(stream), items);
      assert.equal(cuts.length, 0);
      assert.equal(source.stats.returns, 0);
    }
  }
});

test('行判定：超长未封尾行立即清零，后续流原样透传', async () => {
  const prefix = '做。\n'.repeat(3) + 'x'.repeat(SHORT_LINE_MAX_CHARS + 1);
  const scanner = createLineScanner(3);
  assert.deepEqual(scanner.push(prefix), { hit: null, count: 0 });
  assert.equal(scanner.pendingChars, 0);
  const continuation = '后续内容\n';
  const items = [start(0, 'reasoning'), reasoning(0, prefix), reasoning(0, continuation),
    blockEnd(0, { type: 'reasoning', text: prefix + continuation }), finish()];
  const { cuts, stream, source } = guard(items, 3);
  assertIdentical(await drain(stream), items);
  assert.equal(cuts.length, 0);
  assert.equal(source.stats.returns, 0);
});

test('行判定：同片尾部有新的连续复读时仍可命中', () => {
  const scanner = createLineScanner(3);
  assert.deepEqual(scanner.push('做。\n'.repeat(5) + '再查。\n'.repeat(3)), { hit: 3, count: 3 });
  assert.deepEqual(scanner.push(''), { hit: null, count: 3 });
});

test('行判定：块结束时丢弃未封行的尾巴，块间计数不累计', async () => {
  const items = [
    start(0, 'reasoning'),
    ...repeats(4),
    blockEnd(0, { type: 'reasoning', text: '' }),
    start(0, 'reasoning'),
    reasoning(0, '做。\n'),
    blockEnd(0, { type: 'reasoning', text: '' }),
    start(1, 'reasoning'),
    ...repeats(4, '做。\n', 1),
    blockEnd(1, { type: 'reasoning', text: '' }),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 5);
  assertIdentical(await drain(stream), items);
  assert.equal(cuts.length, 0, '块边界与不同 index 都不累计连续');
  assert.equal(source.stats.returns, 0);
});

test('delta-only 协议：没有 block-start/end 也能识别并安全截断', async () => {
  const items = [...repeats(5), reasoning(0, '继续。\n'), finish()];
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);
  assertPrefix(out, items, 5);
  assert.equal(out.length, 6);
  assert.equal(out[5].type, 'finish');
  assert.equal(cuts.length, 1);
  assert.equal(source.stats.returns, 1);
});

// ---------------------------------------------------------------------------
// 有界缓存
// ---------------------------------------------------------------------------

test('缓存有界：超长未封行文本立即丢弃，扫描器不保留正文', () => {
  const scanner = createLineScanner(3);
  const huge = 'x'.repeat(200_000);
  const first = scanner.push(huge);
  assert.equal(first.hit, null);
  assert.equal(first.count, 0);
  assert.equal(scanner.pendingChars, 0, '超长行不得留下前缀');
  assert.ok(scanner.pendingChars <= SHORT_LINE_MAX_CHARS);

  scanner.push('\n');
  assert.equal(scanner.consecutive, 0, '超长行封行后按长行打断连续');

  const hit = scanner.push('做。\n做。\n做。\n');
  assert.equal(hit.hit, 3);
  assert.equal(hit.count, 3);
  assert.equal(scanner.pendingChars, 0);
});

test('缓存有界：短前缀最多保留 SHORT_LINE_MAX_CHARS 个字符', () => {
  const scanner = createLineScanner(5);
  scanner.push('a'.repeat(10));
  assert.equal(scanner.pendingChars, 10);
  scanner.push('b'.repeat(SHORT_LINE_MAX_CHARS));
  assert.equal(scanner.pendingChars, 0, '累加超限后必须丢弃前缀');

  const scanner2 = createLineScanner(2);
  scanner2.push('好。');
  assert.equal(scanner2.pendingChars, 2);
  scanner2.push('\n好。\n');
  assert.equal(scanner2.consecutive, 2);
  assert.equal(scanner2.pendingChars, 0);
});

test('缓存有界：一次性超长思考片不会计数，后续短行仍可正常判定', async () => {
  const items = [
    start(0, 'reasoning'),
    reasoning(0, 'x'.repeat(100_000)),
    reasoning(0, '\n'),
    ...repeats(3),
    reasoning(0, '继续。\n'),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 3);
  const out = await drain(stream);
  assert.equal(out.length, 7);
  assert.equal(out[1].text.length, 100_000, '正文片必须原样转发');
  assert.equal(out[6].type, 'finish');
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].count, 3);
  assert.equal(source.stats.returns, 1);
});

// ---------------------------------------------------------------------------
// 参数与协议尾片
// ---------------------------------------------------------------------------

test('参数：limit 必须是正整数，source 必须是异步可迭代，onCut 必须是函数', () => {
  for (const limit of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null]) {
    assert.throws(() => guardReasoning(makeSource([]).iterator, limit), RangeError, 'limit=' + String(limit));
  }
  assert.throws(() => guardReasoning(null, 3), TypeError);
  assert.throws(() => guardReasoning({}, 3), TypeError);
  assert.throws(() => guardReasoning(makeSource([]).iterator, 3, 'onCut'), TypeError);
  assert.throws(() => createLineScanner(0), RangeError);
});

test('协议：usage 与 finish 等控制片原样转发，不改变顺序', async () => {
  const items = [
    start(0, 'reasoning'),
    reasoning(0, '正常思考\n'),
    blockEnd(0, { type: 'reasoning', text: '正常思考' }),
    usage(),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);
  assertIdentical(out, items);
  assert.equal(cuts.length, 0);
  assert.equal(source.stats.returns, 0);
});

test('协议：文本块 delta 只作为活动块参与判断，不进入思考行检测', async () => {
  const items = [
    start(0, 'text'),
    textDelta(0, '做。\n做。\n做。\n做。\n做。\n'),
    blockEnd(0, { type: 'text', text: '' }),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 5);
  assertIdentical(await drain(stream), items);
  assert.equal(cuts.length, 0, '正文不在检测范围');
  assert.equal(source.stats.returns, 0);
});

// ---------------------------------------------------------------------------
// 第四参数 decide（安全截断前的判定闸门）
// ---------------------------------------------------------------------------

test('决定：decide 返回 true 与省略等价，命中即截断', async () => {
  const items = [start(0, 'reasoning'), ...repeats(5), reasoning(0, '继续。\n'), finish()];
  let calls = 0;
  const { source, cuts, stream } = guard(items, 5, undefined, () => {
    calls += 1;
    return true;
  });
  const out = await drain(stream);
  assertPrefix(out, items, 6);
  assert.equal(out.length, 7);
  assert.equal(out[6].type, 'finish');
  assert.equal(cuts.length, 1);
  assert.deepEqual(cuts[0], { index: 0, count: 5 });
  assert.equal(calls, 1, '安全截断条件成立时恰好询问一次');
  assert.equal(source.stats.returns, 1, '允许截断时上游只关闭一次');
});

test('决定：decide 返回 false 时按顺序原样透传、不关闭上游、仍调用 onCut 一次', async () => {
  const items = [
    start(0, 'reasoning'),
    ...repeats(5),
    reasoning(0, '继续。\n'),
    reasoning(0, '后续正文\n'),
    blockEnd(0, { type: 'reasoning', text: '' }),
    finish(),
  ];
  let calls = 0;
  const { source, cuts, stream } = guard(items, 5, undefined, () => {
    calls += 1;
    return false;
  });
  const out = await drain(stream);
  assertIdentical(out, items);
  assert.equal(calls, 1);
  assert.equal(cuts.length, 1);
  assert.deepEqual(cuts[0], { index: 0, count: 5 });
  assert.deepEqual(Object.keys(cuts[0]).sort(), ['count', 'index'], '放行时 onCut 载荷不变');
  assert.equal(source.stats.returns, 0, '观察路径不得关闭上游');
  assert.equal(source.stats.nexts, items.length + 1, '读尽全部片（含尾部 done）');
});

test('决定：只在安全截断条件成立时询问 decide', async () => {
  const whitespace = [
    start(0, 'reasoning'),
    ...repeats(5),
    reasoning(0, '\n'),
    blockEnd(0, { type: 'reasoning', text: '' }),
    finish(),
  ];
  let calls = 0;
  const first = guard(whitespace, 5, undefined, () => {
    calls += 1;
    return false;
  });
  assertIdentical(await drain(first.stream), whitespace);
  assert.equal(calls, 0, '空白续写不满足安全截断条件，不得询问 decide');
  assert.equal(first.cuts.length, 0);

  const interleaved = [
    start(0, 'reasoning'),
    start(1, 'text'),
    ...repeats(5),
    reasoning(0, '继续。\n'),
    blockEnd(1, { type: 'text', text: '正文' }),
    blockEnd(0, { type: 'reasoning', text: '' }),
    finish(),
  ];
  let calls2 = 0;
  const second = guard(interleaved, 5, undefined, () => {
    calls2 += 1;
    return false;
  });
  assertIdentical(await drain(second.stream), interleaved);
  assert.equal(calls2, 0, '仍有其它活动块时不得询问 decide');
  assert.equal(second.cuts.length, 0);
  assert.equal(second.source.stats.returns, 0);
});

test('决定：decide 一直返回 false 时，每个命中间隔各调用一次 onCut', async () => {
  const items = [
    start(0, 'reasoning'),
    reasoning(0, '做。\n'), reasoning(0, '做。\n'), reasoning(0, '做。\n'),
    reasoning(0, '继续。\n'),
    reasoning(0, '做。\n'), reasoning(0, '做。\n'), reasoning(0, '做。\n'),
    reasoning(0, '继续。\n'),
    finish(),
  ];
  let calls = 0;
  const { source, cuts, stream } = guard(items, 3, undefined, () => {
    calls += 1;
    return false;
  });
  const out = await drain(stream);
  assertIdentical(out, items);
  assert.equal(calls, 2);
  assert.equal(cuts.length, 2);
  assert.deepEqual(cuts[0], { index: 0, count: 3 });
  assert.deepEqual(cuts[1], { index: 0, count: 3 });
  assert.equal(source.stats.returns, 0);
});

test('决定：decide 抛错原样传给消费者，上游只关闭一次且不补终止片', async () => {
  const boom = new Error('decide boom');
  const items = [start(0, 'reasoning'), ...repeats(5), reasoning(0, '继续。\n'), finish()];
  const { source, cuts, stream } = guard(items, 5, undefined, () => {
    throw boom;
  });
  const seen = [];
  await assert.rejects(async () => {
    for await (const chunk of stream) seen.push(chunk);
  }, (error) => error === boom);
  assertPrefix(seen, items, 6);
  assert.equal(seen.length, 6);
  assert.equal(cuts.length, 0, 'decide 抛错时尚未调用 onCut');
  assert.equal(source.stats.returns, 1, '异常退出时只关闭上游一次');
});

test('参数：decide 必须是函数或省略', () => {
  for (const decide of ['decide', 1, {}, null]) {
    assert.throws(() => guardReasoning(makeSource([]).iterator, 3, undefined, decide), TypeError, 'decide=' + String(decide));
  }
  assert.doesNotThrow(() => guardReasoning(makeSource([]).iterator, 3, undefined, undefined));
});

// ---------------------------------------------------------------------------
// 有界活动块（MAX_ACTIVE_BLOCKS）
// ---------------------------------------------------------------------------

const textStarts = count => Array.from({ length: count }, (_, i) => start(i, 'text'));
const textEnds = count => Array.from({ length: count }, (_, i) => blockEnd(i, { type: 'text', text: '' }));

test('有界：活动块恰好达到上限时仍继续跟踪', async () => {
  const items = [
    ...textStarts(MAX_ACTIVE_BLOCKS),
    ...textEnds(MAX_ACTIVE_BLOCKS),
    start(0, 'reasoning'),
    ...repeats(5),
    reasoning(0, '继续。\n'),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);
  assertPrefix(out, items, items.length - 2);
  assert.equal(out.length, items.length - 1, '探读片被丢弃、只补一个终止片');
  assert.equal(out.at(-1).type, 'finish');
  assert.equal(cuts.length, 1);
  assert.deepEqual(cuts[0], { index: 0, count: 5 });
  assert.equal(source.stats.returns, 1);
});

test('有界：超出一个活动块即清空跟踪，此后原样透传且不关闭上游', async () => {
  const items = [
    ...textStarts(MAX_ACTIVE_BLOCKS + 1),
    ...textEnds(MAX_ACTIVE_BLOCKS + 1),
    start(0, 'reasoning'),
    ...repeats(5),
    reasoning(0, '继续。\n'),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);
  assertIdentical(out, items);
  assert.equal(cuts.length, 0, '跟踪已停止，不再命中');
  assert.equal(source.stats.returns, 0, '不得因超限关闭上游');
});

test('有界：重复使用已有块索引不占额外名额', async () => {
  const items = [
    ...textStarts(MAX_ACTIVE_BLOCKS),
    start(0, 'reasoning'), // 复用索引 0：不新增名额
    ...textEnds(MAX_ACTIVE_BLOCKS).slice(1), // 关闭 1..63，只剩块 0
    ...repeats(5),
    reasoning(0, '继续。\n'),
    finish(),
  ];
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);
  assertPrefix(out, items, items.length - 2);
  assert.equal(out.length, items.length - 1);
  assert.equal(out.at(-1).type, 'finish');
  assert.equal(cuts.length, 1, '复用索引不触发超限，命中仍可截断');
  assert.equal(source.stats.returns, 1);
});

test('有界：delta-only 流的隐式活动块同样受上限约束', async () => {
  const items = [];
  for (let i = 0; i < MAX_ACTIVE_BLOCKS; i += 1) items.push(reasoning(i, '片段' + i + '\n'));
  items.push(reasoning(MAX_ACTIVE_BLOCKS, '溢出块\n')); // 第 65 个活动块触发停机
  items.push(...repeats(5), reasoning(0, '继续。\n'), finish());
  const { source, cuts, stream } = guard(items, 5);
  const out = await drain(stream);
  assertIdentical(out, items);
  assert.equal(cuts.length, 0);
  assert.equal(source.stats.returns, 0);
});

// ---------------------------------------------------------------------------
// 上游异常
// ---------------------------------------------------------------------------

/** 读完 items 后不返回 done，而是抛错的源。 */
function makeFailingSource(items, error) {
  let cursor = 0;
  const stats = { nexts: 0, returns: 0 };
  const iterator = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    async next() {
      stats.nexts += 1;
      if (cursor >= items.length) throw error;
      return { done: false, value: items[cursor++] };
    },
    async return() {
      stats.returns += 1;
      return { done: true, value: undefined };
    },
  };
  return { iterator, stats };
}

test('上游异常：next 抛错原样传给消费者，只关闭一次且不触发 onCut', async () => {
  const boom = new Error('upstream boom');
  const items = [start(0, 'reasoning'), reasoning(0, '正常思考\n'), reasoning(0, '做。\n')];
  const source = makeFailingSource(items, boom);
  const cuts = [];
  const stream = guardReasoning(source.iterator, 5, (cut) => cuts.push(cut));
  const seen = [];
  await assert.rejects(async () => {
    for await (const chunk of stream) seen.push(chunk);
  }, (error) => error === boom);
  assertIdentical(seen, items);
  assert.equal(cuts.length, 0);
  assert.equal(source.stats.returns, 1, '异常退出时释放上游一次');
});

test('上游异常：命中探读期间抛错不得被吞掉，也不合成终止片', async () => {
  const boom = new Error('probe boom');
  const items = [start(0, 'reasoning'), ...repeats(5)];
  const source = makeFailingSource(items, boom);
  const cuts = [];
  const stream = guardReasoning(source.iterator, 5, (cut) => cuts.push(cut));
  const seen = [];
  await assert.rejects(async () => {
    for await (const chunk of stream) seen.push(chunk);
  }, (error) => error === boom);
  assertIdentical(seen, items);
  assert.equal(cuts.length, 0);
  assert.equal(source.stats.returns, 1);
});
