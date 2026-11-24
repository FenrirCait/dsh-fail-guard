import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationStreak, OPERATION_LIMITS } from '../src/failure/operation-streak.ts';

const NONE = { crossTurn: null, wouldStop: null };

/** 可注入时钟的实例；默认 TTL 60s，个别用例单独指定。 */
function harness(options = {}) {
  let now = 0;
  const streak = createOperationStreak({ now: () => now, ttlMs: options.ttlMs ?? 60_000 });
  return { streak, advance(ms) { now += ms; } };
}

let counter = 0;
function call(streak, tool, args, turn, step) {
  const id = `call-${++counter}`;
  streak.call(id, tool, args, turn, step);
  return id;
}
function settle(streak, id, turn, step, failed = true, limit = 2) {
  return streak.result(id, turn, step, failed, limit);
}
function fail(streak, tool, args, turn, step, limit = 2) {
  const id = call(streak, tool, args, turn, step);
  return settle(streak, id, turn, step, true, limit);
}
function succeed(streak, tool, args, turn, step) {
  const id = call(streak, tool, args, turn, step);
  return settle(streak, id, turn, step, false);
}

test('同一回合同一操作达到阈值才给出模拟停手，成功即清零', () => {
  const { streak } = harness();
  streak.startTurn(1);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), NONE);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), { crossTurn: null, wouldStop: 2 });
  assert.deepEqual(succeed(streak, 'read', { path: 'a' }, 1, 2), NONE);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 2, 2), NONE, '成功后重新从 1 计');
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 3, 2), { crossTurn: null, wouldStop: 2 });
});

test('参数按规范化键序匹配：键顺序不同、嵌套相同都视为同一操作', () => {
  const { streak } = harness();
  streak.startTurn(1);
  assert.deepEqual(fail(streak, 'edit', { path: 'a', body: 'x' }, 1, 1, 2), NONE);
  assert.deepEqual(fail(streak, 'edit', { body: 'x', path: 'a' }, 1, 2, 2), { crossTurn: null, wouldStop: 2 });
  assert.deepEqual(fail(streak, 'edit', { body: 'x', path: 'a', nested: { b: [1, { c: 2 }] } }, 1, 3, 2), NONE);
  assert.deepEqual(
    fail(streak, 'edit', { nested: { b: [1, { c: 2 }] }, path: 'a', body: 'x' }, 1, 4, 2),
    { crossTurn: null, wouldStop: 2 },
  );
});

test('同工具不同参数不是同一操作：不合并、不误报；数组顺序保序', () => {
  const { streak } = harness();
  streak.startTurn(1);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), NONE);
  assert.deepEqual(fail(streak, 'read', { path: 'b' }, 1, 1, 2), NONE, '换参数即换操作');
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), NONE, '回到 a 也只是第 1 次');
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), { crossTurn: null, wouldStop: 2 });
  assert.deepEqual(fail(streak, 'read', { paths: ['a', 'b'] }, 1, 1, 2), NONE);
  assert.deepEqual(fail(streak, 'read', { paths: ['b', 'a'] }, 1, 1, 2), NONE, '数组顺序不同即不同操作');
  assert.deepEqual(fail(streak, 'read', { paths: ['b', 'a'] }, 1, 1, 2), { crossTurn: null, wouldStop: 2 });
});

test('同参数不同工具不是同一操作', () => {
  const { streak } = harness();
  streak.startTurn(1);
  assert.deepEqual(fail(streak, 'tool-a', {}, 1, 1, 2), NONE);
  assert.deepEqual(fail(streak, 'tool-b', {}, 1, 1, 2), NONE);
  assert.deepEqual(fail(streak, 'tool-b', {}, 1, 1, 2), { crossTurn: null, wouldStop: 2 });
});

test('跨轮：相邻回合且回合数达到阈值才报告；同轮计数不跨轮累加', () => {
  const { streak } = harness();
  streak.startTurn(1);
  assert.deepEqual(fail(streak, 'shell', { command: 'x' }, 1, 1, 2), NONE);
  streak.endTurn(1);
  streak.startTurn(2);
  assert.deepEqual(fail(streak, 'shell', { command: 'x' }, 2, 1, 2), { crossTurn: 2, wouldStop: null });
  streak.endTurn(2);
  streak.startTurn(3);
  assert.deepEqual(fail(streak, 'shell', { command: 'x' }, 3, 1, 2), { crossTurn: 3, wouldStop: null });

  const three = harness();
  three.streak.startTurn(1);
  assert.equal(fail(three.streak, 'shell', { command: 'x' }, 1, 1, 3).crossTurn, null);
  three.streak.endTurn(1);
  three.streak.startTurn(2);
  assert.equal(fail(three.streak, 'shell', { command: 'x' }, 2, 1, 3).crossTurn, null, '2 < 阈值 3');
  three.streak.endTurn(2);
  three.streak.startTurn(3);
  assert.equal(fail(three.streak, 'shell', { command: 'x' }, 3, 1, 3).crossTurn, 3);
});

