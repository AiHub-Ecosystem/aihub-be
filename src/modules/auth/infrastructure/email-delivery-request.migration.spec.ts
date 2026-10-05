import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('email delivery request migration', () => {
  it('keeps payload ciphertext erasable and evidence free of PII', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../../database/migrations/0027_email_delivery_requests.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('CREATE TABLE email_delivery_requests');
    expect(sql).toContain("id ~ '^edr_[0-9A-HJKMNP-TV-Z]{26}$'");
    expect(sql).toContain(
      "status IN ('queued', 'provider_accepted', 'failed', 'cancelled')",
    );
    expect(sql).toContain('payload_ciphertext');
    expect(sql).toContain('attempts');
    expect(sql).toContain('last_attempt_at');
    expect(sql).toContain('last_error_code');
    expect(sql).not.toMatch(/to_address|recipient|token_|subject|body/i);
  });
});
