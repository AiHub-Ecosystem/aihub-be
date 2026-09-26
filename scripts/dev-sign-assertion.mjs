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

if (existsSync('.env')) {
  loadEnvFile('.env');
}

// Defaults reproduce the local demo stack. Override them to sign with a key
// registered for another organization -- the key id must match a `kid` in that
// organization's registered JWKS, or the gateway rejects every token with
// INVALID_USER_IDENTITY.
const ALGORITHM = process.env.ASSERTION_ALG ?? 'RS256';
const KEY_ID = process.env.ASSERTION_KID ?? 'demo-2026-01';
const PRIVATE_KEY_FILE =
  process.env.ASSERTION_PRIVATE_KEY_FILE ?? 'demo-private.pem';
const JWKS_FILE = process.env.ASSERTION_JWKS_FILE ?? 'demo-jwks.json';
const TTL_SECONDS = Number(process.env.ASSERTION_TTL_SECONDS ?? 300);

if (ALGORITHM !== 'RS256' && ALGORITHM !== 'ES256') {
  console.error(`ASSERTION_ALG must be RS256 or ES256, got ${ALGORITHM}`);
  process.exit(2);
}

if (!Number.isSafeInteger(TTL_SECONDS) || TTL_SECONDS <= 0) {
  console.error(
    `ASSERTION_TTL_SECONDS must be a positive integer, got ${process.env.ASSERTION_TTL_SECONDS}`,
  );
  process.exit(2);
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
  // never seen, and the request fails with INVALID_USER_IDENTITY.
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
