import {
  databaseTemplateAction,
  databaseTemplateDescription,
  migrationFingerprint,
} from './database-template';

describe('database lane migration template', () => {
  const addName = {
    name: '0002_add_name',
    sql: 'ALTER TABLE users ADD name text;',
  };
  const createUsers = {
    name: '0001_create_users',
    sql: 'CREATE TABLE users (id text);',
  };
  const migrations = [addName, createUsers];

  it('fingerprints migration names and SQL independent of directory listing order', () => {
    expect(migrationFingerprint(migrations)).toBe(
      migrationFingerprint([...migrations].reverse()),
    );
    expect(
      migrationFingerprint([
        ...migrations,
        { name: '0003_add_email', sql: 'ALTER TABLE users ADD email text;' },
      ]),
    ).not.toBe(migrationFingerprint(migrations));
    expect(
      migrationFingerprint([
        addName,
        { ...createUsers, sql: 'CREATE TABLE users (id uuid);' },
      ]),
    ).not.toBe(migrationFingerprint(migrations));
  });

  it('reuses only a ready template with the current migration fingerprint', () => {
    const fingerprint = migrationFingerprint(migrations);
    expect(
      databaseTemplateAction(
        databaseTemplateDescription(fingerprint, 'ready'),
        fingerprint,
      ),
    ).toBe('reuse');
    expect(
      databaseTemplateAction(
        databaseTemplateDescription(fingerprint, 'building'),
        fingerprint,
      ),
    ).toBe('rebuild');
  });

  it('rebuilds stale owned templates and refuses an unowned database name', () => {
    const fingerprint = migrationFingerprint(migrations);
    expect(
      databaseTemplateAction(
        databaseTemplateDescription('a'.repeat(64), 'ready'),
        fingerprint,
      ),
    ).toBe('rebuild');
    expect(databaseTemplateAction(null, fingerprint)).toBe('unowned');
    expect(databaseTemplateAction('another-app-template', fingerprint)).toBe(
      'unowned',
    );
  });
});
