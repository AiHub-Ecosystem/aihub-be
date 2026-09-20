import { existsSync } from 'node:fs';
import process from 'node:process';

const runtimeConnectionModule = new URL(
  '../dist/modules/secrets/infrastructure/runtime-connection.environment.js',
  import.meta.url,
);

async function main() {
  if (!existsSync(runtimeConnectionModule)) {
    throw new Error('runtime connection loader is unavailable');
  }

  const runtimeConnection = await import(runtimeConnectionModule);
  const loadRuntimeConnectionEnvironment =
    runtimeConnection.loadRuntimeConnectionEnvironment ??
    runtimeConnection.default?.loadRuntimeConnectionEnvironment;
  if (typeof loadRuntimeConnectionEnvironment !== 'function') {
    throw new Error('runtime connection loader is unavailable');
  }
  loadRuntimeConnectionEnvironment();

  const target = process.argv[2] ?? 'dist/main.js';
  const targetUrl = new URL(
    target.startsWith('dist/') || target.startsWith('scripts/')
      ? `../${target}`
      : target,
    import.meta.url,
  );
  await import(targetUrl);
}

main().catch(() => {
  console.error('runtime configuration failed');
  process.exitCode = 1;
});