test('跨轮：回合缺口与不相邻回合都从 1 重新计数', () => {
  const { streak } = harness();
  streak.startTurn(1);
  fail(streak, 'shell', { command: 'x' }, 1, 1, 2);
  streak.endTurn(1);
  streak.startTurn(3); // 缺口：回合 2 缺失
  assert.deepEqual(fail(streak, 'shell', { command: 'x' }, 3, 1, 2), NONE);
  streak.endTurn(3);
  streak.startTurn(4);
  assert.deepEqual(fail(streak, 'shell', { command: 'x' }, 4, 1, 2), { crossTurn: 2, wouldStop: null });
});

test('跨轮 TTL：超过短 TTL 的相邻回合保守清零，之后的相邻回合重新计数', () => {
  const { streak, advance } = harness({ ttlMs: 1_000 });
  streak.startTurn(1);
  fail(streak, 'shell', { command: 'x' }, 1, 1, 2);
  advance(1_001);
  streak.endTurn(1);
  streak.startTurn(2);
  assert.deepEqual(fail(streak, 'shell', { command: 'x' }, 2, 1, 2), NONE, 'TTL 过期：回合数从 1 起重计');
  streak.endTurn(2);
  streak.startTurn(3);
  assert.deepEqual(fail(streak, 'shell', { command: 'x' }, 3, 1, 2), { crossTurn: 2, wouldStop: null });
});

test('跨轮：成功与换操作都会打断连续段', () => {
  const { streak } = harness();
  streak.startTurn(1);
  fail(streak, 'shell', { command: 'x' }, 1, 1, 2);
  streak.endTurn(1);
  streak.startTurn(2);
  succeed(streak, 'shell', { command: 'x' }, 2, 1);
  streak.endTurn(2);
  streak.startTurn(3);
  assert.deepEqual(fail(streak, 'shell', { command: 'x' }, 3, 1, 2), NONE, '成功清零后重新计');

  streak.endTurn(3);
  streak.startTurn(4);
  fail(streak, 'shell', { command: 'x' }, 4, 1, 2);
  streak.endTurn(4);
  streak.startTurn(5);
  assert.deepEqual(fail(streak, 'other', { command: 'x' }, 5, 1, 2), NONE, '换操作');
  assert.deepEqual(fail(streak, 'other', { command: 'x' }, 5, 1, 2), { crossTurn: null, wouldStop: 2 });
  streak.endTurn(5);
  streak.startTurn(6);
  assert.deepEqual(fail(streak, 'shell', { command: 'x' }, 6, 1, 2), NONE, 'shell 的段已被 other 打断');
});

test('并发乱序：坐标不符的结果不计入、保留待决调用并保守清零', () => {
  const { streak } = harness();
  streak.startTurn(1);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), NONE);
  const id = call(streak, 'read', { path: 'a' }, 1, 1);
  assert.deepEqual(settle(streak, id, 1, 2, true, 2), NONE, '坐标不符：清零，不计数');
  assert.equal(streak.size.pending, 1, '真正的结果仍可结算');
  assert.deepEqual(settle(streak, id, 1, 1, true, 2), NONE, '真实结果只剩 1 次');
  assert.equal(streak.size.pending, 0);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), { crossTurn: null, wouldStop: 2 });
});

test('步骤或回合结束后到达的结果视为乱序：不计入并清零', () => {
  const { streak } = harness();
  streak.startTurn(1);
  fail(streak, 'read', { path: 'a' }, 1, 1, 2);
  const late = call(streak, 'read', { path: 'a' }, 1, 1);
  streak.endStep(1, 1);
  assert.deepEqual(settle(streak, late, 1, 1, true, 2), NONE, 'step 结束：待决调用作废');
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 2, 2), NONE, '清零点之后重新从 1 计');
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 2, 2), { crossTurn: null, wouldStop: 2 });

  const closed = call(streak, 'read', { path: 'a' }, 1, 3);
  streak.endTurn(1);
  streak.startTurn(2);
  assert.deepEqual(settle(streak, closed, 1, 3, true, 2), NONE, '回合结束后到达的结果');
  assert.equal(streak.size.pending, 0);
});

