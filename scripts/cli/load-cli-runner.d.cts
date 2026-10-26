export type CliRunner = (...args: never[]) => unknown;

export interface CliRunnerDescriptor<T extends CliRunner> {
  readonly builtPath: string;
  readonly sourcePath: string;
  readonly exportName: string;
  readonly unavailableMessage: string;
  readonly runner?: T;
}

export function loadCliRunner<T extends CliRunner>(
  descriptor: CliRunnerDescriptor<T>,
): Promise<T>;
