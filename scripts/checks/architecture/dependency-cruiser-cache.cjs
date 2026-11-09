const { createHash } = require('node:crypto');
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

/** @param {string} root @param {readonly string[]} inputs @returns {string} */
function dependencyCruiserCacheDirectory(root, inputs) {
  const hash = createHash('sha256');
  for (const input of inputs) hash.update(input).update('\0');
  return path.join(
    root,
    'node_modules',
    '.cache',
    'dependency-cruiser',
    hash.digest('hex'),
  );
}

/**
 * Where the generated Prisma client lands, relative to the repository root.
 * `tsconfig.json` maps `@prisma-client/*` here, so dependency-cruiser can only
 * resolve those 39 imports once this directory holds a generated client.
 */
const GENERATED_PRISMA_DIRECTORY = path.join('dist', 'generated', 'prisma');

/**
 * A fingerprint of the generated Prisma client, for the dependency-cruiser
 * cache key (#1438).
 *
 * Without it, a run made before the client is generated caches "unresolvable
 * `@prisma-client/client`" for every importer, and that stale answer outlives
 * the generation that fixes it: dependency-cruiser writes its result under
 * `--cache-strategy content`, and the content of the importing files did not
 * change. The fingerprint makes "client missing" and "client present" two
 * different keys, so the stale result can never be read back.
 *
 * The fingerprint hashes the generated `.ts` surfaces, not every file: the
 * `.js` siblings and `.stamp` are rewritten by each generation without
 * changing what dependency-cruiser resolves, and hashing 3.5 MB of them on
 * every run would cost more than the cache saves.
 *
 * @param {string} root
 * @returns {string} `absent` when there is no generated client, else a hex digest
 */
function generatedPrismaClientFingerprint(root) {
  let directory;
  try {
    directory = path.join(root, GENERATED_PRISMA_DIRECTORY);
    if (!existsSync(directory)) return 'absent';
    const files = collectTypeScriptFiles(directory);
    if (files.length === 0) return 'absent';
    const hash = createHash('sha256');
    for (const file of files) {
      hash.update(path.relative(directory, file)).update('\0');
      hash.update(readFileSync(file)).update('\0');
    }
    return hash.digest('hex');
  } catch {
    // A half-written client is not a cacheable state; a distinct marker keeps
    // the next complete generation from reusing whatever this run cached.
    return 'unreadable';
  }
}

/**
 * @param {string} directory
 * @returns {string[]} every `.ts` file below `directory`, as absolute paths
 */
function collectTypeScriptFiles(directory) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path.join(entry.parentPath, entry.name));
    }
  }
  // A stable order keeps the digest identical across platforms and directory
  // enumeration orders, so an unchanged tree still hits the cache.
  return files.sort();
}

module.exports = {
  dependencyCruiserCacheDirectory,
  generatedPrismaClientFingerprint,
};
