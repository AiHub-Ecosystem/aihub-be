import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import cacheHelpers from './dependency-cruiser-cache.cjs';

/**
 * A throwaway root holding a generated Prisma client. `files` is the map of
 * relative path to content; passing `undefined` leaves the directory absent.
 */
function rootWithGeneratedClient(files?: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'prisma-cache-fingerprint-'));
  if (files === undefined) return root;
  const directory = join(root, 'dist', 'generated', 'prisma');
  mkdirSync(directory, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    mkdirSync(join(directory, relativePath, '..'), { recursive: true });
    writeFileSync(join(directory, relativePath), content);
  }
  return root;
}

const GENERATED_CLIENT = {
  'client.ts': 'export type PrismaClient = object;\n',
  'models/User.ts': 'export type User = { id: string };\n',
};

describe('generated Prisma client fingerprint', () => {
  it('separates a missing client from a present one', () => {
    const absent = rootWithGeneratedClient(undefined);
    const present = rootWithGeneratedClient(GENERATED_CLIENT);
    try {
      expect(cacheHelpers.generatedPrismaClientFingerprint(absent)).toBe(
        'absent',
      );
      expect(cacheHelpers.generatedPrismaClientFingerprint(present)).not.toBe(
        'absent',
      );
    } finally {
      rmSync(absent, { recursive: true, force: true });
      rmSync(present, { recursive: true, force: true });
    }
  });

  it('reports a present but empty directory as absent', () => {
    const root = rootWithGeneratedClient({});
    try {
      expect(cacheHelpers.generatedPrismaClientFingerprint(root)).toBe(
        'absent',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('changes when the generated client content changes', () => {
    const before = rootWithGeneratedClient(GENERATED_CLIENT);
    const after = rootWithGeneratedClient({
      ...GENERATED_CLIENT,
      'models/User.ts': 'export type User = { id: string; email: string };\n',
    });
    try {
      expect(cacheHelpers.generatedPrismaClientFingerprint(before)).not.toBe(
        cacheHelpers.generatedPrismaClientFingerprint(after),
      );
    } finally {
      rmSync(before, { recursive: true, force: true });
      rmSync(after, { recursive: true, force: true });
    }
  });

  it('is identical across two trees with the same content', () => {
    const first = rootWithGeneratedClient(GENERATED_CLIENT);
    const second = rootWithGeneratedClient(GENERATED_CLIENT);
    try {
      expect(cacheHelpers.generatedPrismaClientFingerprint(first)).toBe(
        cacheHelpers.generatedPrismaClientFingerprint(second),
      );
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('ignores files that do not affect resolution', () => {
    // A generation rewrites `.stamp` and the `.js` siblings every time; only
    // the `.ts` surfaces decide what dependency-cruiser can resolve.
    const plain = rootWithGeneratedClient(GENERATED_CLIENT);
    const restamped = rootWithGeneratedClient({
      ...GENERATED_CLIENT,
      '.stamp': 'newhash runtime\n',
      'client.js': 'module.exports = {};\n',
    });
    try {
      expect(cacheHelpers.generatedPrismaClientFingerprint(plain)).toBe(
        cacheHelpers.generatedPrismaClientFingerprint(restamped),
      );
    } finally {
      rmSync(plain, { recursive: true, force: true });
      rmSync(restamped, { recursive: true, force: true });
    }
  });

  it('gives a missing client and a generated one different cache directories', () => {
    const absent = rootWithGeneratedClient(undefined);
    const present = rootWithGeneratedClient(GENERATED_CLIENT);
    const inputs = ['policy', 'tsconfig', 'package', 'lockfile'];
    try {
      const absentKey = cacheHelpers.dependencyCruiserCacheDirectory(absent, [
        ...inputs,
        cacheHelpers.generatedPrismaClientFingerprint(absent),
      ]);
      const presentKey = cacheHelpers.dependencyCruiserCacheDirectory(present, [
        ...inputs,
        cacheHelpers.generatedPrismaClientFingerprint(present),
      ]);
      expect(absentKey).not.toBe(presentKey);
    } finally {
      rmSync(absent, { recursive: true, force: true });
      rmSync(present, { recursive: true, force: true });
    }
  });
});
