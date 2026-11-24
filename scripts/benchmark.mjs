import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createFailureTracker } from '../lib/failure/index.js';
import { guardReasoning } from '../lib/repetition/index.js';

if (!global.gc) throw new Error('Run with node --expose-gc');
const pairs = 100_000;
const frames = 3_500;
const fixture = Array.from({length: frames}, (_, i) => ({
  type: 'reasoning-delta', index: 0, text: '正常检查项目记录的第 ' + i + ' 项。\n',
}));
const open = {type:'block-start',index:0,blockType:'reasoning'};
const close = {type:'block-end',index:0,block:{type:'reasoning',text:fixture.map(x=>x.text).join('')}};
const finish = {type:'finish',reason:{kind:'stop'}};
const quantile = (values, q) => [...values].sort((a,b)=>a-b)[Math.ceil(values.length*q)-1];
async function measure(run, expected) {
  const samples = [];
  for (let i = -3; i < 11; i++) {
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const start = performance.now();
    const output = await run();
    const ms = performance.now() - start;
    const beforeGcKiB = (process.memoryUsage().heapUsed - before) / 1024;
    global.gc();
    const afterGcKiB = (process.memoryUsage().heapUsed - before) / 1024;
    assert.equal(output, expected);
    if (i >= 0) samples.push({ms,beforeGcKiB,afterGcKiB});
  }
  return {expected,p50Ms:quantile(samples.map(s=>s.ms),.5),p95Ms:quantile(samples.map(s=>s.ms),.95),p50PreGcDeltaKiB:quantile(samples.map(s=>s.beforeGcKiB),.5),p50PostGcDeltaKiB:quantile(samples.map(s=>s.afterGcKiB),.5),samples};
}
const failure = await measure(() => {
  const tracker = createFailureTracker();
  let notices = 0;
  for (let i = 0; i < pairs; i++) {
    const turn = 1 + Math.floor(i / 4);
    if (i % 4 === 0) tracker.clear();
    const id = 'fixture-' + i;
    tracker.call(id, 'fixture', turn, 1);
    if (tracker.result(id, turn, 1, i % 4 < 3, 3)) notices++;
  }
  return notices;
}, pairs / 4);
const repeat = await measure(async () => {
  const source = (async function*(){yield open;yield* fixture;yield close;yield finish;})();
  let count = 0;
  for await (const chunk of guardReasoning(source, 5, () => assert.fail('unexpected cut'))) {
    if (chunk.type === 'reasoning-delta') count++;
  }
  return count;
}, frames);
console.log(JSON.stringify({node:process.version,platform:process.platform,pairs,frames,scope:'new engines only; policy differs from the old candidate',failure,repeat},null,2));
