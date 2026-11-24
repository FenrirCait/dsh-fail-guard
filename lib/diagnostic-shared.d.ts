export interface DiagnosticReport {
    version: 1;
    kind: 'automatic';
    pluginVersion: string;
    hostVersion: string | null;
    threshold: number;
    mode: 'observe' | 'enforce';
    count: number;
    action: 'observed' | 'cut' | 'resumed';
    trace: {
        events: readonly {
            kind: 'start' | 'end' | 'delta';
            block: number;
        }[];
        groups: readonly number[];
    };
}
