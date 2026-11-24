import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { DiagnosticStore } from './diagnostic-store.js';
export declare class GuardDiagnostics extends TypertRemoteService {
    private readonly store;
    constructor(ctx: Context, store: DiagnosticStore);
    getReport(request: {
        sessionId: string;
        turn: number;
    }): Promise<import("./diagnostic-shared.js").DiagnosticReport | null>;
}
