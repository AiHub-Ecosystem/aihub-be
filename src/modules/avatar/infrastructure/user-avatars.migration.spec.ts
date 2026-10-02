import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('user avatars migration', () => {
  it('keeps one Avatar per account whose key names its owner', () => {
    const sql = readFileSync(
      join(__dirname, '../../../../database/migrations/0024_user_avatars.sql'),
      'utf8',
    );

    expect(sql).toContain('CREATE TABLE user_avatars');
    expect(sql).toContain("id ~ '^ava_[0-9A-HJKMNP-TV-Z]{26}$'");
    expect(sql).toContain('REFERENCES user_accounts(id) ON DELETE RESTRICT');
    expect(sql).toContain('UNIQUE (user_account_id)');
    expect(sql).toContain(
      "object_key = 'users/' || user_account_id || '/avatar/' || id || '/original'",
    );
    expect(sql).toContain('BETWEEN 1 AND 2097152');
    expect(sql).not.toContain('image/svg');
  });
});
