export declare const PACKAGE_NAME = "dsh-fail-guard";
export declare const ENTRY_ID = "dsh-fail-guard-standalone";
export interface GuardOptions {
    failureEnabled: boolean;
    failureLimit: number;
    repeatEnabled: boolean;
    repeatLimit: number;
    resumeOnRepeat: boolean;
    observeOnly: boolean;
    diagnosticsEnabled: boolean;
    fragmentObserveEnabled: boolean;
    fuzzyObserveEnabled: boolean;
    crossTurnObserveEnabled: boolean;
    activeSteerEnabled: boolean;
    stopSimulationEnabled: boolean;
}
export declare const DEFAULTS: Readonly<GuardOptions>;
export declare const LIMITS: Readonly<{
    failureLimit: Readonly<{
        min: 2;
        max: 12;
    }>;
    repeatLimit: Readonly<{
        min: 3;
        max: 15;
    }>;
}>;
