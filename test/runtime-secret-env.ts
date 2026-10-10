import { generateKeyPairSync } from 'node:crypto';

const { privateKey: userAccessPrivateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

process.env.NODE_ENV = 'test';
process.env.AIHUB_RUNTIME_SECRET_SOURCE = 'env';
process.env.DOWNSTREAM_AI_SPEAKING_CLIENT_ID = 'jest-speaking-client';
process.env.DOWNSTREAM_AI_SPEAKING_SECRET_KEY = 'jest-speaking-secret';
process.env.DOWNSTREAM_AI_WRITING_TOKEN = 'jest-writing-token';
process.env.RESEND_API_KEY = 'jest-resend-api-key';
process.env.AIHUB_USER_ACCESS_JWT_PRIVATE_KEY = userAccessPrivateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();
process.env.AIHUB_USER_ACCESS_JWT_KID = 'jest-user-access-2026';
process.env.AIHUB_WEB_SESSION_CLIENT_SECRET = 'jest-web-session-client-secret';
process.env.AIHUB_USER_ACCESS_ISSUER = 'https://api.test.aihub.example.com';
process.env.RESEND_FROM = 'AIHUB <no-reply@example.com>';
process.env.EMAIL_OUTBOX_CURRENT_KEY_ID = 'jest-email-outbox-2026';
process.env.EMAIL_OUTBOX_KEYS = JSON.stringify({
  'jest-email-outbox-2026': Buffer.alloc(32, 7).toString('base64'),
});
process.env.AIHUB_AUTH_MFA_CURRENT_KEY_ID = 'jest-auth-mfa-2026';
process.env.AIHUB_AUTH_MFA_KEYS = JSON.stringify({
  'jest-auth-mfa-2026': Buffer.alloc(32, 8).toString('base64'),
});
