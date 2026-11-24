import test from 'node:test';
import assert from 'node:assert/strict';
import { guardReasoning } from '../lib/repetition/index.js';
import { observeFragments, LIMITS } from '../lib/repetition/fragment-observer.js';

const start = (index, blockType = 'reasoning') => ({type:'block-start', index, blockType});
const delta = (index,text) => ({type:'reasoning-delta', index, text});
const end = (index,text) => ({type:'block-end', index, block:{type:'reasoning', text}});
const finish = {type:'finish', reason:{kind:'stop'}};
const stream = frames => (async function*() { yield* frames; })();
const run = (text, parts = [text], index = 0) => [start(index), ...parts.map(p => delta(index,p)), end(index,text)];
const mixed = ['做。','好。','执行。','做。','还要核对一项依赖。','好。','做。','执行。','好。','做。'].join('\n')+'\n';
const sparse = ['做。','第一项有以下两条证据。','好。','先核对数字再比较。','做。','依赖已经正确加载。'].join('\n')+'\n';
const inline = '做。好。执行。'.repeat(4);
const consecutive = '做。\n'.repeat(7);
const tick = String.fromCharCode(96).repeat(3);
const formatted = tick+'js\n'+mixed+tick+'\n';
const compare = async (frames, legacy, shadow) => {
  const a = [], b = [];
  const outputA = await Array.fromAsync(guardReasoning(stream(frames), 5, x => a.push(x.count), () => false));
  const outputB = await Array.fromAsync(observeFragments(stream(frames), x => b.push(x)));
  for (const output of [outputA,outputB]) {
    assert.equal(output.length, frames.length);
    assert.ok(output.every((frame,i) => frame === frames[i]), 'frames must pass unchanged');
  }
  assert.equal(a.length, legacy, 'alpha.6 baseline');
  assert.deepEqual(b.map(x => x.rule), shadow, 'experimental rules');
  for (const data of b) {
    assert.ok(Object.isFrozen(data));
    assert.ok(Object.keys(data).every(k => ['rule','fragments','distinct','lines'].includes(k)));
    assert.ok(Object.entries(data).every(([key,value]) => key === 'rule' || Number.isSafeInteger(value)));
  }
  return b;
};

const cases = [
  ['consecutive same line', run(consecutive, ['做。\n'.repeat(6),'做。\n']), 1, []],
  ['mixed short fragments', run(mixed), 0, ['fragment-window']],
  ['one unit per block', [...'做。|好。|执行。|做。|好。|执行。|好。|做。'.split('|').flatMap((w,i)=>run(w,[w],i))], 0, ['fragment-window']],
  ['single line without newline', run(inline), 0, ['inline-fragments']],
  ['sparse progress', run(sparse.repeat(4)), 0, []],
  ['fenced code', run(formatted), 0, []],
  ['unclosed fence', run(tick+'js\n'+mixed), 0, []],
  ['blockquotes, table and list', run('> 好。\n| 做。 | 好。 |\n- 做。\n1. 执行。\n'.repeat(5)), 0, []],
  ['varied short labels', run('甲\n乙\n丙\n丁\n戊\n己\n庚\n辛\n壬\n癸\n子\n丑\n'), 0, []],
  ['no visible reasoning', [start(1,'text'),{type:'text-delta',index:1,text:mixed}], 0, []],
  ['visible progress breaks sequence', [...run('好。\n做。\n'.repeat(3)),start(1,'text'),{type:'text-delta',index:1,text:'output'},...run('好。\n做。\n'.repeat(3),undefined,2)], 0, []],
  ['tool progress breaks sequence', [...run('好。\n做。\n'.repeat(3)),start(1,'tool-call'),...run('好。\n做。\n'.repeat(3),undefined,2)], 0, []],
  ['unrelated interleaved partial lines are not joined', [start(0),start(1),delta(0,inline.slice(0,8)),delta(1,inline.slice(8)),end(0,inline.slice(0,8)),end(1,inline.slice(8))], 0, []],
  ['overlong line falls back to passthrough', run('x'.repeat(LIMITS.line+1)+'\n'+mixed), 0, []],
  ['too many active blocks falls back to passthrough', [...Array.from({length:LIMITS.blocks+1},(_,i)=>start(i)),delta(0,mixed)], 0, []],
];
for (const [label, frames, legacy, shadow] of cases) {
  test(label, () => compare([...frames, finish],legacy,shadow));
}
test('all possible two-way splits preserve the mixed hit and metrics', async () => {
  let reference;
  for (let i=0;i<=mixed.length;i++) {
    const report = await compare([...run(mixed,[mixed.slice(0,i),mixed.slice(i)]), finish],0,['fragment-window']);
    reference ??= report;
    assert.deepEqual(report, reference);
  }
});
for (const [label,text,rule] of [['inline',inline,'inline-fragments'],['CRLF',mixed.replaceAll('\n','\r\n'),'fragment-window'],['fence',formatted,null]]) {
  test(label+' handles one character per delta', () => compare([...run(text,[...text]),finish],0,rule?[rule]:[]));
}
test('at most one report per input stream', () => compare([...run(mixed+mixed+inline),finish],0,['fragment-window']));
test('partial fence survives a visible progress boundary without counting code', () => compare([
  start(0), delta(0,tick.slice(0,2)), start(1,'text'),
  delta(0,tick.slice(2)+'js\n'+mixed+tick+'\n'), end(0,''), finish,
],0,[]));
test('callback failure cannot interrupt forwarding', async () => {
  const frames = [...run(mixed),finish];
  assert.deepEqual(await Array.fromAsync(observeFragments(stream(frames),()=>{throw Error('fixture');})),frames);
});
test('observer never waits for another frame to forward a hit', async () => {
  let pulls=0, closed=0, seen=0;
  const sample=run(mixed);
  async function* input() {try { for(const frame of sample){pulls++;yield frame;} } finally {closed++;}}
  const it=observeFragments(input(),()=>seen++);
  assert.equal((await it.next()).value,sample[0]);
  assert.equal((await it.next()).value,sample[1]);
  assert.equal(seen,1);
  assert.equal(pulls,2);
  await it.return();
  assert.equal(closed,1);
});
