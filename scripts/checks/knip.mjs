// Cross-platform knip launcher: oxc-parser's raw-transfer path wants a ~6 GiB
// ArrayBuffer, which fails to allocate on typical Windows dev boxes and is
// near the ceiling on GitHub runners. Knip honors KNIP_DISABLE_RAW_TRANSFER=1;
// package scripts cannot set env vars in both cmd and sh without a dependency,
// so the env lives here and `pnpm knip` stays one word on every OS.
process.env.KNIP_DISABLE_RAW_TRANSFER = '1';

const { spawnSync } = await import('node:child_process');
const { existsSync } = await import('node:fs');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const knipPackageRoot = dirname(
  dirname(fileURLToPath(import.meta.resolve('knip'))),
);
const bin = join(knipPackageRoot, 'bin', 'knip.js');
if (!existsSync(bin)) {
  console.error(`knip launcher: expected binary is missing: ${bin}`);
  process.exit(1);
}
const result = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
