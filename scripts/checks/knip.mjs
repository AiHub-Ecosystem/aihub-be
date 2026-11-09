// Cross-platform knip launcher: oxc-parser's raw-transfer path wants a ~6 GiB
// ArrayBuffer, which fails to allocate on typical Windows dev boxes and is
// near the ceiling on GitHub runners. Knip honors KNIP_DISABLE_RAW_TRANSFER=1;
// package scripts cannot set env vars in both cmd and sh without a dependency,
// so the env lives here and `bun run knip` stays one word on every OS.
//
// Outside CI the run also passes `--cache`, so repeated local runs skip
// re-analyzing unchanged files (see knip-cache-args.cjs for the CI tradeoff).
process.env.KNIP_DISABLE_RAW_TRANSFER = '1';

const { spawnSync } = await import('node:child_process');
const { existsSync } = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath, pathToFileURL } = await import('node:url');
import cacheArgs from './knip-cache-args.cjs';

export function knipArguments(env = process.env) {
  return [...cacheArgs.knipCacheArgs(env)];
}

async function main() {
  const knipPackageRoot = path.dirname(
    path.dirname(fileURLToPath(import.meta.resolve('knip'))),
  );
  const bin = path.join(knipPackageRoot, 'bin', 'knip.js');
  if (!existsSync(bin)) {
    console.error(`knip launcher: expected binary is missing: ${bin}`);
    process.exit(1);
  }
  const result = spawnSync(
    process.execPath,
    [bin, ...knipArguments(), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
