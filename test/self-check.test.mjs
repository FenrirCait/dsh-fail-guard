// dsh-fail-guard · 自检内核测试（独立实现）
// 运行：node --test test/self-check.test.mjs
// 被测对象是构建产物 lib/self-check.js（npm run build 或独立编译 src/self-check.ts 生成）。
// 本文件不启动会话、不读环境、不调用真实工具：自检内核本身也没有这些依赖，测试顺带验证这一点。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const libEntry = join(here, '..', 'lib', 'self-check.js');

assert.ok(
  existsSync(libEntry),
  '缺少构建产物 lib/self-check.js：先运行 npm run build（或独立编译 src/self-check.ts）',
);
const mod = await import(pathToFileURL(libEntry).href);
const runSelfCheck = mod.runSelfCheck ?? mod.default?.runSelfCheck;
assert.equal(typeof runSelfCheck, 'function', '模块必须导出 runSelfCheck()');

/** 与 src/options.ts 的 DEFAULTS 对齐的基准配置。 */
const BASE = Object.freeze({
  failureEnabled: true,
  failureLimit: 3,
  repeatEnabled: true,
  repeatLimit: 5,
  resumeOnRepeat: false,
  observeOnly: false,
});

/** 固定的样本条数：失败 6 次、复读 8 行（见 src/self-check.ts）。 */
const FAILURE_SAMPLE = 6;
const REPEAT_SAMPLE = 8;

const ACTIONS = new Set(['disabled', 'none', 'observed', 'notified', 'cut']);

const options = (patch = {}) => Object.freeze({ ...BASE, ...patch });
const rowsByRule = (results) => {
  assert.ok(Array.isArray(results), '结果必须是数组');
  const failure = results.filter((row) => row.rule === 'failure');
  const repeat = results.filter((row) => row.rule === 'repeat');
  assert.equal(failure.length, 1, 'failure 结果必须恰好一条');
  assert.equal(repeat.length, 1, 'repeat 结果必须恰好一条');
  return { failure: failure[0], repeat: repeat[0] };
};

test('契约：两条结果、顺序固定 failure → repeat、字段固定且冻结', async () => {
  const results = await runSelfCheck(options());
  assert.deepEqual(results.map((row) => row.rule), ['failure', 'repeat'], '顺序必须固定');
  assert.ok(Object.isFrozen(results), '结果数组必须冻结');
  for (const row of results) {
    assert.ok(Object.isFrozen(row), '每一条结果必须冻结');
    assert.deepEqual(
      Object.keys(row).sort(),
      ['action', 'inputCount', 'rule', 'threshold', 'wouldResume'],
      '字段必须恰好是这五个',
    );
    assert.ok(ACTIONS.has(row.action), 'action 必须是契约里的取值：' + row.action);
    assert.ok(Number.isInteger(row.inputCount) && row.inputCount >= 0, 'inputCount 必须是自然数');
    assert.ok(Number.isInteger(row.threshold), 'threshold 必须是整数');
    assert.equal(typeof row.wouldResume, 'boolean');
  }
});

test('默认配置：失败 6 次/阈值 3 通知，复读 8 行/阈值 5 截断，均不续跑', async () => {
  const { failure, repeat } = rowsByRule(await runSelfCheck(options()));
  assert.deepEqual(failure, {
    rule: 'failure',
    inputCount: FAILURE_SAMPLE,
    threshold: 3,
    action: 'notified',
    wouldResume: false,
  });
  assert.deepEqual(repeat, {
    rule: 'repeat',
    inputCount: REPEAT_SAMPLE,
    threshold: 5,
    action: 'cut',
    wouldResume: false,
  });
});

test('观察模式：命中只记录（observed），两条都不续跑', async () => {
  const { failure, repeat } = rowsByRule(
    await runSelfCheck(options({ observeOnly: true, resumeOnRepeat: true })),
  );
  assert.equal(failure.action, 'observed');
  assert.equal(repeat.action, 'observed');
  assert.equal(failure.wouldResume, false, '观察模式不得续跑');
  assert.equal(repeat.wouldResume, false, '观察模式即使开启 resumeOnRepeat 也不得续跑');
  // 观察只改变处置标签，阈值与样本条数保持不变。
  assert.equal(failure.threshold, 3);
  assert.equal(repeat.threshold, 5);
  assert.equal(failure.inputCount, FAILURE_SAMPLE);
  assert.equal(repeat.inputCount, REPEAT_SAMPLE);
});

