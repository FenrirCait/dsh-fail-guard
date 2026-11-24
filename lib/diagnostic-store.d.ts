import { z } from 'zod';
import type { DiagnosticReport } from './diagnostic-shared.js';
export declare const TTL_MS: number;
export declare const reportSchema: z.ZodType<DiagnosticReport>;
export type DiagnosticStore = ReturnType<typeof createDiagnosticStore>;
export declare function createDiagnosticStore(profileDir: string, now?: () => number): {
    prune: () => Promise<void | undefined>;
    put(session: string, turn: number, report: DiagnosticReport): Promise<boolean>;
    get(session: string, turn: number): Promise<DiagnosticReport | null>;
};
