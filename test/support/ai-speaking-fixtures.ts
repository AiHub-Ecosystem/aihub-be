import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@/common/is-record';

const FIXTURES = join(__dirname, '../fixtures/ai-speaking');

export function aiSpeakingFixture(name: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
  if (!isRecord(value)) {
    throw new Error(`Fixture ${name} must be a JSON object`);
  }
  return value;
}
