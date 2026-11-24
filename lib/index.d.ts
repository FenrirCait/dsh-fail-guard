import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "dsh-fail-guard";
export declare const inject: string[];
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    failureEnabled: Schema<boolean, boolean, "volatile-defined">;
    failureLimit: Schema<number, number, "volatile-defined">;
    repeatEnabled: Schema<boolean, boolean, "volatile-defined">;
    repeatLimit: Schema<number, number, "volatile-defined">;
    resumeOnRepeat: Schema<boolean, boolean, "volatile-defined">;
    observeOnly: Schema<boolean, boolean, "volatile-defined">;
    diagnosticsEnabled: Schema<boolean, boolean, "volatile-defined">;
    fragmentObserveEnabled: Schema<boolean, boolean, "volatile-defined">;
    fuzzyObserveEnabled: Schema<boolean, boolean, "volatile-defined">;
    crossTurnObserveEnabled: Schema<boolean, boolean, "volatile-defined">;
    activeSteerEnabled: Schema<boolean, boolean, "volatile-defined">;
    stopSimulationEnabled: Schema<boolean, boolean, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    failureEnabled: Schema<boolean, boolean, "volatile-defined">;
    failureLimit: Schema<number, number, "volatile-defined">;
    repeatEnabled: Schema<boolean, boolean, "volatile-defined">;
    repeatLimit: Schema<number, number, "volatile-defined">;
    resumeOnRepeat: Schema<boolean, boolean, "volatile-defined">;
    observeOnly: Schema<boolean, boolean, "volatile-defined">;
    diagnosticsEnabled: Schema<boolean, boolean, "volatile-defined">;
    fragmentObserveEnabled: Schema<boolean, boolean, "volatile-defined">;
    fuzzyObserveEnabled: Schema<boolean, boolean, "volatile-defined">;
    crossTurnObserveEnabled: Schema<boolean, boolean, "volatile-defined">;
    activeSteerEnabled: Schema<boolean, boolean, "volatile-defined">;
    stopSimulationEnabled: Schema<boolean, boolean, "volatile-defined">;
}>>, "plain">;
declare module '@deepseek-ai/dsh-llm/types' {
    interface MessageSourceMap {
        'plugin:fail-guard-standalone': {
            kind: 'plugin:fail-guard-standalone';
            form: 'notice';
            summary: string;
        };
    }
}
export declare function apply(ctx: Context, config: ReturnType<typeof Config>): void;