for (const lateStep of [1, 2]) test(`已结束步骤之后的新调用被拒绝：step=${lateStep} 不入 pending，也不污染跨轮计数`, () => {
  const { streak } = harness();
  streak.startTurn(1);
  streak.endStep(1, 2);
  for (let index = 0; index < 2; index += 1) {
    const id = call(streak, 'read', '{"path":"a"}', 1, lateStep);
    assert.equal(streak.size.pending, 0, '迟到的新调用不登记');
    assert.deepEqual(settle(streak, id, 1, lateStep), NONE, '迟到调用的失败结果不计数');
    assert.equal(streak.size.active, 0, '不留下同轮或跨轮前置计数');
  }
  streak.endTurn(1);
  streak.startTurn(2);
  assert.deepEqual(fail(streak, 'read', '{"path":"a"}', 2, 1), NONE, '下一回合不是连续失败第 2 轮');
});

test('拒绝迟到调用时立即清零，未收到迟到结果也不影响后续合法步骤重新计数', () => {
  const { streak } = harness();
  streak.startTurn(1);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1), NONE);
  streak.endStep(1, 1);
  call(streak, 'read', { path: 'a' }, 1, 1); // 不送 result，单独验证 call() 的防线
  assert.equal(streak.size.pending, 0);
  assert.equal(streak.size.active, 0, '乱序 call 本身即打断旧计数');
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 2), NONE, '合法下一步重新从 1 计');
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 2), { crossTurn: null, wouldStop: 2 });
  streak.endStep(1, 2);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 3), { crossTurn: null, wouldStop: 3 }, '合法步骤间仍可连续累计');
  streak.endStep(1, 3);
  streak.endTurn(1);
  streak.startTurn(2);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 2, 1), { crossTurn: 2, wouldStop: null }, '新回合的步骤游标重置，正常跨轮计数保留');
});

test('重复结果幂等：不重复计数也不清零；重复调用不制造歧义', () => {
  const { streak } = harness();
  streak.startTurn(1);
  const id = call(streak, 'read', { path: 'a' }, 1, 1);
  assert.deepEqual(settle(streak, id, 1, 1, true, 2), NONE);
  assert.deepEqual(settle(streak, id, 1, 1, true, 2), NONE);
  assert.deepEqual(settle(streak, id, 1, 1, true, 2), NONE);
  streak.call(id, 'read', { path: 'b' }, 1, 1); // 已结算 callId 回放：忽略，不清零
  const pendingId = call(streak, 'read', { path: 'a' }, 1, 1);
  streak.call(pendingId, 'read', { path: 'a' }, 1, 1); // 同一 callId 重复调用：幂等刷新，不制造歧义
  assert.deepEqual(settle(streak, pendingId, 1, 1, true, 2), { crossTurn: null, wouldStop: 2 },
    '重复调用没有把计数推高到 3、也没有把段清零');
  assert.deepEqual(settle(streak, pendingId, 1, 1, true, 2), NONE);
  assert.deepEqual(settle(streak, id, 1, 1, true, 2), NONE);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), { crossTurn: null, wouldStop: 3 });
});

test('同一 step 多条未结算调用：该 step 的结果不累计，保守中断', () => {
  const { streak } = harness();
  streak.startTurn(1);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), NONE, '单条调用正常计 1');
  const first = call(streak, 'read', { path: 'a' }, 1, 1);
  const second = call(streak, 'read', { path: 'a' }, 1, 1); // 同一 step 第二条未结算调用
  assert.equal(streak.size.active, 0, '并行未结算即中断');
  assert.deepEqual(settle(streak, first, 1, 1, true, 2), NONE);
  assert.deepEqual(settle(streak, second, 1, 1, true, 2), NONE);
  assert.equal(streak.size.active, 0, '两条结果都不累计');
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 2, 2), NONE, '换到 step 2 重新从 1 计');
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 2, 2), { crossTurn: null, wouldStop: 2 });
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 3, 2), { crossTurn: null, wouldStop: 3 },
    '同回合计数跨 step 连续，歧义 step 不影响后面的顺序调用');
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 3, 2), { crossTurn: null, wouldStop: 4 });
});

