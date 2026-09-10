import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

/**
 * One-shot demo setup: creates an organization, registers the demo signing
 * key, issues an API key, and appends both credentials to `.env` so
 * `pnpm dev:assertion` and a curl call work immediately afterwards.
 *
 *   pnpm demo:bootstrap "Acme Edu"
 *
 * Wraps `scripts/cli.mjs` rather than talking to Postgres itself, so the
 * onboarding logic stays in one place. Needs DATABASE_URL reachable.
 */

const ENV_FILE = '.env';
const JWKS_FILE = 'demo-jwks.json';
const SCOPES = 'writing.question.generate,writing.grade';
const ENTITLEMENTS = 'writing';

if (existsSync(ENV_FILE)) {
  loadEnvFile(ENV_FILE);
}

const name = process.argv[2] ?? 'Demo Org';
const issuer = process.env.DEMO_ASSERTION_ISSUER ?? 'https://demo.acme.edu';
const environment = process.env.DEMO_ENVIRONMENT ?? 'development';

function run(args) {
  try {
    // stdout captured, stderr inherited so the CLI's own errors stay visible.
    return execFileSync('node', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
  } catch {
    // The child already printed why. A Node stack trace on top of that only
    // buries it, and the usual cause is simply that Postgres is not running.
    console.error(
      `\n${args[0]} failed. Is PostgreSQL up and DATABASE_URL set? Try: docker compose up -d && pnpm migrate`,
    );
    process.exit(1);
  }
}

function cli(...args) {
  return run(['scripts/cli.mjs', ...args]);
}

if (
  existsSync(ENV_FILE) &&
  readFileSync(ENV_FILE, 'utf8').includes('DEMO_API_KEY=')
) {
  // Re-running would orphan the previous org and leave two keys in the
  // database with only one of them recorded anywhere.
  console.error(
    `${ENV_FILE} already has DEMO_API_KEY. Remove that line (and DEMO_ORG_ID) first if you want a fresh demo organization.`,
  );
  process.exit(2);
}

// Signs once to force the key pair and JWKS to exist before identity:set.
const assertion = run(['scripts/dev-sign-assertion.mjs']);

const organizationId = cli(
  'org:create',
  '--name',
  name,
  '--entitlements',
  ENTITLEMENTS,
);

cli(
  'identity:set',
  '--org',
  organizationId,
  '--issuer',
  issuer,
  '--public-keys-file',
  `./${JWKS_FILE}`,
);

const apiKey = cli(
  'key:create',
  '--org',
  organizationId,
  '--name',
  `${name} demo`,
  '--scopes',
  SCOPES,
  '--envs',
  environment,
);

appendFileSync(
  ENV_FILE,
  `\n# Written by scripts/demo-bootstrap.mjs on ${new Date().toISOString()}\nDEMO_ORG_ID=${organizationId}\nDEMO_API_KEY=${apiKey}\n`,
);

console.error(
  `\nOrganization ${organizationId} ready. Credentials appended to ${ENV_FILE}.`,
);
console.error(`X-API-Key:        ${apiKey}`);
console.error(`X-User-Assertion: ${assertion}`);
console.error('\nNew assertions later: pnpm dev:assertion');
