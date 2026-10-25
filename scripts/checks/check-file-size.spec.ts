import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const script = join(process.cwd(), 'scripts', 'checks', 'check-file-size.mjs');
const SPLIT_MEMBERSHIP_ENTRY =
  'src/modules/identity/membership/infrastructure/postgres-organization-membership.repository.ts';
const SPLIT_OPENAPI_ENTRY = 'src/openapi/build-openapi-document.ts';
const SPLIT_JWKS_ENTRY =
  'src/modules/identity/user-assertions/infrastructure/jwks-key-provider.ts';
const EXEMPT = 'src/catalog/public-routes.ts';

function runCheck(cwd: string) {
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

function codeLines(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `export const x${i} = ${i};`,
  ).join('\n');
}

// Each case builds its own tree: a scratch file inside the real `src/` races
// the other checks that scan it from parallel Jest workers.
function runOnFixture(files: Record<string, string>) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'aihub-file-size-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true });
      writeFileSync(join(fixtureRoot, path), content);
    }
    const result = runCheck(fixtureRoot);
    return { status: result.status, output: result.stderr + result.stdout };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe('file-size ceiling check', () => {
  it('fails when a new hand-written file exceeds the ceiling', () => {
    const result = runOnFixture({ 'src/big.ts': codeLines(501) });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/exceeds the 500-line ceiling/);
  });

  it('enforces the ceiling on the retired membership repository path', () => {
    const result = runOnFixture({ [SPLIT_MEMBERSHIP_ENTRY]: codeLines(501) });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/exceeds the 500-line ceiling/);
  });

  it.each([SPLIT_OPENAPI_ENTRY, SPLIT_JWKS_ENTRY])(
    'enforces the ceiling on split entry point %s',
    (entry) => {
      const result = runOnFixture({ [entry]: codeLines(501) });

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/exceeds the 500-line ceiling/);
    },
  );

  it('does not cap a file exempt by design', () => {
    expect(runOnFixture({ [EXEMPT]: codeLines(5000) }).status).toBe(0);
  });

  it('passes on the real tree', () => {
    expect(runCheck(process.cwd()).status).toBe(0);
  });
});
