export const PACKAGE_NAME = 'dsh-fail-guard';
export const ENTRY_ID = 'dsh-fail-guard-standalone';

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

export const DEFAULTS: Readonly<GuardOptions> = Object.freeze({
  failureEnabled: true,
  failureLimit: 3,
  repeatEnabled: true,
  repeatLimit: 5,
  resumeOnRepeat: false,
  observeOnly: false,
  diagnosticsEnabled: false,
  fragmentObserveEnabled: false,
  fuzzyObserveEnabled: false,
  crossTurnObserveEnabled: false,
  activeSteerEnabled: false,
  stopSimulationEnabled: false,
});

export const LIMITS = Object.freeze({
  failureLimit: Object.freeze({ min: 2, max: 12 }),
  repeatLimit: Object.freeze({ min: 3, max: 15 }),
});
