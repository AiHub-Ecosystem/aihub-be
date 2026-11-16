import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The first release fixing GHSA-3m5p-2c4r-xxw2 (X-Forwarded-* spoofing under
// trustProxy) and GHSA-w2qp-rph6-63g4 (schema validation bypass).
const FASTIFY_ADVISORY_FLOOR = [5, 12, 1] as const;

interface InstalledFastify {
  readonly directory: string;
  readonly version: string;
}

function fastifyResolvedFrom(directory: string): InstalledFastify {
  const packageDirectory = realpathSync(
    dirname(require.resolve('fastify', { paths: [directory] })),
  );
  const manifest: unknown = JSON.parse(
    readFileSync(join(packageDirectory, 'package.json'), 'utf8'),
  );
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string'
  ) {
    throw new Error(`No Fastify version at ${packageDirectory}`);
  }
  return { directory: packageDirectory, version: manifest.version };
}

function isAtLeast(version: string, floor: readonly number[]): boolean {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  for (const [index, minimum] of floor.entries()) {
    const part = parts[index] ?? 0;
    if (part !== minimum) {
      return part > minimum;
    }
  }
  return true;
}

describe('Fastify resolution', () => {
  // The server is whatever the Nest adapter loads, not the application's own
  // dependency: two copies once left the served one unpatched while the
  // manifest looked patched.
  const adapterDirectory = realpathSync(
    join(process.cwd(), 'node_modules', '@nestjs', 'platform-fastify'),
  );

  it('serves requests on the same Fastify the application compiles against', () => {
    expect(fastifyResolvedFrom(adapterDirectory)).toEqual(
      fastifyResolvedFrom(process.cwd()),
    );
  });

  it('serves requests on a Fastify release that carries the security fixes', () => {
    const { version } = fastifyResolvedFrom(adapterDirectory);

    expect({
      version,
      patched: isAtLeast(version, FASTIFY_ADVISORY_FLOOR),
    }).toEqual({
      version,
      patched: true,
    });
  });
});
