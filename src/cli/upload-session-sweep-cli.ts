import { runOperatorCommand } from './operator-command-context';

export interface UploadSessionSweepCliOptions {
  readonly dryRun: boolean;
  readonly now?: () => Date;
  readonly clockSource?: 'process' | 'database';
  readonly emit?: (line: string) => void;
}

/** Shared operator-command wrapper for upload-session sweeps. */
export async function runUploadSessionSweepCli<
  Repository extends { close(): Promise<void> },
  Result extends object,
>(input: {
  readonly repository: Repository;
  readonly storage: { close(): Promise<void> } | undefined;
  readonly sweep: {
    run(value: {
      readonly dryRun: boolean;
      readonly now: Date;
    }): Promise<Result>;
  };
  readonly options: UploadSessionSweepCliOptions;
}): Promise<Result> {
  const { result } = await runOperatorCommand(
    input.repository,
    input.options.now,
    ({ occurredAt }) =>
      input.sweep.run({ dryRun: input.options.dryRun, now: occurredAt }),
    input.storage,
  );
  (input.options.emit ?? console.log)(
    JSON.stringify({
      ...result,
      cutoff_source: input.options.clockSource ?? 'process',
    }),
  );
  return result;
}
