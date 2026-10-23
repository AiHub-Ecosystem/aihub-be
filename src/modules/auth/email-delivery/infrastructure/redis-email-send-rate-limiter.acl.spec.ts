import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EMAIL_PROVIDER_OUTAGE_STATE_KEY,
  EMAIL_SEND_RATE_RESERVATION_KEY,
} from './redis-email-send-rate-limiter';

// What ioredis itself sends on connect, besides the limiter's own scripts.
const CONNECTION_COMMANDS = ['select', 'client|setinfo', 'info', 'eval'];

function aclGrant(): { keys: string[]; commands: string[] } {
  const readme = readFileSync(
    join(__dirname, '../../../../../ops/vault/README.md'),
    'utf8',
  );
  const line = readme
    .split('\n')
    .find((candidate) =>
      candidate.startsWith('ACL SETUSER aihub_email_limiter'),
    );
  if (line === undefined) throw new Error('README has no ACL SETUSER line');
  const tokens = line.split(' ');
  return {
    keys: tokens.filter((t) => t.startsWith('~')).map((t) => t.slice(1)),
    commands: tokens
      .filter((t) => t.startsWith('+'))
      .map((t) => t.slice(1).replace(/^select\|.*$/, 'select')),
  };
}

function scriptCommands(): string[] {
  const source = readFileSync(
    join(__dirname, 'redis-email-send-rate-limiter.ts'),
    'utf8',
  );
  return [
    ...new Set(
      [...source.matchAll(/redis\.call\('([A-Za-z]+)'/g)].map((m) =>
        (m[1] ?? '').toLowerCase(),
      ),
    ),
  ];
}

// The Redis ACL is provisioned by hand from this README. A script that reads a
// new key or runs a new command is refused with NOPERM, the limiter then answers
// unavailable, and no email is sent (found in Production on 2026-10-23).
describe('email send-rate Redis ACL documented in ops/vault/README.md', () => {
  it('grants exactly the keys the limiter reads and writes', () => {
    expect([...aclGrant().keys].sort()).toEqual(
      [EMAIL_SEND_RATE_RESERVATION_KEY, EMAIL_PROVIDER_OUTAGE_STATE_KEY].sort(),
    );
  });

  it('grants every command the limiter scripts and the connection run, and no other', () => {
    const expected = [...scriptCommands(), ...CONNECTION_COMMANDS].sort();

    expect([...aclGrant().commands].sort()).toEqual(expected);
  });
});