test('resumeOnRepeat：只跟随复读截断，失败通知永不续跑', async () => {
  const { failure, repeat } = rowsByRule(await runSelfCheck(options({ resumeOnRepeat: true })));
  assert.equal(repeat.action, 'cut');
  assert.equal(repeat.wouldResume, true, '复读截断且开启 resumeOnRepeat 时应续跑一次');
  assert.equal(failure.action, 'notified');
  assert.equal(failure.wouldResume, false, '失败通知不触发续跑');
});

test('停用规则：引擎未运行（disabled、0 条输入），另一条不受影响', async () => {
  const onlyRepeat = rowsByRule(await runSelfCheck(options({ failureEnabled: false })));
  assert.deepEqual(onlyRepeat.failure, {
    rule: 'failure',
    inputCount: 0,
    threshold: 3,
    action: 'disabled',
    wouldResume: false,
  });
  assert.equal(onlyRepeat.repeat.action, 'cut', '停用失败规则不应影响复读');

  const onlyFailure = rowsByRule(await runSelfCheck(options({ repeatEnabled: false })));
  assert.deepEqual(onlyFailure.repeat, {
    rule: 'repeat',
    inputCount: 0,
    threshold: 5,
    action: 'disabled',
    wouldResume: false,
  });
  assert.equal(onlyFailure.failure.action, 'notified', '停用复读不应影响失败');

  const both = rowsByRule(await runSelfCheck(options({ failureEnabled: false, repeatEnabled: false })));
  assert.equal(both.failure.action, 'disabled');
  assert.equal(both.repeat.action, 'disabled');
  assert.equal(both.failure.inputCount, 0);
  assert.equal(both.repeat.inputCount, 0);
});

test('失败阈值扫描 2–12：阈值不超过样本 6 次才通知', async () => {
  for (let limit = 2; limit <= 12; limit += 1) {
    const { failure } = rowsByRule(await runSelfCheck(options({ failureLimit: limit })));
    assert.equal(failure.threshold, limit, '阈值必须原样出现在结果里');
    assert.equal(failure.inputCount, FAILURE_SAMPLE);
    assert.equal(failure.action, limit <= FAILURE_SAMPLE ? 'notified' : 'none', '阈值 ' + limit);
    assert.equal(failure.wouldResume, false);
  }
});

test('失败阈值扫描（观察模式）：命中记 observed，未命中记 none', async () => {
  for (let limit = 2; limit <= 12; limit += 1) {
    const { failure } = rowsByRule(await runSelfCheck(options({ failureLimit: limit, observeOnly: true })));
    assert.equal(failure.action, limit <= FAILURE_SAMPLE ? 'observed' : 'none', '阈值 ' + limit);
  }
});

test('复读阈值扫描 3–15：阈值不超过样本 8 行才截断', async () => {
  for (let limit = 3; limit <= 15; limit += 1) {
    const { repeat } = rowsByRule(await runSelfCheck(options({ repeatLimit: limit })));
    assert.equal(repeat.threshold, limit);
    assert.equal(repeat.inputCount, REPEAT_SAMPLE);
    assert.equal(repeat.action, limit <= REPEAT_SAMPLE ? 'cut' : 'none', '阈值 ' + limit);
    assert.equal(repeat.wouldResume, false);
  }
});

test('复读阈值扫描（观察模式）：命中记 observed，未命中记 none', async () => {
  for (let limit = 3; limit <= 15; limit += 1) {
    const { repeat } = rowsByRule(await runSelfCheck(options({ repeatLimit: limit, observeOnly: true })));
    assert.equal(repeat.action, limit <= REPEAT_SAMPLE ? 'observed' : 'none', '阈值 ' + limit);
  }
});

test('边界：阈值等于样本条数仍命中，超出 1 条即不命中', async () => {
  const atEdge = rowsByRule(await runSelfCheck(options({ failureLimit: FAILURE_SAMPLE, repeatLimit: REPEAT_SAMPLE })));
  assert.equal(atEdge.failure.action, 'notified');
  assert.equal(atEdge.repeat.action, 'cut');

  const overEdge = rowsByRule(
    await runSelfCheck(options({ failureLimit: FAILURE_SAMPLE + 1, repeatLimit: REPEAT_SAMPLE + 1 })),
  );
  assert.equal(overEdge.failure.action, 'none');
  assert.equal(overEdge.repeat.action, 'none');
});

