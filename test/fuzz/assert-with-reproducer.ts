import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { assert } from 'fast-check';

export async function assertWithReproducer(
  property: Parameters<typeof assert>[0],
  seed: number,
  file: string,
): Promise<void> {
  try {
    await assert(property, { seed, numRuns: 96, endOnFailure: true });
  } catch (error) {
    const details = error as Error & {
      counterexample?: unknown;
      path?: string;
      seed?: number;
    };
    const directory = resolve(process.cwd(), 'test/fuzz/failed-cases');
    mkdirSync(directory, { recursive: true });
    const reproducer = join(directory, file);
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
