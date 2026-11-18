import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@/common/is-record';

const FIXTURES = join(__dirname, '../fixtures');

/** Absolute path to a fixture directory, for specs that enumerate it. */
export function fixtureDirectory(
  directory: 'ai-speaking' | 'ai-writing',
): string {
  return join(FIXTURES, directory);
}

/**
 * Read one captured provider fixture. Returns `unknown` on purpose: the
 * captures include arrays and scalars, and each spec narrows the shape it
 * actually reads.
 */
export function fixtureJson(
  directory: 'ai-speaking' | 'ai-writing',
  name: string,
): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, directory, name), 'utf8'));
}

/** A captured Speaking body, which every caller reads named members from. */
export function aiSpeakingFixture(name: string): Record<string, unknown> {
  const value = fixtureJson('ai-speaking', name);
  if (!isRecord(value)) {
    throw new Error(`Fixture ${name} must be a JSON object`);
  }
  return value;
}
