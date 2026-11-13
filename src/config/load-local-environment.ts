import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import { RuntimeConfigurationError } from './runtime-configuration';

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
  mode: string | undefined = process.env['NODE_ENV'],
  directory: string = process.cwd(),
): void {
  const envFile = join(directory, '.env');
  if (!existsSync(envFile)) {
    return;
  }
  if (mode !== undefined && DEPLOYED_MODES.has(mode)) {
    console.error(
      JSON.stringify({
        time: Date.now(),
        level: 'error',
        event: 'local_env_file_refused',
        mode,
        env_file: envFile,
      }),
    );
    return;
  }
  let raw: Buffer;
  try {
    raw = readFileSync(envFile);
  } catch {
    throw new RuntimeConfigurationError(['.env']);
  }
  const text = raw.toString('utf8');
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!line.includes('=')) {
      throw new RuntimeConfigurationError(['.env']);
    }
  }
  const values = parseEnv(text);
  for (const [name, value] of Object.entries(values)) {
    process.env[name] ??= value;
  }
}