test('参数无法规范化时身份不明：不计数，并清零此前段', () => {
  const { streak } = harness();
  streak.startTurn(1);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), NONE);

  const cyclic = { path: 'a' };
  cyclic.self = cyclic;
  const instances = [
    ['环', cyclic],
    ['函数', { fn: () => 1 }],
    ['symbol', { tag: Symbol('x') }],
    ['类实例', new (class Box { constructor() { this.v = 1; } })()],
    ['Date', new Date(0)],
    ['Map', new Map([[1, 2]])],
    ['深度超限', (() => { let deep = {}; let cursor = deep; for (let i = 0; i < 12; i += 1) { cursor.next = {}; cursor = cursor.next; } return deep; })()],
    ['键数超限', Object.fromEntries(Array.from({ length: OPERATION_LIMITS.keys + 1 }, (_, i) => ['k' + i, i]))],
    ['字符串超限', { text: 'x'.repeat(OPERATION_LIMITS.string + 1) }],
    ['读取抛错的 getter', { get boom() { throw new Error('fixture'); } }],
    ['抛错的 Proxy', new Proxy({}, { ownKeys() { throw new Error('fixture'); } })],
  ];
  for (const [label, args] of instances) {
    assert.deepEqual(fail(streak, 'read', args, 1, 1, 2), NONE, label + '：身份不明');
  }
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), NONE, '身份不明已把段清零，这里重新从 1 计');
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), { crossTurn: null, wouldStop: 2 });
});

test('宿主 raw string arguments 必须是完整合法 JSON；undefined 与无效 JSON 不登记', () => {
  const { streak } = harness();
  streak.startTurn(1);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), NONE);
  assert.deepEqual(fail(streak, 'read', undefined, 1, 1, 2), NONE, 'undefined：不登记并清零');
  for (const raw of ['{"path":', 'not json', '', '{"a":1} trailing', "{'a':1}", '{"a":1}{"b":2}', 'NaN']) {
    assert.deepEqual(fail(streak, 'read', raw, 1, 1, 2), NONE, '无效 JSON：' + JSON.stringify(raw));
  }
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), NONE, '清零后重新从 1 计');
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), { crossTurn: null, wouldStop: 2 });
});

test('raw string 与解析后的对象视为同一操作；合法 JSON 标量也可比较', () => {
  const { streak } = harness();
  streak.startTurn(1);
  assert.deepEqual(fail(streak, 'read', '{"path":"a","n":1}', 1, 1, 2), NONE);
  assert.deepEqual(fail(streak, 'read', { n: 1, path: 'a' }, 1, 1, 2), { crossTurn: null, wouldStop: 2 },
    'raw JSON 文本与已解析对象同指纹');
  assert.deepEqual(fail(streak, 'read', 'null', 1, 2, 2), NONE);
  assert.deepEqual(fail(streak, 'read', null, 1, 2, 2), { crossTurn: null, wouldStop: 2 });
  assert.deepEqual(fail(streak, 'read', '"x"', 1, 3, 2), NONE);
  assert.deepEqual(fail(streak, 'read', 'x', 1, 3, 2), NONE, '裸字符串不是合法 JSON：不登记并清零');
  assert.deepEqual(fail(streak, 'read', '"x"', 1, 3, 2), NONE, '清零后重新从 1 计');
  assert.deepEqual(fail(streak, 'read', '"x"', 1, 3, 2), { crossTurn: null, wouldStop: 2 });
});

test('非 JSON 值不登记：NaN/Infinity/bigint/undefined 都不是合法 JSON', () => {
  const { streak } = harness();
  streak.startTurn(1);
  assert.deepEqual(fail(streak, 'read', { v: 1 }, 1, 1, 2), NONE);
  const invalid = [
    ['NaN', { v: Number.NaN }],
    ['Infinity', { v: Number.POSITIVE_INFINITY }],
    ['bigint', { v: 1n }],
    ['undefined 值', { v: undefined }],
    ['数组里的 undefined', { list: [1, undefined] }],
  ];
  for (const [label, args] of invalid) {
    assert.deepEqual(fail(streak, 'read', args, 1, 1, 2), NONE, label + '：不登记');
  }
  assert.deepEqual(fail(streak, 'read', { v: 1 }, 1, 1, 2), NONE, '清零后重新从 1 计');
  assert.deepEqual(fail(streak, 'read', { v: 1 }, 1, 1, 2), { crossTurn: null, wouldStop: 2 });
});

