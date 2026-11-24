import test from 'node:test';
import assert from 'node:assert/strict';
import { observeFuzzy, FUZZY_LIMITS } from '../src/repetition/fuzzy-observer.ts';

const start = (index, blockType = 'reasoning') => ({ type: 'block-start', index, blockType });
const delta = (index, text) => ({ type: 'reasoning-delta', index, text });
const end = (index, text = '') => ({ type: 'block-end', index, block: { type: 'reasoning', text } });
const finish = { type: 'finish', reason: { kind: 'stop' } };
const stream = frames => (async function* () { yield* frames; })();
const run = (text, parts = [text], index = 0) => [start(index), ...parts.map(part => delta(index, part)), end(index, text)];
const tick = String.fromCharCode(96).repeat(3);

const collect = async (frames, onHit = () => {}) => {
  const hits = [];
  const output = await Array.fromAsync(observeFuzzy(stream(frames), count => { hits.push(count); onHit(count); }));
  assert.equal(output.length, frames.length);
  assert.ok(output.every((frame, index) => frame === frames[index]), 'frames must pass through unchanged');
  return hits;
};

const near = [
  '继续检查这个模块的实现细节',
  '继续检查这个模块的实现细节。',
  '继续检查这个模块的实现细节了',
  '继续检查这个模块的实现细节',
];
const nearText = near.join('\n') + '\n';
const otherNear = [
  '再做一次同样的核对动作',
  '再做一次同样的核对动作。',
  '再做一次同样的核对动作了',
  '再做一次同样的核对动作',
];
const otherText = otherNear.join('\n') + '\n';

test('four near-duplicate lines report the run length exactly once', async () => {
  const frames = [...run(nearText), finish];
  const hits = await collect(frames);
  assert.deepEqual(hits, [4]);
  assert.ok(hits.every(count => Number.isSafeInteger(count)));
});

test('exactly identical lines are left to the exact guard', async () => {
  const frames = [...run('继续检查这个模块的实现细节\n'.repeat(8)), finish];
  assert.deepEqual(await collect(frames), []);
});

test('number changes keep the group negative', async () => {
  const text = [
    '检查第 3 个依赖是否已经加载',
    '检查第 3 个依赖是否已经加载。',
    '检查第 4 个依赖是否已经加载',
    '检查第 4 个依赖是否已经加载。',
    '检查第 5 个依赖是否已经加载',
    '检查第 5 个依赖是否已经加载。',
  ].join('\n') + '\n';
  assert.deepEqual(await collect([...run(text), finish]), []);
  assert.deepEqual(await collect([...run(text.replaceAll('个依赖是否已经加载', '项依赖是否已经加载')), finish]), []);
});

test('different targets keep the group negative', async () => {
  const text = [
    '继续编辑 src/a.ts 里的实现细节',
    '继续编辑 src/a.ts 里的实现细节。',
    '继续编辑 src/b.ts 里的实现细节',
    '继续编辑 src/b.ts 里的实现细节。',
    '继续编辑 src/c.ts 里的实现细节',
  ].join('\n') + '\n';
  assert.deepEqual(await collect([...run(text), finish]), []);
});

test('fenced code is never counted', async () => {
  const fenced = tick + 'text\n' + nearText + tick + '\n';
  assert.deepEqual(await collect([...run(fenced), finish]), []);
  const unclosed = tick + 'text\n' + nearText;
  assert.deepEqual(await collect([...run(unclosed), finish]), []);
});

test('code-shaped lines outside a fence are never counted', async () => {
  const code = [
    'const value = read(x);',
    'const value = read(y);',
    'const value = read(z);',
    'const value = read(w);',
  ].join('\n') + '\n';
  assert.deepEqual(await collect([...run(code), finish]), []);
});

test('a fence resets the group instead of joining across it', async () => {
  const text = [near[0], near[1], tick + 'js', 'console.log(1);', tick, near[2], near[0]].join('\n') + '\n';
  assert.deepEqual(await collect([...run(text), finish]), []);
});

