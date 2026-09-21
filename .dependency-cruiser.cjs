module.exports = {
  // no-orphans is intentionally omitted; orphan/liveness analysis belongs to
  // dedicated tooling and may overlap with Knip.
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular imports can evaluate modules in an order that leaves dependencies undefined at runtime.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment:
        'Unresolvable imports make the composition graph incomplete and fail outside narrow unit-test paths.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'domain-no-outer-layers',
      severity: 'error',
      comment:
        'Domain code must not depend on application, infrastructure, or presentation.',
      from: { path: '^src/.*/domain/' },
      to: { path: '^src/.*/(application|infrastructure|presentation)/' },
    },
    {
      name: 'domain-no-framework-or-io',
      severity: 'error',
      comment: 'Domain code is framework-free and side-effect-free.',
      from: { path: '^src/.*/domain/' },
      to: { path: 'node_modules' },
    },
    {
      name: 'application-no-outer-layers',
      severity: 'error',
      comment:
        'Application code depends on domain and ports, not concrete outer layers.',
      from: { path: '^src/.*/application/' },
      to: { path: '^src/.*/(infrastructure|presentation)/' },
    },
    {
      name: 'presentation-no-infrastructure',
      severity: 'error',
      comment:
        'Controllers and presentation code call application ports, not adapters.',
      from: { path: '^src/.*[.]controller[.]ts$|^src/.*/presentation/' },
      to: { path: '^src/.*/infrastructure/|^src/downstream/' },
    },
    {
      name: 'module-code-no-infrastructure-import',
      severity: 'error',
      comment:
        'Concrete infrastructure is bound only by module composition roots.',
      from: {
        path: '^src/modules/[^/]+/(?!infrastructure/)(?!.*[.]spec[.]ts$)(?![^/]+[.]module[.]ts$)',
      },
      to: { path: '^src/modules/[^/]+/infrastructure/' },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    doNotFollow: {
      path: 'node_modules',
    },
    exclude: {
      path: '(^|/)(dist|coverage)(/|$)',
    },
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
  },
};
