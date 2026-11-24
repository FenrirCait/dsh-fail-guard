import type { Context } from '@deepseek-ai/cordis';
import type { InvocationDescriptor, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import type { DiagnosticReport } from '../diagnostic-shared.js';

const descriptor: InvocationDescriptor = {
  id: 'dsh-fail-guard#guardDiagnostics/getReport', service: 'guardDiagnostics', namespace: 'guardDiagnostics', method: 'getReport',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: {
    mode: 'strict', typeSymbol: 'dsh-fail-guard#DiagnosticRequest', create: () => ({ parse(input: unknown) {
      const value = input as { sessionId?: unknown; turn?: unknown } | null;
      if (!value || typeof value.sessionId !== 'string' || value.sessionId.length === 0 || value.sessionId.length > 160 || typeof value.turn !== 'number' || !Number.isSafeInteger(value.turn) || value.turn < 0) throw new TypeError('Invalid diagnostic request');
      return { sessionId: value.sessionId, turn: value.turn };
    } }),
  } }],
  result: { mode: 'src-json' },
};

type DiagnosticApi = {
  getReport(request: { sessionId: string; turn: number }): Promise<{ ok: true; value: DiagnosticReport | null } | { ok: false }>;
};

export function installDiagnosticReader(ctx: Context) {
  type Reader = (sessionId: string, turn: number) => Promise<DiagnosticReport | null>;
  let mountReady = false;
  let get: Reader | undefined;
  ctx.inject(['remote'], c => {
    // The Gateway and each mounted namespace are separate Cordis services.
    // The child waits for the namespace; mounting must not wait for that child.
    c.inject(['remote.guardDiagnostics'], scoped => {
      scoped.effect(() => {
        const api = scoped.get('remote.guardDiagnostics') as DiagnosticApi;
        const reader: Reader = async (sessionId, turn) => {
          const result = await api.getReport({ sessionId, turn });
          if (!result.ok) throw new Error('本地诊断读取未成功');
          return result.value;
        };
        get = reader;
        return () => { if (get === reader) get = undefined; };
      });
    });
    c.effect(() => {
      const remote = c.get('remote') as TypertClientRemote;
      let alive = true;
      let dispose: (() => Promise<void>) | undefined;
      void remote.$mount({ package: 'dsh-fail-guard', descriptors: [descriptor] }).then(stop => {
        if (!alive) return stop();
        dispose = stop;
        mountReady = true;
      }).catch(() => {});
      return () => {
        alive = false;
        mountReady = false;
        if (dispose) void dispose().catch(() => {});
      };
    });
  });
  return (sessionId: string, turn: number) => mountReady && get ? get(sessionId, turn) : Promise.reject(new Error('本地诊断读取暂不可用'));
}
