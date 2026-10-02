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
): Promise<OperatorCommandResult<Result>> {
  try {
    const clock = now ?? (() => new Date());
    const context: OperatorCommandContext = {
      requestId: generateRequestId(),
      occurredAt: clock(),
    };
    return { context, result: await operation(context) };
  } finally {
    await repository.close();
  }
}
