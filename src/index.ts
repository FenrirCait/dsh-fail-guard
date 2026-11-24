import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-settings';
import Schema from '@deepseek-ai/schemastery';
import { createFailureTracker } from './failure/index.js';
import { createOperationStreak } from './failure/operation-streak.js';
import { guardReasoning } from './repetition/index.js';
import { observeFragments } from './repetition/fragment-observer.js';
import { observeFuzzy } from './repetition/fuzzy-observer.js';
import { queueActivity, registerActivity } from './activity.js';
import { DEFAULTS, LIMITS, PACKAGE_NAME } from './options.js';
import { createDiagnosticStore, type DiagnosticStore } from './diagnostic-store.js';
import type { DiagnosticReport } from './diagnostic-shared.js';
import { GuardDiagnostics } from './diagnostic-remote.js';
import type {} from '@deepseek-ai/dsh-app-boot';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pluginVersion: string = require('../package.json').version;
function installedHostVersion(): string | null {
  try { return require('@deepseek-ai/dsh/package.json').version ?? null; }
  catch { return null; }
}

export const name = PACKAGE_NAME;
export const inject = ['agents'];

export const Config = Schema.object({
  failureEnabled: Schema.boolean().default(DEFAULTS.failureEnabled).volatile(),
  failureLimit: Schema.natural().min(LIMITS.failureLimit.min).max(LIMITS.failureLimit.max).default(DEFAULTS.failureLimit).volatile(),
  repeatEnabled: Schema.boolean().default(DEFAULTS.repeatEnabled).volatile(),
  repeatLimit: Schema.natural().min(LIMITS.repeatLimit.min).max(LIMITS.repeatLimit.max).default(DEFAULTS.repeatLimit).volatile(),
  resumeOnRepeat: Schema.boolean().default(DEFAULTS.resumeOnRepeat).volatile(),
  observeOnly: Schema.boolean().default(DEFAULTS.observeOnly).volatile(),
  diagnosticsEnabled: Schema.boolean().default(DEFAULTS.diagnosticsEnabled).volatile(),
  fragmentObserveEnabled: Schema.boolean().default(DEFAULTS.fragmentObserveEnabled).volatile(),
  fuzzyObserveEnabled: Schema.boolean().default(DEFAULTS.fuzzyObserveEnabled).volatile(),
  crossTurnObserveEnabled: Schema.boolean().default(DEFAULTS.crossTurnObserveEnabled).volatile(),
  activeSteerEnabled: Schema.boolean().default(DEFAULTS.activeSteerEnabled).volatile(),
  stopSimulationEnabled: Schema.boolean().default(DEFAULTS.stopSimulationEnabled).volatile(),
});

declare module '@deepseek-ai/dsh-llm/types' {
  interface MessageSourceMap {
    'plugin:fail-guard-standalone': { kind: 'plugin:fail-guard-standalone'; form: 'notice'; summary: string };
  }
}

function notice(summary: string, text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin:fail-guard-standalone', form: 'notice', summary } });
}

function exitFailed(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || !('opsShell' in meta)) return false;
  const shell = meta.opsShell;
  if (!shell || typeof shell !== 'object' || !('exitCode' in shell)) return false;
  const code = shell.exitCode;
  return typeof code === 'number' ? Number.isInteger(code) && code !== 0 :
    typeof code === 'string' && /^-?\d+$/.test(code) && Number(code) !== 0;
}

type Turn = { number: number; failureHandled: boolean; failureNotified: boolean; repeat: boolean; repeatObserved: boolean; fragmentObserved: boolean; fuzzyObserved: boolean; crossTurnObserved: boolean; stopSimulated: boolean; resumed: boolean; diagnostic?: DiagnosticReport };
type SessionGuard = { session: Agent['session']; tracker: ReturnType<typeof createFailureTracker>; operations?: ReturnType<typeof createOperationStreak>; operationMode?: number; turn?: Turn; dispose(): void };

