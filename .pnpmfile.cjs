// `@prisma/client` declares `prisma` (the CLI) as an optional peer. The CLI is a
// devDependency of this repository, so pnpm resolves that peer to it and records
// it under the client's `optionalDependencies`, which `pnpm prune --prod` keeps.
// That would ship the CLI and its transitive tree in the runtime image (ADR-0088).
// The generated client is Rust-free and written outside `node_modules`, so the
// runtime never calls the CLI; dropping the peer keeps it dev-only.

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

module.exports = {
  hooks: {
    /** @param {unknown} pkg @returns {unknown} */
    readPackage(pkg) {
      if (isRecord(pkg) && pkg.name === '@prisma/client') {
        const peerDependencies = pkg.peerDependencies;
        if (isRecord(peerDependencies)) {
          Reflect.deleteProperty(peerDependencies, 'prisma');
        }
        const peerDependenciesMeta = pkg.peerDependenciesMeta;
        if (isRecord(peerDependenciesMeta)) {
          Reflect.deleteProperty(peerDependenciesMeta, 'prisma');
        }
      }
      return pkg;
    },
  },
};
