import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../app.module';
import {
  EMAIL_SENDER,
  type EmailSenderPort,
  type OrganizationInviteEmailInput,
  type PasswordResetEmailInput,
  type VerificationEmailInput,
} from '../../auth/application/email-sender.port';
import {
  USER_ACCESS_TOKEN_ISSUER,
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenIssuerPort,
  type UserAccessTokenVerifierPort,
} from '../../auth/application/user-access-token.port';
import { USER_ACCOUNT_REPOSITORY } from '../../auth/application/user-account.port';
import { userAccountStatus } from '../../auth/testing/user-account-status.stub';
import {
  type AcceptOrganizationInvitationInput,
  ORGANIZATION_INVITATION,
  type OrganizationInvitationPort,
} from '../application/organization-invitation.port';

const USER_ID = 'usr_01J00000000000000000000000';
const REQUEST_ID = 'req_01J00000000000000000000000';
const ACCEPT_URL = '/v1/organizations/invitations/accept';
const RAW_TOKEN = 'a-raw-invite-token-value';

describe('Organization invitation acceptance HTTP flow', () => {
  let app: NestFastifyApplication;
  let invitations: jest.Mocked<OrganizationInvitationPort>;
  let tokenIssuer: jest.Mocked<UserAccessTokenIssuerPort>;

  beforeAll(async () => {
    invitations = {
      createInvitation: jest.fn(),
      listOpenInvitations: jest.fn(),
      acceptInvitation: jest.fn(
        async (_input: AcceptOrganizationInvitationInput) => ({
          kind: 'accepted' as const,
          organizationId: 'org_acme',
          role: 'member' as const,
        }),
      ),
      revokeInvitation: jest.fn(),
    };
    tokenIssuer = {
      issue: jest.fn(async (_userId: string) => ({
        token: 'reissued.token.value',
        expiresIn: 900,
      })),
    };
    const emailSender: EmailSenderPort = {
      sendVerificationEmail: async (_input: VerificationEmailInput) =>
        undefined,
      sendPasswordResetEmail: async (_input: PasswordResetEmailInput) =>
        undefined,
      sendOrganizationInviteEmail: async (
        _input: OrganizationInviteEmailInput,
      ) => undefined,
    };
    const verifier: UserAccessTokenVerifierPort = {
      verify: async (token: string) => {
        if (token !== 'valid.token.value') {
          throw new Error('invalid token');
        }
        return { userId: USER_ID, jti: 'jti_01' };
      },
    };
    const userAccounts = userAccountStatus();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ORGANIZATION_INVITATION)
      .useValue(invitations)
      .overrideProvider(EMAIL_SENDER)
      .useValue(emailSender)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(USER_ACCESS_TOKEN_ISSUER)
      .useValue(tokenIssuer)
      .overrideProvider(USER_ACCOUNT_REPOSITORY)
      .useValue(userAccounts)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => REQUEST_ID }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    invitations.acceptInvitation.mockResolvedValue({
      kind: 'accepted',
      organizationId: 'org_acme',
      role: 'member',
    });
  });

  function accept(
    payload: object = { token: RAW_TOKEN },
    headers: Record<string, string> = {
      authorization: 'Bearer valid.token.value',
    },
  ) {
    return app.inject({ method: 'POST', url: ACCEPT_URL, headers, payload });
  }

  function acceptCall(): AcceptOrganizationInvitationInput {
    const call = invitations.acceptInvitation.mock.calls[0];
    if (call === undefined) {
      throw new Error('acceptInvitation was not called');
    }
    return call[0];
  }

  it('returns the organization and role the invitation granted', async () => {
    const response = await accept();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { organization_id: 'org_acme', role: 'member', status: 'active' },
      meta: { request_id: REQUEST_ID },
    });
  });

  it('returns the role a reactivated membership received', async () => {
    invitations.acceptInvitation.mockResolvedValue({
      kind: 'accepted',
      organizationId: 'org_acme',
      role: 'admin',
    });

    const response = await accept();

    expect(response.statusCode).toBe(200);
    expect(response.json().data.role).toBe('admin');
  });

  it('redeems against the authenticated account and never a request-named organization', async () => {
    await accept();

    const call = acceptCall();
    expect(call.userId).toBe(USER_ID);
    expect(call.context.userId).toBe(USER_ID);
    expect(call.context.organizationId).toBeUndefined();
  });

  it('passes only the token hash to the durable boundary', async () => {
    await accept();

    const call = acceptCall();
    expect(call.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(call)).not.toContain(RAW_TOKEN);
  });

  it('rejects an unusable token with the generic token result', async () => {
    invitations.acceptInvitation.mockResolvedValue({ kind: 'token_invalid' });

    const response = await accept();

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe(
      'ORGANIZATION_INVITE_TOKEN_INVALID',
    );
  });

  it('gives every token rejection the identical public response', async () => {
    invitations.acceptInvitation.mockResolvedValue({ kind: 'token_invalid' });

    const first = await accept({ token: RAW_TOKEN });
    const second = await accept({ token: 'a-different-token-entirely' });

    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json().error.code).toBe(first.json().error.code);
    expect(second.json().error.message).toBe(first.json().error.message);
  });

  it('rejects acceptance into a suspended organization distinctly', async () => {
    invitations.acceptInvitation.mockResolvedValue({
      kind: 'organization_suspended',
    });

    const response = await accept();

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it.each([
    ['a missing Bearer credential', {}],
    ['an invalid Bearer credential', { authorization: 'Bearer nope' }],
    [
      'a malformed authorization header',
      { authorization: 'valid.token.value' },
    ],
  ])('rejects %s before any token work', async (_label, headers) => {
    const response = await accept({ token: RAW_TOKEN }, headers);

    expect(response.statusCode).toBe(401);
    expect(invitations.acceptInvitation).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing token field', {}],
    ['an empty token', { token: '' }],
    ['a non-string token', { token: 42 }],
    ['an unexpected field', { token: RAW_TOKEN, organization_id: 'org_acme' }],
  ])('rejects %s as an invalid request', async (_label, payload) => {
    const response = await accept(payload);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(invitations.acceptInvitation).not.toHaveBeenCalled();
  });

  it('keeps the raw token out of the response body and captured logs', async () => {
    const written: string[] = [];
    const stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    const stderr = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });

    let response: Awaited<ReturnType<typeof accept>>;
    try {
      response = await accept();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }

    expect(response.body).not.toContain(RAW_TOKEN);
    expect(written.join('')).not.toContain(RAW_TOKEN);
  });

  it('issues no session and mints no credential', async () => {
    const response = await accept();

    expect(response.statusCode).toBe(200);
    expect(tokenIssuer.issue).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).not.toContain('access_token');
  });

  it('keeps the invite route reachable for an organization named "invitations"', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/organizations/invitations/invitations',
      headers: { authorization: 'Bearer valid.token.value' },
      payload: { email: 'invitee@example.com', role: 'member' },
    });

    // The static acceptance path must not swallow an organization that happens
    // to be called "invitations".
    expect(response.statusCode).not.toBe(404);
  });

  it('returns the role an already-active membership kept, not the invited one', async () => {
    // The invitation said member; the durable membership was already an owner
    // and stays one. Accepting must report what the caller actually holds.
    invitations.acceptInvitation.mockResolvedValue({
      kind: 'accepted',
      organizationId: 'org_acme',
      role: 'owner',
    });

    const response = await accept();

    expect(response.statusCode).toBe(200);
    expect(response.json().data.role).toBe('owner');
  });

  it('accepts an oversized token as a token rejection, not a schema rejection', async () => {
    invitations.acceptInvitation.mockResolvedValue({ kind: 'token_invalid' });

    const response = await accept({ token: 'x'.repeat(4096) });

    // Any non-empty string is a candidate token, so a wrong one must reach the
    // single generic result rather than earning a second observable outcome.
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe(
      'ORGANIZATION_INVITE_TOKEN_INVALID',
    );
  });

  it.each([
    ['a JSON array body', [{ token: 'x' }]],
    ['a JSON string body', '"just-a-string"'],
    ['a JSON number body', '42'],
  ])('rejects %s as an invalid request', async (_label, payload) => {
    const response = await app.inject({
      method: 'POST',
      url: ACCEPT_URL,
      headers: {
        authorization: 'Bearer valid.token.value',
        'content-type': 'application/json',
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(invitations.acceptInvitation).not.toHaveBeenCalled();
  });
});