test('两条规则互相独立：阈值、停用与续跑判定互不串扰', async () => {
  const first = rowsByRule(await runSelfCheck(options({ failureLimit: 3, repeatLimit: 15, resumeOnRepeat: true })));
  assert.equal(first.failure.action, 'notified');
  assert.equal(first.repeat.action, 'none', '复读阈值超样本时不命中');
  assert.equal(first.repeat.wouldResume, false);

  const second = rowsByRule(await runSelfCheck(options({ failureLimit: 12, repeatLimit: 5, resumeOnRepeat: true })));
  assert.equal(second.failure.action, 'none');
  assert.equal(second.repeat.action, 'cut');
  assert.equal(second.repeat.wouldResume, true, '失败未命中不得压掉复读的续跑判定');

  const third = rowsByRule(
    await runSelfCheck(options({ failureLimit: 3, repeatLimit: 5, resumeOnRepeat: true, observeOnly: true })),
  );
  assert.equal(third.failure.action, 'observed');
  assert.equal(third.repeat.action, 'observed');
  assert.equal(third.failure.wouldResume, false);
  assert.equal(third.repeat.wouldResume, false);
});

test('无副作用：重复调用结果一致、不改写配置、并发调用互不串扰', async () => {
  const input = options({ resumeOnRepeat: true, repeatLimit: 7 });
  const snapshot = { ...input };
  const first = await runSelfCheck(input);
  const second = await runSelfCheck(input);
  assert.deepEqual(first, second, '同样配置必须得到同样结果');
  assert.deepEqual({ ...input }, snapshot, '不得改写调用方配置');
  assert.notStrictEqual(first[0], second[0], '每次调用应返回独立对象');
  assert.notStrictEqual(first[1], second[1]);

  const [hit, miss] = await Promise.all([
    runSelfCheck(options({ failureLimit: 2, repeatLimit: 3 })),
    runSelfCheck(options({ failureLimit: 12, repeatLimit: 15 })),
  ]);
  assert.equal(rowsByRule(hit).failure.action, 'notified');
  assert.equal(rowsByRule(hit).repeat.action, 'cut');
  assert.equal(rowsByRule(miss).failure.action, 'none');
  assert.equal(rowsByRule(miss).repeat.action, 'none');
});

test('有界防御：越界或非法阈值被夹取/回落，不抛异常', async () => {
  const low = rowsByRule(await runSelfCheck(options({ failureLimit: 1, repeatLimit: 1 })));
  assert.equal(low.failure.threshold, 2, '低于下限夹到 2');
  assert.equal(low.repeat.threshold, 3, '低于下限夹到 3');
  assert.equal(low.failure.action, 'notified');
  assert.equal(low.repeat.action, 'cut');

  const high = rowsByRule(await runSelfCheck(options({ failureLimit: 99, repeatLimit: 99 })));
  assert.equal(high.failure.threshold, 12, '高于上限夹到 12');
  assert.equal(high.repeat.threshold, 15, '高于上限夹到 15');
  assert.equal(high.failure.action, 'none');
  assert.equal(high.repeat.action, 'none');

  const nan = rowsByRule(await runSelfCheck(options({ failureLimit: Number.NaN, repeatLimit: Number.POSITIVE_INFINITY })));
  assert.equal(nan.failure.threshold, 3, '非有限值回落默认');
  assert.equal(nan.repeat.threshold, 5);

  const fraction = rowsByRule(await runSelfCheck(options({ failureLimit: 3.9, repeatLimit: 4.9 })));
  assert.equal(fraction.failure.threshold, 3, '小数取整');
  assert.equal(fraction.repeat.threshold, 4);
  assert.equal(fraction.failure.action, 'notified');
  assert.equal(fraction.repeat.action, 'cut');

  const junk = rowsByRule(await runSelfCheck(options({ failureEnabled: 'yes', repeatEnabled: 0 })));
  assert.equal(junk.failure.action, 'notified', '非布尔值回落默认（启用）');
  assert.equal(junk.repeat.action, 'cut');

  const missing = rowsByRule(await runSelfCheck(undefined));
  assert.deepEqual(missing, rowsByRule(await runSelfCheck(options())), '缺省参数等价于默认配置');
  const nulled = rowsByRule(await runSelfCheck(null));
  assert.deepEqual(nulled, missing, 'null 同样回落默认');
});

test('无宿主与 IO 依赖：构建产物只引用同包相对模块', async () => {
  const source = await readFile(libEntry, 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.ok(specifiers.length >= 3, '应当至少复用 options 与两个检测内核');
  for (const specifier of specifiers) {
    assert.match(specifier, /^\.\//, '运行时不得依赖宿主包或 Node 内建模块：' + specifier);
  }
  for (const token of ['node:', '@deepseek-ai', 'require(', 'process.', 'fetch(', 'setTimeout', 'setInterval', 'Math.random', 'Date.now']) {
    assert.equal(source.includes(token), false, '自检内核不得使用：' + token);
  }
});
