import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

// Deployed images declare these modes explicitly (Dockerfile and the
// production compose set NODE_ENV). A .env reaching such a process would
// silently fill the unset variables the fail-closed contracts rely on — a
// missing avatar bucket must answer AVATAR_STORAGE_UNAVAILABLE, a missing
// secret must refuse boot — so the file is refused loudly instead of consumed.
const DEPLOYED_MODES = new Set(['production', 'staging']);

/**
 * Loads the working directory's `.env` for a local run, or refuses it loudly
 * in a deployed mode. A mode left unset keeps the historical local-run
 * behavior: the file loads, and it may itself declare `NODE_ENV=development`.
 */
export function loadLocalEnvironment(
  mode: string | undefined = process.env.NODE_ENV,
  directory: string = process.cwd(),
): void {
  const envFile = join(directory, '.env');
  if (!existsSync(envFile)) {
    return;
  }
  if (mode !== undefined && DEPLOYED_MODES.has(mode)) {
    console.error(
      `Refusing to load ${envFile} in ${mode} mode: a deployed process must take its configuration from the deployment, not a stray .env file.`,
    );
    return;
  }
  loadEnvFile(envFile);
}

// This entrypoint import runs before telemetry and application modules read
// their environment.
loadLocalEnvironment();
