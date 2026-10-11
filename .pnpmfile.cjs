// `@prisma/client` declares `prisma` (the CLI) as an optional peer. The CLI is a
// devDependency of this repository, so pnpm resolves that peer to it and records
// it under the client's `optionalDependencies`, which `pnpm prune --prod` keeps.
// That would ship the CLI and its transitive tree in the runtime image (ADR-0088).
// The generated client is Rust-free and written outside `node_modules`, so the
// runtime never calls the CLI; dropping the peer keeps it dev-only.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === '@prisma/client') {
        if (pkg.peerDependencies) {
          delete pkg.peerDependencies.prisma;
        }
        if (pkg.peerDependenciesMeta) {
          delete pkg.peerDependenciesMeta.prisma;
        }
      }
      return pkg;
    },
  },
};
