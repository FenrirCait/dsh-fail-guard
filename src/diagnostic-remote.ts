import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { DiagnosticStore } from './diagnostic-store.js';

export class GuardDiagnostics extends TypertRemoteService {
  constructor(ctx: Context, private readonly store: DiagnosticStore) {
    super(ctx, 'guardDiagnostics');
  }

  @Remote('getReport')
  async getReport(request: { sessionId: string; turn: number }) {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') return null;
    if (typeof request?.sessionId !== 'string' || !Number.isSafeInteger(request.turn) || request.turn < 0) return null;
    return this.store.get(request.sessionId, request.turn);
  }
}
