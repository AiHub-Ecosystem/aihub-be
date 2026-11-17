import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { assert } from 'fast-check';

export async function assertWithReproducer(
  property: Parameters<typeof assert>[0],
  seed: number,
  file: string,
): Promise<void> {
  const directory = resolve(process.cwd(), 'test/fuzz/failed-cases');
  const reproducer = join(directory, file);
  const saved = existsSync(reproducer)
    ? (JSON.parse(readFileSync(reproducer, 'utf8')) as {
        seed?: number;
        path?: string;
      })
    : undefined;
  try {
    await assert(property, {
      seed: saved?.seed ?? seed,
      ...(saved?.path === undefined ? {} : { path: saved.path }),
      numRuns: 96,
      endOnFailure: true,
    });
  } catch (error) {
    const details = error as Error & {
      counterexample?: unknown;
      path?: string;
      seed?: number;
    };
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      reproducer,
      JSON.stringify(
        {
          seed: details.seed ?? seed,
          path: details.path,
          counterexample: details.counterexample,
        },
        null,
        2,
      ),
    );
    throw new Error(`Fuzz failure; reproducer written to ${reproducer}`, {
      cause: error,
    });
  }
}
