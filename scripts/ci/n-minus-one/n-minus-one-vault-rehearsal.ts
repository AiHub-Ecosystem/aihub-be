import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PREVIOUS_PORT,
  ROOT,
  startImage,
  stopImage,
  waitReady,
} from './n-minus-one-runtime';

const ADDITIVE_KEY = 'rehearsal-additive';
/** Marks the fixture in output; it is not a credential and opens nothing. */
export const ADDITIVE_FIXTURE_VALUE = 'ci-rehearsal-fixture-value';
const BOOT_CONTAINER = 'aihub-compat-additive';
const BOOT_WINDOW_MS = 30_000;

/** The candidate document of a release that adds one key beside the known ones. */
export function withAdditiveDocumentKey(document: string): string {
  const parsed = JSON.parse(document) as Record<string, unknown>;
  return JSON.stringify({
    ...parsed,
    [ADDITIVE_KEY]: { value: ADDITIVE_FIXTURE_VALUE },
  });
}

export type AdditiveBootOutcome =
  | { readonly kind: 'rejected' | 'accepted'; readonly message: string }
  | { readonly kind: 'leaked'; readonly message: string };

/**
 * A reader that rejects the added key is why a new document key ships in two
 * releases; one that accepts it is the reader-first release already shipped.
 * Either is a valid state. What is never valid is the fixture value in output.
 */
export function classifyAdditiveBoot(boot: {
  readonly exited: boolean;
  readonly output: string;
}): AdditiveBootOutcome {
  if (boot.output.includes(ADDITIVE_FIXTURE_VALUE)) {
    return {
      kind: 'leaked',
      message: 'N-1 printed the fixture value of the added document key.',
    };
  }
  return boot.exited
    ? {
        kind: 'rejected',
        message:
          'N-1 refused to boot with an added Vault document key, as a strict reader does; the key needs a reader-first release.',
      }
    : {
        kind: 'accepted',
        message:
          'N-1 booted with an added Vault document key, so its reader already tolerates the key.',
      };
}

/**
 * Boots N-1 against a document with one added key, then restores the previous
 * document and proves N-1 ready again, the order a rollback follows.
 */
export async function verifyAdditiveVaultKeyRollback(input: {
  readonly previousImage: string;
  readonly previousDirectory: string;
  readonly previousSha: string;
  readonly candidateSha: string;
  readonly report: string[];
  readonly failures: string[];
}): Promise<void> {
  const { previousImage, previousDirectory, previousSha, candidateSha } = input;
  const runtimePath = resolve(previousDirectory, 'runtime-secrets.json');
  const original = readFileSync(runtimePath, 'utf8');
  stopImage('aihub-compat-previous');
  let outcome: AdditiveBootOutcome;
  try {
    writeFileSync(runtimePath, withAdditiveDocumentKey(original));
    const boot = spawnSync(
      'docker',
      [
        'run',
        '--init',
        '--network',
        'host',
        '--name',
        BOOT_CONTAINER,
        '--add-host',
        'api.resend.com:127.0.0.1',
        '--env-file',
        resolve(previousDirectory, 'boot.env'),
        '--volume',
        `${previousDirectory}:/run/secrets/aihub:ro`,
        previousImage,
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: BOOT_WINDOW_MS },
    );
    stopImage(BOOT_CONTAINER);
    outcome = classifyAdditiveBoot({
      exited: boot.error === undefined,
      output: `${boot.stdout}${boot.stderr}`,
    });
  } finally {
    writeFileSync(runtimePath, original);
  }

  const context = `(N-1 ${previousSha}, candidate ${candidateSha})`;
  if (outcome.kind === 'leaked') {
    input.failures.push(`FAIL: ${outcome.message} ${context}`);
  } else {
    input.report.push(`PASS: ${outcome.message} ${context}`);
  }

  startImage(previousImage, 'aihub-compat-previous', previousDirectory);
  await waitReady(PREVIOUS_PORT, 'N-1 after restoring its document');
  input.report.push(
    `PASS: N-1 became ready again once its previous Vault document was restored ${context}.`,
  );
}
