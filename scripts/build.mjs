#!/usr/bin/env node
// dsh-fail-guard · 构建脚本
//
// 安全约束：
// 1. 编译产物先写进 lib 旁边的临时目录（与 lib 同卷），完整生成并通过关键文件校验后才替换 lib；
// 2. 任何阶段失败都不会留下半套产物：旧 lib 要么原样不动，要么从备份回滚；
// 3. 同一项目内的并发构建用锁文件串行化；锁记录 pid + token，释放时校验 token；
// 4. 上次进程被强杀留下的 stage/backup 由下一次构建在持锁状态下回收；
//    若发现 lib 缺失但存在备份，先恢复备份再继续。
//
// 运行：node scripts/build.mjs
// 测试：node --test test/build-protection.test.mjs（在隔离目录内，不触碰本项目 lib）

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, open, readFile, readdir, rename as renamePath, rm, stat, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuildBuild } from 'esbuild';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

export const KEY_FILES = Object.freeze([
  'index.js',
  'index.d.ts',
  'client.js',
  'options.js',
  'options.d.ts',
  'self-check.js',
  'self-check.d.ts',
  'diagnostic-shared.js',
  'diagnostic-shared.d.ts',
  'diagnostic-store.js',
  'diagnostic-store.d.ts',
  'diagnostic-remote.js',
  'diagnostic-remote.d.ts',
  'activity.js',
  'activity.d.ts',
  'activity-shared.js',
  'activity-shared.d.ts',
  'failure/index.js',
  'failure/index.d.ts',
  'repetition/index.js',
  'repetition/index.d.ts',
  'repetition/fragment-observer.js',
  'repetition/fragment-observer.d.ts',
  'failure/operation-streak.js',
  'failure/operation-streak.d.ts',
  'repetition/fuzzy-observer.js',
  'repetition/fuzzy-observer.d.ts',
]);

export const BUILD_LOCK = '.build-lock.json';

const STAGE_PREFIX = '.build-stage-';
const BACKUP_PREFIX = '.build-backup-';
const DEFAULT_LOCK_WAIT_MS = 30_000;
const LOCK_STALE_MS = 10 * 60_000;
const DEFAULT_RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 80;
const CLIENT_BANNER = 'window.__ModuleLoader__.load(';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const errorText = (error) => (error instanceof Error ? error.message : String(error));

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readLock(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function lockIsStale(file, options = {}) {
  const isPidAlive = options.isPidAlive ?? isProcessAlive;
  const data = await readLock(file);
  if (data && Number.isInteger(data.pid)) return !isPidAlive(data.pid);
  // 锁文件写了一半或内容损坏：仅按年龄判断，给正在写锁的进程留出时间。
  try {
    const info = await stat(file);
    return Date.now() - info.mtimeMs > (options.staleMs ?? LOCK_STALE_MS);
  } catch {
    return true;
  }
}

export async function acquireBuildLock(root, options = {}) {
  const waitMs = Math.max(0, options.waitMs ?? DEFAULT_LOCK_WAIT_MS);
  const isPidAlive = options.isPidAlive ?? isProcessAlive;
  const file = join(root, BUILD_LOCK);
  const token = randomBytes(12).toString('hex');
  const payload = JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() });
  const deadline = Date.now() + waitMs;
  let steals = 0;
  for (;;) {
    let handle;
    try {
      handle = await open(file, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await lockIsStale(file, { isPidAlive })) {
        if (++steals > 50) throw new Error('could not reclaim stale build lock: ' + file);
        await unlink(file).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          'another build is already running (lock: ' + file + '); wait for it to finish, or remove the lock file if that process is gone',
        );
      }
      await sleep(Math.min(100, Math.max(10, deadline - Date.now())));
      continue;
    }
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(file).catch(() => {});
      throw error;
    }
    return async () => {
      const owner = await readLock(file);
      if (owner?.token === token) await unlink(file).catch(() => {});
    };
  }
}

async function renameWithRetry(from, to, options = {}) {
  const renameImpl = options.rename ?? renamePath;
  const attempts = Math.max(1, options.retries ?? DEFAULT_RENAME_RETRIES);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      lastError = error;
      const transient = error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'EBUSY';
      if (!transient || attempt === attempts) throw error;
      await sleep(RENAME_RETRY_MS);
    }
  }
  throw lastError;
}

export async function verifyStage(stageDir, options = {}) {
  const keyFiles = options.keyFiles ?? KEY_FILES;
  const missing = [];
  let bytes = 0;
  for (const rel of keyFiles) {
    try {
      const info = await stat(join(stageDir, rel));
      if (!info.isFile() || info.size === 0) missing.push(rel);
      else bytes += info.size;
    } catch {
      missing.push(rel);
    }
  }
  if (missing.length > 0) {
    throw new Error('staged output incomplete: missing or empty ' + missing.join(', '));
  }
  const client = await readFile(join(stageDir, 'client.js'), 'utf8');
  if (!client.includes(CLIENT_BANNER)) {
    throw new Error('staged client bundle has no module loader banner');
  }
  return { files: keyFiles.length, bytes };
}

