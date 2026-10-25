import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const script = join(process.cwd(), 'scripts', 'checks', 'check-file-size.mjs');
const GRANDFATHERED =
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

const realGrandfathered = (): string =>
  readFileSync(join(process.cwd(), GRANDFATHERED), 'utf8');

describe('file-size ceiling check', () => {
  it('fails when a new hand-written file exceeds the ceiling', () => {
    const result = runOnFixture({ 'src/big.ts': codeLines(501) });

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

  it('passes a grandfathered file at its recorded size', () => {
    expect(runOnFixture({ [GRANDFATHERED]: realGrandfathered() }).status).toBe(
      0,
    );
  });

  it('fails when a grandfathered file grows past its recorded size', () => {
    const result = runOnFixture({
      [GRANDFATHERED]: `${realGrandfathered()}\nexport const grown = 1;\n`,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/grew past its grandfathered/);
  });

  it('fails until the recorded size is lowered after a grandfathered file shrinks', () => {
    const result = runOnFixture({ [GRANDFATHERED]: codeLines(600) });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/lower the recorded count to 600/);
  });

  it('fails until a grandfathered file back under the ceiling leaves the list', () => {
    const result = runOnFixture({ [GRANDFATHERED]: codeLines(400) });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/remove it from the grandfathered list/);
  });

  it('does not ratchet a file exempt by design', () => {
    expect(runOnFixture({ [EXEMPT]: codeLines(5000) }).status).toBe(0);
  });

  it('passes on the real tree', () => {
    expect(runCheck(process.cwd()).status).toBe(0);
  });
});