export function apply(ctx: Context, config: ReturnType<typeof Config>): void {
  const sessions = new Map<Agent['session']['id'], SessionGuard>();
  let store: DiagnosticStore | undefined;
  let hostVersion: string | null = null;
  ctx.inject(['profileContext'], c => {
    c.effect(() => {
      const local = createDiagnosticStore(c.profileContext.dir);
      store = local;
      c.plugin({ name: 'guard-diagnostics-reader', apply: (scope: Context) => { new GuardDiagnostics(scope, local); } });
      hostVersion = installedHostVersion();
      void local.prune();
      const timer = setInterval(() => { void local.prune(); }, 60 * 60 * 1000);
      timer.unref();
      return () => { clearInterval(timer); if (store === local) store = undefined; };
    });
  });
  registerActivity(ctx);
  ctx.inject(['settings'], c => { c.effect(() => c.settings.configure({ auto: false }, ctx.fiber)); });
  const createTurn = (number: number): Turn => ({ number, failureHandled: false, failureNotified: false, repeat: false, repeatObserved: false, fragmentObserved: false, fuzzyObserved: false, crossTurnObserved: false, stopSimulated: false, resumed: false });

  ctx.effect(() => {
    const detach = (agent: Agent, state: SessionGuard) => {
      if (sessions.get(agent.session.id) !== state) return;
      sessions.delete(agent.session.id);
      state.dispose();
    };
    const attach = ({ agent }: { agent: Agent }) => {
      if (sessions.has(agent.session.id)) return undefined;
      const tracker = createFailureTracker();
      const state: SessionGuard = { session: agent.session, tracker, dispose() {} };
      const reset = (turn?: number) => {
        tracker.clear();
        state.turn = turn === undefined ? undefined : createTurn(turn);
      };
      const mode = () => Number(config.crossTurnObserveEnabled.get()) | (Number(config.stopSimulationEnabled.get()) << 1);
      const startOperations = (turn: number) => {
        const currentMode = mode();
        if (state.operationMode !== currentMode) {
          state.operations?.reset();
          state.operations = currentMode ? createOperationStreak() : undefined;
          state.operationMode = currentMode;
        }
        state.operations?.startTurn(turn);
      };
      const freshOperations = () => {
        if (state.operationMode !== mode()) {
          // A partial turn cannot provide evidence for a new settings generation.
          state.operations?.reset();
          state.operations = undefined;
          state.operationMode = undefined;
        }
        return state.operations;
      };
      const stopEvents = agent.ctx.on('session/event', (session, event) => {
        if (session !== agent.session || sessions.get(session.id) !== state) return;
        const op = event.surfaceOp;
        if (typeof op === 'object' && op?.op === 'replace') return;
        switch (event.type) {
          case 'turn/start':
            reset(event.data.turn);
            startOperations(event.data.turn);
            return;
          case 'turn/end':
            if (state.turn?.number === event.data.turn) {
              const operations = freshOperations();
              if (event.data.reason?.kind === 'completed') operations?.endTurn(event.data.turn);
              else operations?.reset();
              reset();
            }
            return;
          case 'step/start':
            if (!state.turn || state.turn.number !== event.data.turn) {
              state.operations?.reset();
              reset(event.data.turn);
            } else tracker.clearPending();
            return;
          case 'step/end':
            if (state.turn?.number === event.data.turn) {
              tracker.clearPending();
              freshOperations()?.endStep(event.data.turn, event.data.step);
            }
            return;
          case 'tool/call': {
            const { callId, name, turn, step } = event.data;
            if (state.turn?.number === turn) freshOperations()?.call(callId, name, event.data.arguments, turn, step);
            if (!config.failureEnabled.get()) { tracker.clear(); return; }
            if (state.turn?.number === turn && !state.turn.failureHandled) tracker.call(callId, name, turn, step);
            return;
          }
          case 'tool/result': {
            const { message, turn, step, meta } = event.data;
            const active = state.turn;
            const failed = message.isError === true || exitFailed(meta);
            if (active?.number === turn) {
              const outcome = freshOperations()?.result(message.toolCallId, turn, step, failed, config.failureLimit.get());
              const stillAttached = () => sessions.get(session.id) === state;
              if (outcome && outcome.crossTurn !== null && config.crossTurnObserveEnabled.get() && !active.crossTurnObserved) {
                active.crossTurnObserved = true;
                queueActivity(session, { turn, rule: 'cross-turn', count: outcome.crossTurn, action: 'observed' }, stillAttached);
              }
              if (outcome && outcome.wouldStop !== null && config.stopSimulationEnabled.get() && !active.stopSimulated) {
                active.stopSimulated = true;
                queueActivity(session, { turn, rule: 'stop-simulation', count: outcome.wouldStop, action: 'would-stop' }, stillAttached);
              }
            }
            if (!config.failureEnabled.get()) { tracker.clear(); return; }
            if (!active || active.number !== turn || active.failureHandled) return;
            const text = tracker.result(message.toolCallId, turn, step, failed, config.failureLimit.get());
            if (!text) return;
            active.failureHandled = true;
            const observed = config.observeOnly.get();
            if (!observed) {
              agent.steer(notice('连续失败防护', text));
              active.failureNotified = true;
            }
            queueActivity(session, { turn, rule: 'failure', count: tracker.consecutive, action: observed ? 'observed' : 'notified' },
              () => sessions.get(session.id) === state);
          }
        }
      });
      const stopDisposal = agent.ctx.on('session/disposed', session => {
        if (session === agent.session) detach(agent, state);
      });
      state.dispose = () => { state.operations?.reset(); reset(); stopEvents(); stopDisposal(); };
      sessions.set(agent.session.id, state);
      return undefined;
    };
    const created = ctx.on('agent/created', attach);
    const disposed = ctx.on('agent/disposed', ({ agent }) => {
      const state = sessions.get(agent.session.id);
      if (state) detach(agent, state);
    });
    const status = ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return;
      const state = sessions.get(agent.session.id);
      if (state) { if (state.turn) state.operations?.reset(); state.turn = undefined; state.tracker.clear(); }
    });
    const streaming = ctx.on('llm/stream', (options, next) => {
      const source = next();
      if (options.purpose !== undefined || options.sessionId === undefined) return source;
      const id = options.sessionId;
      const state = sessions.get(id);
      const turn = state?.turn;
      if (!state || !turn) return source;
      const current = () => sessions.get(id) === state && state.turn === turn;
      // The new observer sees only what the original path forwards. It has no intervention capability.
      const observe = (stream: typeof source) => {
        if (config.fragmentObserveEnabled.get() && !turn.fragmentObserved) {
          stream = observeFragments(stream, ({ fragments }) => {
            if (!current() || turn.fragmentObserved || !config.fragmentObserveEnabled.get()) return;
            turn.fragmentObserved = true;
            queueActivity(state.session, { turn: turn.number, rule: 'fragment', count: fragments, action: 'observed' },
              () => sessions.get(id) === state);
          });
        }
        if (config.fuzzyObserveEnabled.get() && !turn.fuzzyObserved) {
          stream = observeFuzzy(stream, count => {
            if (!current() || turn.fuzzyObserved || !config.fuzzyObserveEnabled.get()) return;
            turn.fuzzyObserved = true;
            queueActivity(state.session, { turn: turn.number, rule: 'fuzzy', count, action: 'observed' },
              () => sessions.get(id) === state);
          });
        }
        return stream;
      };
      // A failure notice suppresses automatic resume, not repetition detection.
      if (!config.repeatEnabled.get() || turn.repeat || (turn.repeatObserved && config.observeOnly.get())) return observe(source);
      let cut = false;
      const threshold = config.repeatLimit.get();
      const diagnostics = store !== undefined && config.diagnosticsEnabled.get();
      return observe(guardReasoning(source, threshold, ({ count, trace }) => {
        if (!current()) return;
        if (!cut && (turn.repeatObserved || !config.observeOnly.get() || !config.repeatEnabled.get())) return;
        if (cut) turn.repeat = true;
        else turn.repeatObserved = true;
        if (trace && store && config.diagnosticsEnabled.get()) {
          const report: DiagnosticReport = { version: 1, kind: 'automatic', pluginVersion, hostVersion,
            threshold, mode: cut ? 'enforce' : 'observe', count, action: cut ? 'cut' : 'observed', trace };
          turn.diagnostic = report;
          void store.put(id, turn.number, report);
        }
        queueActivity(state.session, { turn: turn.number, rule: 'repeat', count, action: cut ? 'cut' : 'observed' },
          () => sessions.get(id) === state);
      }, () => {
        cut = current() && !turn.repeat && config.repeatEnabled.get() && !config.observeOnly.get();
        return cut;
      }, diagnostics));
    }, { global: true });
    const stopping = ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
      const state = sessions.get(agent.session.id);
      const active = state?.turn;
      if (!state || !active || active.number !== turn || !active.repeat || active.resumed || active.failureNotified || signal.aborted) return;
      const resume = config.resumeOnRepeat.get();
      const experiment = !resume && config.activeSteerEnabled.get();
      if (config.observeOnly.get() || !config.repeatEnabled.get() || (!experiment && !resume)) return;
      active.resumed = true;
      if (experiment) {
        try { agent.steer(notice('复读引导（实验）', '刚才因连续复读停止生成。请勿重复推理或重试原操作。直接给出已有结论；若仍有卡点，说明卡点并等待用户。')); }
        catch { return; } // A failed enqueue never retries and never cancels the turn.
        queueActivity(state.session, { turn, rule: 'steer', count: 1, action: 'steer-queued' },
          () => sessions.get(agent.session.id) === state);
      } else {
        agent.steer(notice('复读打断 · 续跑一次', '刚才因连续复读停止生成。请跳过重复推演，直接产出下一步或报告卡点。'));
      }
      if (store && active.diagnostic?.action === 'cut' && config.diagnosticsEnabled.get()) {
        void store.put(agent.session.id, turn, { ...active.diagnostic, action: 'resumed' });
      }
    });
    for (const agent of ctx.agents.list()) attach({ agent });
    return () => {
      created(); disposed(); status(); streaming(); stopping();
      for (const [id, state] of sessions) { sessions.delete(id); state.dispose(); }
    };
  });
}