test('arbitrary chunk splits preserve the hit', async () => {
  for (let cut = 0; cut <= nearText.length; cut += 1) {
    const report = await collect([...run(nearText, [nearText.slice(0, cut), nearText.slice(cut)]), finish]);
    assert.deepEqual(report, [4], 'split at ' + cut);
  }
});

test('one character per delta preserves the hit', async () => {
  assert.deepEqual(await collect([...run(nearText, [...nearText]), finish]), [4]);
});

test('CRLF line endings preserve the hit', async () => {
  assert.deepEqual(await collect([...run(nearText.replaceAll('\n', '\r\n')), finish]), [4]);
});

test('reasoning blocks are isolated from each other', async () => {
  const frames = [
    start(0), start(1),
    delta(0, near[0] + '\n'), delta(1, near[0] + '\n'),
    delta(0, near[1] + '\n'), delta(1, near[1] + '\n'),
    delta(0, near[2] + '\n'), delta(1, near[2] + '\n'),
    end(0), end(1), finish,
  ];
  assert.deepEqual(await collect(frames), []);
  assert.deepEqual(await collect([...run(nearText, [nearText], 7), finish]), [4]);
});

test('the active block limit stops observation instead of reporting', async () => {
  const frames = [
    ...Array.from({ length: FUZZY_LIMITS.blocks + 1 }, (_, index) => start(index)),
    delta(0, nearText), end(0), finish,
  ];
  assert.deepEqual(await collect(frames), []);
});

test('at most one report per input stream', async () => {
  const hits = await collect([...run(nearText + otherText), finish]);
  assert.deepEqual(hits, [4]);
});

test('a callback failure cannot interrupt the stream', async () => {
  const frames = [...run(nearText), finish];
  let calls = 0;
  const hits = await collect(frames, () => { calls += 1; throw new Error('fixture'); });
  assert.deepEqual(hits, [4]);
  assert.equal(calls, 1);
});

test('visible progress breaks the run', async () => {
  const frames = [
    start(0),
    delta(0, near.slice(0, 2).join('\n') + '\n'),
    start(1, 'text'), delta(1, 'answer'),
    delta(0, near.slice(2).join('\n') + '\n'),
    end(0), finish,
  ];
  assert.deepEqual(await collect(frames), []);
});

test('blank and structural lines break the run', async () => {
  assert.deepEqual(await collect([...run(near.join('\n\n') + '\n'), finish]), []);
  const indented = near.map(line => '  ' + line).join('\n') + '\n';
  assert.deepEqual(await collect([...run(indented), finish]), []);
  const bulleted = near.map(line => '- ' + line).join('\n') + '\n';
  assert.deepEqual(await collect([...run(bulleted), finish]), []);
  const headed = near.map(line => '## ' + line).join('\n') + '\n';
  assert.deepEqual(await collect([...run(headed), finish]), []);
  const tabular = near.map(line => '| ' + line + ' |').join('\n') + '\n';
  assert.deepEqual(await collect([...run(tabular), finish]), []);
});

test('an unterminated tail is never evaluated', async () => {
  assert.deepEqual(await collect([...run(near.join('\n')), finish]), []);
});

test('an overlong opening fence still suppresses the code after it', async () => {
  const opener = tick + 'js ' + 'x'.repeat(FUZZY_LIMITS.line);
  const text = opener + '\n' + nearText + tick + '\n';
  assert.deepEqual(await collect([...run(text), finish]), []);
});

test('an overlong line is dropped instead of compared', async () => {
  const long = '汉'.repeat(FUZZY_LIMITS.line) + '。';
  const text = [long, long + '了', long + '的', long].join('\n') + '\n';
  assert.deepEqual(await collect([...run(text), finish]), []);
});

test('malformed frames pass through without breaking observation', async () => {
  const frames = [null, undefined, {}, { type: 'reasoning-delta' }, { type: 'block-start', index: 'x', blockType: 'reasoning' }, { type: 'usage', usage: {} }, ...run(nearText), finish];
  assert.deepEqual(await collect(frames), [4]);
});

