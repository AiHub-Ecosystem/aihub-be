import { createHash, randomBytes } from 'node:crypto';

import { ulid } from 'ulid';

import type {
  IssuedOrganizationInviteToken,
  OrganizationInviteTokenPort,
} from '../application/organization-invite-token.port';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export class CryptoOrganizationInviteToken
  implements OrganizationInviteTokenPort
{
  issue(now: Date): IssuedOrganizationInviteToken {
    const raw = randomBytes(32).toString('base64url');
    return {
      id: `oiv_${ulid(now.getTime())}`,
      raw,
      hash: this.hash(raw),
      expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
    };
  }

  hash(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }
}
