import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';

import {
  SignJWT,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
} from 'jose';

/**
 * Stands in for a customer's backend during a demo: it holds the private key
 * and mints the short-lived assertion that a real organization would sign for
 * one of its end users. AIHUB never runs this — the whole point of the
 * asymmetric design is that the gateway cannot sign these itself.
 *
 *   pnpm dev:assertion              # prints one token for DEMO_USER_ID
 *   pnpm dev:assertion student_789  # or override the user id inline
 *
 * The first run also writes the key pair and prints the identity:set command
 * that registers its public half.
 */

const ALGORITHM = 'RS256';
const KEY_ID = 'demo-2026-01';
const PRIVATE_KEY_FILE = 'demo-private.pem';
const JWKS_FILE = 'demo-jwks.json';
const TTL_SECONDS = 300;

if (existsSync('.env')) {
  loadEnvFile('.env');
}

const issuer = process.env.DEMO_ASSERTION_ISSUER ?? 'https://demo.acme.edu';
const userId = process.argv[2] ?? process.env.DEMO_USER_ID;

if (userId === undefined || userId.trim().length === 0) {
  console.error(
    'No user id. Set DEMO_USER_ID in .env, or pass one: pnpm dev:assertion student_456',
  );
  process.exit(2);
}

async function loadOrCreatePrivateKey() {
  if (existsSync(PRIVATE_KEY_FILE)) {
    return importPKCS8(await readFile(PRIVATE_KEY_FILE, 'utf8'), ALGORITHM);
  }

  const { publicKey, privateKey } = await generateKeyPair(ALGORITHM, {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);

  await writeFile(
    JWKS_FILE,
    `${JSON.stringify({ keys: [{ ...jwk, kid: KEY_ID, alg: ALGORITHM, use: 'sig' }] }, null, 2)}\n`,
  );
  await writeFile(PRIVATE_KEY_FILE, await exportPKCS8(privateKey));

  // Until this runs, every token below verifies against a key AIHUB has
  // never seen, and the request fails with INVALID_USER_ASSERTION.
  console.error(
    `Created ${PRIVATE_KEY_FILE} and ${JWKS_FILE}. Register it once:`,
  );
  console.error(
    `  pnpm cli identity:set --org org_... --issuer ${issuer} --public-keys-file ./${JWKS_FILE}\n`,
  );

  return privateKey;
}

const assertion = await new SignJWT({})
  .setProtectedHeader({ alg: ALGORITHM, kid: KEY_ID })
  .setIssuer(issuer)
  .setAudience('aihub')
  .setSubject(userId)
  .setJti(randomUUID())
  .setIssuedAt()
  .setExpirationTime(`${TTL_SECONDS}s`)
  .sign(await loadOrCreatePrivateKey());

// Token on stdout so `$(pnpm dev:assertion)` captures it cleanly; every
// other line goes to stderr.
console.error(`${userId} · valid ${TTL_SECONDS}s · issuer ${issuer}`);
console.log(assertion);