test('回合缺失与乱序：未 startTurn、旧回合回放、endTurn 对不上都保守清零', () => {
  const fresh = harness();
  const orphan = call(fresh.streak, 'read', { path: 'a' }, 0, 0);
  assert.deepEqual(settle(fresh.streak, orphan, 0, 0, true, 2), NONE, '没有回合在跑：不计数');
  assert.equal(fresh.streak.size.pending, 0);

  const together = harness();
  together.streak.startTurn(1);
  fail(together.streak, 'read', { path: 'a' }, 1, 1, 2);
  together.streak.startTurn(2); // 缺 turn/end：这条边界保守中断，不跨过去累计
  assert.deepEqual(fail(together.streak, 'read', { path: 'a' }, 2, 1, 2), NONE, '缺 endTurn 的边界不累计');
  together.streak.endTurn(2);
  together.streak.startTurn(3);
  assert.deepEqual(fail(together.streak, 'read', { path: 'a' }, 3, 1, 2), { crossTurn: 2, wouldStop: null });

  // 对不上当前回合的 endTurn：清零后同一回合重新从 1 计（否则这里会是 2）
  const mismatch = harness();
  mismatch.streak.startTurn(3);
  assert.deepEqual(fail(mismatch.streak, 'read', { path: 'a' }, 3, 1, 2), NONE);
  mismatch.streak.endTurn(5);
  assert.deepEqual(fail(mismatch.streak, 'read', { path: 'a' }, 3, 1, 2), NONE, '乱序 endTurn 已清零');

  // 已结束的旧回合回放：忽略并清零，不重新打开
  const replay = harness();
  replay.streak.startTurn(1);
  assert.deepEqual(fail(replay.streak, 'read', { path: 'a' }, 1, 1, 2), NONE);
  assert.deepEqual(fail(replay.streak, 'read', { path: 'a' }, 1, 1, 2), { crossTurn: null, wouldStop: 2 });
  replay.streak.endTurn(1);
  replay.streak.startTurn(1);
  assert.deepEqual(fail(replay.streak, 'read', { path: 'a' }, 1, 1, 2), NONE, '回合没有真正打开，结果一律不计数');
  replay.streak.startTurn(2);
  assert.deepEqual(fail(replay.streak, 'read', { path: 'a' }, 2, 1, 2), NONE, '旧回放已清零，重新从 1 计');
  replay.streak.startTurn(2); // 同一回合重复开始：幂等，不清零
  assert.deepEqual(fail(replay.streak, 'read', { path: 'a' }, 2, 1, 2), { crossTurn: null, wouldStop: 2 });
});

test('活动与记忆都有上限：未决调用与已处理 id 不随会话增长', () => {
  const { streak } = harness();
  streak.startTurn(1);
  for (let index = 0; index < 200; index += 1) streak.call(`p${index}`, 'read', { index }, 1, 1);
  assert.equal(streak.size.pending, OPERATION_LIMITS.pending);
  for (let index = 0; index < 400; index += 1) {
    const id = `q${index}`;
    streak.call(id, 'read', { index }, 1, 1);
    streak.result(id, 1, 1, false, 2);
  }
  assert.ok(streak.size.pending <= OPERATION_LIMITS.pending);
  assert.ok(streak.size.seen <= OPERATION_LIMITS.seen);
  assert.equal(streak.size.active, 0, '成功清零后没有活动段');
  assert.ok(Object.values(streak.size).every((value) => Number.isSafeInteger(value)));
});

test('返回值只有两个数字字段，不泄露参数原文与内部指纹', () => {
  const { streak } = harness();
  streak.startTurn(1);
  const secret = 'ghp_SECRET_TOKEN_1234567890';
  const decision = fail(streak, 'read', { token: secret, nested: { secret } }, 1, 1, 2);
  assert.deepEqual(Object.keys(decision).sort(), ['crossTurn', 'wouldStop']);
  assert.ok(Object.values(decision).every((value) => value === null || Number.isSafeInteger(value)));
  const exposed = JSON.stringify(decision) + JSON.stringify(streak.size) + JSON.stringify(fail(streak, 'read', { token: secret, nested: { secret } }, 1, 1, 2));
  assert.equal(exposed.includes(secret), false);
  assert.deepEqual(Object.keys(streak).sort(), ['call', 'endStep', 'endTurn', 'reset', 'result', 'size', 'startTurn']);
});

test('非法阈值不产生信号但计数不丢：回到合法阈值仍按累计次数报告', () => {
  const { streak } = harness();
  streak.startTurn(1);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 1), NONE);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, Number.NaN), NONE);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, Number.POSITIVE_INFINITY), NONE);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2.9), { crossTurn: null, wouldStop: 4 });
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 3), { crossTurn: null, wouldStop: 5 });
});

test('reset() 清空全部状态：可以当作新实例继续用', () => {
  const { streak } = harness();
  streak.startTurn(1);
  fail(streak, 'read', { path: 'a' }, 1, 1, 2);
  assert.equal(streak.size.active, 1);
  streak.reset();
  assert.deepEqual(streak.size, { pending: 0, seen: 0, active: 0 });
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), NONE);
  assert.equal(streak.size.pending, 0);
  streak.startTurn(1);
  assert.deepEqual(fail(streak, 'read', { path: 'a' }, 1, 1, 2), NONE);
});
