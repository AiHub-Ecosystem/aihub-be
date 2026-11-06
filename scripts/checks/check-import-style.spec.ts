import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  canSkipAst,
  collectDistViolations,
  collectViolations,
} from './check-import-style';

let root: string;
let srcRoot: string;

function fixture(relativePath: string, contents: string): string {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
  return file;
}

function sourceFixture(contents: string): string {
  return fixture('src/modules/identity/domain/api-key.ts', contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'import-style-'));
  srcRoot = join(root, 'src');
  mkdirSync(srcRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parent-relative import resolution', () => {
  it('reports a parent-relative import that resolves under src', () => {
    const file = sourceFixture(
      "import { AppError } from '../../../common/errors/app-error';\n",
    );

    expect(collectViolations(file, srcRoot)).toEqual([
      { file, line: 1, specifier: '../../../common/errors/app-error' },
    ]);
  });

  it('reports a parent segment that follows a leading dot', () => {
    const file = sourceFixture(
      "import { AppError } from './../../../common/errors/app-error';\n",
    );

    expect(
      collectViolations(file, srcRoot).map((hit) => hit.specifier),
    ).toEqual(['./../../../common/errors/app-error']);
  });

  it('reports a bare parent segment', () => {
    const file = sourceFixture("import { clock } from '..';\n");

    expect(collectViolations(file, srcRoot)).toHaveLength(1);
  });

  it('reports a re-export that resolves under src', () => {
    const file = fixture(
      'src/modules/identity/index.ts',
      "export { AppError } from '../../common/errors/app-error';\n",
    );

    expect(
      collectViolations(file, srcRoot).map((violation) => violation.specifier),
    ).toEqual(['../../common/errors/app-error']);
  });

  it('reports a require that resolves under src', () => {
    const file = fixture(
      'src/cli/seed.ts',
      "const { AppError } = require('../common/errors/app-error');\n",
    );

    expect(collectViolations(file, srcRoot)).toHaveLength(1);
  });

  it('reports a dynamic import that resolves under src', () => {
    const file = fixture(
      'src/cli/lazy.ts',
      "const { AppError } = await import('../common/errors/app-error');\n",
    );

    expect(collectViolations(file, srcRoot)).toHaveLength(1);
  });

  it('accepts a sibling import', () => {
    const file = sourceFixture("import { clock } from './clock';\n");

    expect(collectViolations(file, srcRoot)).toEqual([]);
  });

  it('accepts an aliased import', () => {
    const file = sourceFixture(
      "import { AppError } from '@/common/errors/app-error';\n",
    );

    expect(collectViolations(file, srcRoot)).toEqual([]);
  });

  it('accepts a parent-relative import that resolves outside src', () => {
    const file = fixture(
      'test/db/tenant-isolation/identity.spec.ts',
      "import { createTestPool } from '../database';\n",
    );

    expect(collectViolations(file, srcRoot)).toEqual([]);
  });

  it('reports a parent-relative import from the test tree into src', () => {
    const file = fixture(
      'test/db/tenant-isolation/fixtures.ts',
      "import { AppError } from '../../../src/common/errors/app-error';\n",
    );

    expect(
      collectViolations(file, srcRoot).map((violation) => violation.specifier),
    ).toEqual(['../../../src/common/errors/app-error']);
  });

  it('ignores a filesystem path assembled from the current directory', () => {
    const file = fixture(
      'src/openapi/openapi.controller.ts',
      "const pkg = readFileSync(join(__dirname, '../../package.json'), 'utf8');\n",
    );

    expect(collectViolations(file, srcRoot)).toEqual([]);
  });

  it('ignores a comment that quotes a parent-relative path', () => {
    const file = fixture(
      'src/openapi/openapi.controller.ts',
      '// `../../package.json` from the compiled `dist/openapi/`.\n',
    );

    expect(collectViolations(file, srcRoot)).toEqual([]);
  });
});

describe('fast path', () => {
  it('skips AST creation for content with no parent-relative specifier', () => {
    const file = sourceFixture("import { clock } from './clock';\n");

    expect(canSkipAst(readFileSync(file, 'utf8'))).toBe(true);
    expect(collectViolations(file, srcRoot)).toEqual([]);
  });

  it('reports an escaped parent segment in a static import', () => {
    const file = sourceFixture(
      "import { AppError } from '\\x2e\\x2e/\\x2e\\x2e/common/errors/app-error';\n",
    );

    expect(canSkipAst(readFileSync(file, 'utf8'))).toBe(false);
    expect(collectViolations(file, srcRoot)).toEqual([
      {
        file,
        line: 1,
        specifier: '../../common/errors/app-error',
      },
    ]);
  });

  it.each([
    'unicode',
    'line continuation',
    'dynamic import',
    'Windows separator',
  ] as const)('reports an escaped parent segment via %s', (variant) => {
    const contents = {
      unicode:
        "import { AppError } from '\\u{2e}\\u{2e}/\\u{2e}\\u{2e}/common/errors/app-error';\n",
      'line continuation':
        "import { AppError } from '.\\\n./../common/errors/app-error';\n",
      'dynamic import':
        "const { AppError } = await import('\\x2e\\x2e/\\x2e\\x2e/common/errors/app-error');\n",
      'Windows separator':
        "import { AppError } from '\\x2e\\x2e\\x5c\\x2e\\x2e\\x5ccommon\\x5cerrors\\x5capp-error';\n",
    } as const;
    const file = sourceFixture(contents[variant]);

    expect(canSkipAst(readFileSync(file, 'utf8'))).toBe(false);
    expect(collectViolations(file, srcRoot)).toEqual([
      {
        file,
        line: 1,
        specifier:
          variant === 'Windows separator'
            ? '..\\..\\common\\errors\\app-error'
            : '../../common/errors/app-error',
      },
    ]);
  });
});

describe('emitted output', () => {
  it('reports an alias specifier that survived into dist', () => {
    const file = fixture(
      'dist/common/errors/app-error.js',
      'class AppError {}\nmodule.exports = { AppError };\n',
    );
    const leaky = fixture(
      'dist/main.js',
      'const { AppError } = require("@/common/errors/app-error");\n',
    );

    expect(collectDistViolations(join(root, 'dist'))).toEqual([
      { file: leaky, line: 1, specifier: '@/common/errors/app-error' },
    ]);
    expect(collectDistViolations(join(root, 'dist'))).not.toContainEqual(
      expect.objectContaining({ file }),
    );
  });

  it('accepts output that rewrote the alias to a relative path', () => {
    fixture(
      'dist/main.js',
      'const { AppError } = require("./common/errors/app-error");\n',
    );

    expect(collectDistViolations(join(root, 'dist'))).toEqual([]);
  });
});
