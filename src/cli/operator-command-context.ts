import { generateRequestId } from '@/common/request-context/request-id';

export interface OperatorCommandContext {
  readonly requestId: string;
  readonly occurredAt: Date;
}

export interface OperatorCommandResult<Result> {
  readonly context: OperatorCommandContext;
  readonly result: Result;
}

export async function runOperatorCommand<
  Repository extends { close(): Promise<void> },
  Result,
>(
  repository: Repository,
  now: (() => Date) | undefined,
  operation: (context: OperatorCommandContext) => Promise<Result>,
  closable?: { close(): Promise<void> },
): Promise<OperatorCommandResult<Result>> {
  let storageClosed = false;
  try {
    const clock = now ?? (() => new Date());
    const context: OperatorCommandContext = {
      requestId: generateRequestId(),
      occurredAt: clock(),
    };
    const result: Result = await operation(context);
    // Storage owns its S3Client keep-alive agents; destroy runs here on
    // success and in the finally below on failure, so a failing operation
    // cannot leak sockets into the next cron run of the same process
    // (#1523). The destroy error on success is the command's own error.
    if (closable !== undefined) {
      await closable.close();
      storageClosed = true;
    }
    return { context, result };
  } finally {
    if (closable !== undefined && !storageClosed) {
      await closable.close().catch(() => undefined);
    }
    await repository.close();
  }
}
