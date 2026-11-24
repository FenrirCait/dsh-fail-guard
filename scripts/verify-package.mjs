import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

assert.ok(process.argv[2], 'Usage: node scripts/verify-package.mjs <archive.tgz>');
const path = resolve(process.argv[2]);
const tar = (...args) => {
  const r = spawnSync('tar', args, { cwd: dirname(path), encoding: 'utf8', maxBuffer: 2 ** 20 });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const archive = './' + basename(path);
const files = tar('-tf', archive).trim().split(/\r?\n/);
const entry = name => tar('-xOf', archive, 'package/' + name);
const pkg = JSON.parse(entry('package.json'));
assert.equal(pkg.name, 'dsh-fail-guard');
const expectedVersion = process.argv[3] ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
assert.equal(pkg.version, expectedVersion);
assert.deepEqual(Object.keys(pkg.exports).sort(), ['.', './client', './package.json']);
assert.equal(pkg.exports['.'].default, './lib/index.js');
assert.equal(pkg.exports['./client'], './lib/client.js');
for (const file of ['index.js', 'client.js', 'activity.js', 'activity.d.ts', 'activity-shared.js', 'activity-shared.d.ts', 'self-check.js', 'self-check.d.ts', 'diagnostic-shared.js', 'diagnostic-shared.d.ts', 'diagnostic-store.js', 'diagnostic-store.d.ts', 'diagnostic-remote.js', 'diagnostic-remote.d.ts']) {
  assert.ok(files.includes('package/lib/' + file), 'missing package member: ' + file);
}
// alpha.6 and earlier archives can still be verified as rollback artifacts.
if (!/^0\.4\.0-alpha\.[1-6]$/.test(pkg.version)) {
  for (const file of ['lib/repetition/fragment-observer.js', 'lib/repetition/fragment-observer.d.ts']) {
    assert.ok(files.includes('package/' + file), 'missing package member: ' + file);
    assert.ok(entry(file).trim().length > 0, 'empty package member: ' + file);
  }
}
if (!/^0\.4\.0-alpha\.[1-8]$/.test(pkg.version)) {
  for (const file of ["failure/operation-streak.js","failure/operation-streak.d.ts","repetition/fuzzy-observer.js","repetition/fuzzy-observer.d.ts"]) {
    assert.ok(files.includes('package/lib/' + file), 'missing package member: ' + file);
    assert.ok(entry('lib/' + file).trim().length > 0, 'empty package member: ' + file);
  }
}
assert.equal(new Set(files).size, files.length);
const allowed = /^package\/(?:lib\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:js|d\.ts)|package\.json|cordis\.patch\.yml|README(?:\.zh)?\.md|REFERENCES\.md|LICENSE)$/;
for (const file of files) assert.ok(allowed.test(file), 'unexpected archive member: ' + file);
assert.equal(entry('cordis.patch.yml').replace(/\r\n/g, '\n').trim(), '- insert:\n    - id: dsh-fail-guard-standalone\n      name: dsh-fail-guard');
for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  assert.ok(!Object.keys(pkg[section] ?? {}).some(name => /dsh-(?:repeat-guard|loop-breaker|dupguard|repetition-guard|attention-health)$/.test(name)));
}
const web = entry('lib/client.js');
assert.equal((web.match(/window\.__ModuleLoader__\.load\(/g) ?? []).length, 1);
assert.ok(web.includes('plugins.bundle.config') && !web.includes('settings.section'));
assert.ok(web.includes('conversation.chat.turnTail'));
assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-chat'));
console.log(JSON.stringify({ name: pkg.name, version: pkg.version, files: files.length, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