async function recoverInterruptedSwap(root, options = {}) {
  const log = options.log ?? (() => {});
  const renameOptions = { rename: options.rename, retries: options.renameRetries };
  let entries = [];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  const stages = entries.filter((name) => name.startsWith(STAGE_PREFIX));
  const backups = entries.filter((name) => name.startsWith(BACKUP_PREFIX));
  const libDir = join(root, 'lib');
  if (!existsSync(libDir) && backups.length > 0) {
    const ranked = [];
    for (const name of backups) {
      try {
        ranked.push({ name, mtime: (await stat(join(root, name))).mtimeMs });
      } catch {
        // 备份在扫描期间消失：忽略。
      }
    }
    ranked.sort((a, b) => b.mtime - a.mtime);
    if (ranked.length > 0) {
      await renameWithRetry(join(root, ranked[0].name), libDir, renameOptions);
      log('[build] restored lib from interrupted swap backup ' + ranked[0].name);
      backups.splice(backups.indexOf(ranked[0].name), 1);
    }
  }
  for (const name of stages) {
    await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
  }
  if (existsSync(libDir)) {
    for (const name of backups) {
      await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

function tscPath() {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
}

function runTsc(root, args) {
  const result = spawnSync(process.execPath, [tscPath(), ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error('tsc ' + args.join(' ') + ' exited with code ' + result.status);
  }
}

function createDefaultStages(root, stageDir) {
  return {
    typecheck: async () => runTsc(root, ['--noEmit']),
    compile: async () => runTsc(root, ['-p', 'tsconfig.host.json', '--outDir', stageDir]),
    bundle: async () => {
      await esbuildBuild({
        absWorkingDir: root,
        entryPoints: ['src/client/index.tsx'],
        outfile: join(stageDir, 'client.js'),
        bundle: true,
        format: 'iife',
        globalName: '__guardClient',
        platform: 'browser',
        target: 'es2022',
        jsx: 'automatic',
        minify: true,
        external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
        banner: {
          js: '// Generated by npm run build.\nwindow.__ModuleLoader__.load({ id: "dsh-fail-guard", factory: function (require) {',
        },
        footer: { js: 'return __guardClient; } });' },
      });
    },
    verify: async () => verifyStage(stageDir),
  };
}

export async function buildProject(options = {}) {
  const root = resolve(options.root ?? PROJECT_ROOT);
  const log = options.log ?? console.log;
  const renameOptions = { rename: options.rename, retries: options.renameRetries };
  const release = await acquireBuildLock(root, {
    waitMs: options.lockWaitMs,
    isPidAlive: options.isPidAlive,
  });
  const libDir = join(root, 'lib');
  let stageDir;
  let backupDir;
  try {
    await recoverInterruptedSwap(root, { log, ...renameOptions });
    stageDir = await mkdtemp(join(root, STAGE_PREFIX + process.pid + '-'));
    const stages = { ...createDefaultStages(root, stageDir), ...(options.stages ?? {}) };
    const runStage = async (name) => {
      if (typeof stages[name] !== 'function') throw new Error('build stage "' + name + '" is not implemented');
      try {
        return await stages[name]({ root, stageDir });
      } catch (error) {
        throw new Error('build failed during ' + name + ': ' + errorText(error), { cause: error });
      }
    };
    log('[build] staging output in ' + stageDir);
    await runStage('typecheck');
    await runStage('compile');
    await runStage('bundle');
    const verified = await runStage('verify');

    backupDir = join(root, BACKUP_PREFIX + process.pid + '-' + randomBytes(6).toString('hex'));
    let movedOld = false;
    try {
      if (existsSync(libDir)) {
        await renameWithRetry(libDir, backupDir, renameOptions);
        movedOld = true;
      }
      await renameWithRetry(stageDir, libDir, renameOptions);
      stageDir = undefined;
    } catch (error) {
      if (movedOld) {
        try {
          await renameWithRetry(backupDir, libDir, renameOptions);
          backupDir = undefined;
        } catch (restoreError) {
          throw new Error(
            'publish failed and rollback failed: previous lib is kept at ' + backupDir +
              '; publish error: ' + errorText(error) + '; rollback error: ' + errorText(restoreError),
            { cause: restoreError },
          );
        }
        throw new Error('publish failed; previous lib restored from backup: ' + errorText(error), {
          cause: error,
        });
      }
      throw new Error('publish failed: ' + errorText(error), { cause: error });
    }

    if (movedOld) {
      try {
        await rm(backupDir, { recursive: true, force: true });
        backupDir = undefined;
      } catch (error) {
        log(
          '[build] warning: could not remove previous lib backup ' + backupDir + ': ' + errorText(error) +
            '; the next build will reclaim it',
        );
      }
    }
    log('[build] published ' + KEY_FILES.length + ' key files to ' + libDir);
    return { libDir, files: verified?.files ?? KEY_FILES.length, bytes: verified?.bytes ?? 0 };
  } finally {
    if (stageDir) await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    await release();
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();

if (invokedDirectly) {
  buildProject()
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}
