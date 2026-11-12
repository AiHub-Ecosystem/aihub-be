import { readFileSync } from 'node:fs';

/**
 * Evaluates a relative path against .dockerignore rules.
 * Supports basic Dockerignore syntax: comments, negations (!), directory roots,
 * and wildcards (* and **).
 */
function isDockerIgnored(
  relativePath: string,
  dockerignoreContent: string,
): boolean {
  const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const lines = dockerignoreContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  let ignored = false;

  for (const rawRule of lines) {
    const isNegation = rawRule.startsWith('!');
    const pattern = (isNegation ? rawRule.slice(1) : rawRule).trim();

    const matches = matchDockerignorePattern(pattern, normalizedPath);
    if (matches) {
      ignored = !isNegation;
    }
  }

  return ignored;
}

function matchDockerignorePattern(pattern: string, path: string): boolean {
  const cleanPattern = pattern.replace(/\/+$/, '');
  const isDirectoryOnly = pattern.endsWith('/');

  if (isDirectoryOnly && !path.includes('/')) {
    // If rule is dir-only (e.g. "temp/"), it matches "temp/anything" but not a file named "temp"
    return path.startsWith(`${cleanPattern}/`);
  }

  // Exact directory match or directory contents
  if (path === cleanPattern || path.startsWith(`${cleanPattern}/`)) {
    return true;
  }

  // Global double-star wildcard (e.g. **/*.pem)
  if (cleanPattern.startsWith('**/')) {
    const suffix = cleanPattern.slice(3);
    if (suffix.startsWith('*.')) {
      const ext = suffix.slice(1); // e.g. ".pem"
      return path.endsWith(ext);
    }
  }

  // Root wildcard extension (e.g. *.pem)
  if (cleanPattern.startsWith('*.')) {
    const ext = cleanPattern.slice(1);
    // Matches at root or any depth if pattern has no slash
    return !cleanPattern.includes('/')
      ? path.endsWith(ext)
      : path.endsWith(ext) && !path.includes('/');
  }

  // Path wildcard (e.g. temp/**)
  if (cleanPattern.endsWith('/**')) {
    const prefix = cleanPattern.slice(0, -3);
    return path.startsWith(`${prefix}/`);
  }

  return false;
}

describe('Docker context exclusions (#1154)', () => {
  const dockerignore = readFileSync('.dockerignore', 'utf8');

  it('declares rules excluding temp, PEM signing material, and demo jwks', () => {
    expect(dockerignore).toMatch(/^temp(?:\/|\s|$)/m);
    expect(dockerignore).toMatch(/\*\.pem/);
    expect(dockerignore).toMatch(/demo-jwks\.json/);
  });

  it('excludes synthetic non-secret marker files in temp and signing key paths', () => {
    const syntheticMarkers = [
      'temp/synthetic-marker.txt',
      'temp/nested/transient.json',
      'temp/scratch.pem',
      'demo-private.pem',
      'auth-signing-key.pem',
      'keys/nested/operator-private.pem',
      'src/modules/auth/dummy.pem',
      'demo-jwks.json',
    ];

    for (const marker of syntheticMarkers) {
      expect(isDockerIgnored(marker, dockerignore)).toBe(true);
    }
  });

  it('preserves access to required source, lockfiles, generation scripts, and migrations', () => {
    const requiredBuildInputs = [
      'package.json',
      'bun.lock',
      'src/main.ts',
      'src/app.module.ts',
      'prisma/schema.prisma',
      'prisma/migrations/migration_lock.toml',
      'scripts/cli/cli.mjs',
      'scripts/cli/migrate.mjs',
      'scripts/generate/generate-prisma-client.mjs',
      'scripts/runtime/runtime-entrypoint.mjs',
    ];

    for (const input of requiredBuildInputs) {
      expect(isDockerIgnored(input, dockerignore)).toBe(false);
    }
  });
});