test('invalid arguments throw synchronously', () => {
  assert.throws(() => observeFuzzy(null, () => {}), TypeError);
  assert.throws(() => observeFuzzy(stream([]), null), TypeError);
});

test('a hit is reported without pulling another frame', async () => {
  const frames = [start(0), delta(0, nearText), end(0), finish];
  let pulls = 0;
  let hits = 0;
  async function* input() {
    for (const frame of frames) { pulls += 1; yield frame; }
  }
  const iterator = observeFuzzy(input(), () => { hits += 1; });
  assert.equal((await iterator.next()).value, frames[0]);
  assert.equal(hits, 0);
  assert.equal((await iterator.next()).value, frames[1]);
  assert.equal(hits, 1);
  assert.equal(pulls, 2);
  await iterator.return();
});

test('a fence split into single characters still suppresses code', async () => {
  const fenced = tick + 'text\n' + nearText + tick + '\n';
  assert.deepEqual(await collect([...run(fenced, [...fenced]), finish]), []);
});

test('usage metadata between lines does not break the run', async () => {
  const frames = [
    start(0),
    delta(0, near.slice(0, 3).join('\n') + '\n'),
    { type: 'usage', usage: {} },
    delta(0, near[3] + '\n'),
    end(0), finish,
  ];
  assert.deepEqual(await collect(frames), [4]);
});

test('an exact run followed by a near line reports the full run length', async () => {
  const frames = [...run('继续检查这个模块的实现细节\n'.repeat(4) + near[1] + '\n'), finish];
  assert.deepEqual(await collect(frames), [5]);
});

test('a line shorter than the minimum is never evidence', async () => {
  const text = ['继续。', '继续!', '继续做。', '继续？', '继续。'].join('\n') + '\n';
  assert.deepEqual(await collect([...run(text), finish]), []);
});

test('a source error propagates and the upstream closes once', async () => {
  let closed = 0;
  async function* input() {
    try {
      yield start(0);
      yield delta(0, nearText);
      throw new Error('source failed');
    } finally {
      closed += 1;
    }
  }
  const seen = [];
  await assert.rejects(async () => {
    for await (const frame of observeFuzzy(input(), () => {})) seen.push(frame);
  }, /source failed/);
  assert.equal(seen.length, 2);
  assert.equal(closed, 1);
});

test('cancellation after a hit closes the upstream exactly once', async () => {
  const frames = [start(0), delta(0, nearText), end(0), finish];
  let closed = 0;
  async function* input() {
    try { for (const frame of frames) yield frame; } finally { closed += 1; }
  }
  const iterator = observeFuzzy(input(), () => {});
  await iterator.next();
  await iterator.next();
  await iterator.return();
  assert.equal(closed, 1);
});

test('short lines may differ by one character', async () => {
  const text = ['继续做核对', '继续做核对。', '继续做核对！', '继续做核对'].join('\n') + '\n';
  assert.deepEqual(await collect([...run(text), finish]), [4]);
});

test('two edits on a short line are already too different', async () => {
  const text = ['继续做核对', '继续做验证', '继续做核对', '继续做验证', '继续做核对'].join('\n') + '\n';
  assert.deepEqual(await collect([...run(text), finish]), []);
});

test('long lines tolerate two edits but not three', async () => {
  const anchor = '继续检查这个模块的实现细节';
  const twoEdits = '继续检查这个组件的实现细节';
  const threeEdits = '继续检查那个零件的实现细节';
  assert.deepEqual(await collect([...run([anchor, twoEdits, anchor, twoEdits].join('\n') + '\n'), finish]), [4]);
  assert.deepEqual(await collect([...run([anchor, threeEdits, anchor, threeEdits].join('\n') + '\n'), finish]), []);
});

test('consumer cancellation closes the upstream exactly once', async () => {
  const frames = [...run(nearText), finish];
  let closed = 0;
  async function* input() {
    try { for (const frame of frames) yield frame; } finally { closed += 1; }
  }
  const iterator = observeFuzzy(input(), () => {});
  await iterator.next();
  await iterator.return();
  assert.equal(closed, 1);
});
