import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isRecord } from '@/common/is-record';

function fixture(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(
      resolve(process.cwd(), `test/fixtures/ai-writing/${name}`),
      'utf8',
    ),
  );
  if (!isRecord(parsed)) {
    throw new Error('fixture is not an object');
  }
  return parsed;
}

export function withWritingErrorPriorityCapture(
  body: Record<string, unknown>,
  task: 1 | 2,
): Record<string, unknown> {
  const data = body['data'];
  const capturedData = fixture(
    `grade-v3-task${task}-error-priority.capture.json`,
  )['data'];
  if (!isRecord(data) || !isRecord(capturedData)) {
    throw new Error('fixture data is not an object');
  }
  return {
    ...body,
    data: { ...data, error_priority: capturedData['error_priority'] },
  };
}
