/**
 * Cleans `dist/` before `nest build` but keeps the generated Prisma client
 * (#1619).
 *
 * `build` used to delete the whole of `dist/`, so a `verify` that had already
 * generated the client at its first gate generated it again after `build`.
 * `generate-prisma-client.mjs` decides from its stamp whether the kept client
 * is still valid, so keeping it cannot serve a stale one: a changed schema or
 * Prisma version still regenerates, and a Docker build, which starts without
 * `dist/`, still generates from scratch.
 */
const { existsSync, readdirSync, rmSync } = require('node:fs');
const path = require('node:path');

const KEPT = new Set([
  path.join('generated', 'prisma'),
  path.join('generated', 'kysely'),
]);

/** @param {string} distDirectory */
function cleanDist(distDirectory) {
  if (!existsSync(distDirectory)) return;
  for (const entry of readdirSync(distDirectory)) {
    if (entry !== 'generated') {
      rmSync(path.join(distDirectory, entry), { force: true, recursive: true });
    }
  }
  const generated = path.join(distDirectory, 'generated');
  if (!existsSync(generated)) return;
  for (const entry of readdirSync(generated)) {
    if (!KEPT.has(path.join('generated', entry))) {
      rmSync(path.join(generated, entry), { force: true, recursive: true });
    }
  }
}

module.exports = { cleanDist };

if (require.main === module) {
  cleanDist(process.argv[2] ?? 'dist');
}
