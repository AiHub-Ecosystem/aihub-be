export const GATE_COMMANDS: Readonly<Record<string, string>>;

export type ChangedFilePlan =
  | {
      readonly gates: string[];
      readonly fullVerify?: false;
      readonly reason?: never;
    }
  | {
      readonly gates?: never;
      readonly fullVerify: true;
      readonly reason: string;
    };

export function planChangedFiles(files: readonly string[]): ChangedFilePlan;
export function resolveChangedFiles(git?: (args: string[]) => string): string[];
export function gateInvocation(
  gate: string,
  files: readonly string[],
  exists?: (path: string) => boolean,
): { readonly script: string; readonly args: string[] } | undefined;
export function runCheckChanged(options: {
  readonly resolveFiles: () => string[];
  readonly runGate: (gate: string) => number | Promise<number>;
  readonly runBatchGates: (gates: string[]) => Promise<{ failed: string[] }>;
  readonly runFullVerify: () => unknown;
}): Promise<string>;
export function isEntryPoint(
  moduleUrl: string,
  argv1: string | undefined,
): boolean;
