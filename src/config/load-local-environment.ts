import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

// This entrypoint import runs before telemetry and application modules read
// their environment.
if (existsSync('.env')) {
  loadEnvFile('.env');
}
