import { type Static, Type } from '@sinclair/typebox';

export const OrganizationIdSchema = Type.String({
  pattern: '^org_[A-Za-z0-9][A-Za-z0-9_-]*$',
  description:
    'Case-sensitive Organization ID prefixed with org_; its suffix starts with an ASCII letter or digit and may contain ASCII letters, digits, underscores, and hyphens.',
});

export type OrganizationId = Static<typeof OrganizationIdSchema>;
