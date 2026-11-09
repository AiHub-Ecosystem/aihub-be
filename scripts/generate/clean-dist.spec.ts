import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { cleanDist } = require('./clean-dist.cjs') as {
  cleanDist: (distDirectory: string) => void;
};

function write(root: string, file: string): void {
  const target = join(root, file);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, file);
}

describe('clean-dist', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aihub-clean-dist-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('removes a previous build but keeps the generated Prisma client and Kysely types', () => {
    const dist = join(root, 'dist');
    write(dist, 'main.js');
    write(dist, 'src/modules/app.js');
    write(dist, 'generated/prisma/client.ts');
    write(dist, 'generated/prisma/client.js');
    write(dist, 'generated/prisma/models/User.js');
    write(dist, 'generated/prisma/.stamp');
    write(dist, 'generated/kysely/types.ts');

    cleanDist(dist);

    expect({
      main: existsSync(join(dist, 'main.js')),
      modules: existsSync(join(dist, 'src')),
      client: existsSync(join(dist, 'generated/prisma/client.js')),
      model: existsSync(join(dist, 'generated/prisma/models/User.js')),
      stamp: readFileSync(join(dist, 'generated/prisma/.stamp'), 'utf8'),
      kysely: existsSync(join(dist, 'generated/kysely/types.ts')),
    }).toEqual({
      main: false,
      modules: false,
      client: true,
      model: true,
      stamp: 'generated/prisma/.stamp',
      kysely: true,
    });
  });

  it('drops a leftover staging directory beside the client', () => {
    const dist = join(root, 'dist');
    write(dist, 'generated/prisma/client.ts');
    write(dist, 'generated/.staging/dist/generated/prisma/client.js');

    cleanDist(dist);

    expect(existsSync(join(dist, 'generated/.staging'))).toBe(false);
    expect(existsSync(join(dist, 'generated/prisma/client.ts'))).toBe(true);
  });

  it('does nothing without a dist directory', () => {
    const dist = join(root, 'missing');

    cleanDist(dist);

    expect(existsSync(dist)).toBe(false);
  });
});

describe('build script', () => {
  it('cleans dist through clean-dist and never wipes the generated client', () => {
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;

    expect(scripts['build']).toContain('scripts/generate/clean-dist.cjs');
  });
});
