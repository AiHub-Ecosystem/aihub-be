import { createHash, randomBytes } from 'node:crypto';

import { monotonicFactory } from 'ulid';

import type {
  IssuedOrganizationInviteToken,
  OrganizationInviteTokenPort,
} from '../application/organization-invite-token.port';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Same-millisecond `oiv_` order follows mint order within this process only. */
const nextOrganizationInviteTokenId = monotonicFactory();

export class CryptoOrganizationInviteToken
  implements OrganizationInviteTokenPort
{
  issue(now: Date): IssuedOrganizationInviteToken {
    const raw = randomBytes(32).toString('base64url');
    return {
      id: `oiv_${nextOrganizationInviteTokenId(now.getTime())}`,
      raw,
      hash: this.hash(raw),
      expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
    };
  }

  hash(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }
}
