import { Test } from '@nestjs/testing';

import { AppModule } from '@/app.module';
import {
  EMAIL_NOTICE_RESOLVERS,
  type EmailNoticeResolvers,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';

import { PostgresApiKeyNearExpiryNotices } from './postgres-api-key-near-expiry-notices';

describe('API key near-expiry notice wiring', () => {
  it('fills the slot Auth dispatches the notice through when the app is built', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const notices = moduleRef.get<EmailNoticeResolvers>(EMAIL_NOTICE_RESOLVERS);

    expect(notices.apiKeyNearExpiry).toBeInstanceOf(
      PostgresApiKeyNearExpiryNotices,
    );
    await moduleRef.close();
  });
});
