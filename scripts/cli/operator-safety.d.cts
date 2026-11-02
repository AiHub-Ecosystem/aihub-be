export type OperatorDeployment = 'production' | 'sandbox' | 'test' | 'unknown';
export type MaintenanceClockSource = 'process' | 'database';

export interface MaintenanceClock {
  readonly now: Date;
  readonly source: MaintenanceClockSource;
}

export interface OperatorMutationPreview {
  readonly command: string;
  readonly action: string;
  readonly target?: string;
}

export const CONTROL_PLANE_COMMANDS: ReadonlySet<string>;
export const MUTATING_COMMANDS: ReadonlySet<string>;
export const NATIVE_DRY_RUN_COMMANDS: ReadonlySet<string>;

export function classifyDatabase(databaseName: string): OperatorDeployment;
export function effectiveMaintenanceTime(
  processNow: Date,
  databaseNow: Date,
): MaintenanceClock;
export function isMutatingCommand(
  command: string | undefined,
  options: ReadonlyMap<string, string>,
): boolean;
export function previewOperatorMutation(
  command: string,
  options: ReadonlyMap<string, string>,
): OperatorMutationPreview;
export function requireControlPlaneDatabase(
  deployment: OperatorDeployment,
): void;
export function requireTargetConfirmation(
  deployment: OperatorDeployment,
  requestedTarget: string | undefined,
): void;
