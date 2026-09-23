import { createHash } from 'node:crypto';

import { ulid } from 'ulid';

/**
 * Pure migration planning for the #94 Clerk → AIHUB identity cutover
 * (ADR-0046). All decisions are computed here from immutable inputs; the
 * executor (added with the runbook) only applies a plan that is ready to flip,
 * and every ambiguous case lands in quarantine for operator disposition
 * (`link` / `create` / `skip`, keyed by Clerk user id) instead of being
 * auto-decided at the edge.
 */

export type MigrationRole = 'owner' | 'admin' | 'member';
export type MembershipStatus = 'active' | 'disabled';

export type Disposition =
  | { readonly kind: 'link'; readonly accountId: string }
  | { readonly kind: 'create' }
  | { readonly kind: 'skip' };

export interface MigrationPlanInput {
  readonly clerkUsers: readonly {
    readonly clerkUserId: string;
    readonly email: string | null;
    readonly membershipStatus: MembershipStatus;
  }[];
  readonly clerkInvitations: readonly {
    readonly email: string;
    readonly role: MigrationRole;
  }[];
  readonly existingAccounts: readonly {
    readonly accountId: string;
    readonly canonicalEmail: string;
    readonly status: 'pending_verification' | 'active' | 'disabled';
  }[];
  readonly existingMemberships: readonly {
    readonly accountId: string;
    readonly role: MigrationRole;
    readonly status: MembershipStatus;
  }[];
  readonly ownerEmails: readonly string[];
  readonly dispositions: Readonly<Record<string, Disposition>>;
}

interface MembershipPlan {
  readonly role: MigrationRole;
  readonly status: MembershipStatus;
}

export type QuarantineReason =
  | 'missing_email'
  | 'duplicate_clerk_email'
  | 'multiple_accounts'
  | 'account_not_active'
  | 'account_exists'
  | 'membership_mismatch'
  | 'owner_disabled';

export type UserDecision =
  | {
      readonly kind: 'create_account';
      readonly clerkUserId: string;
      readonly email: string;
      readonly membership: MembershipPlan;
    }
  | {
      readonly kind: 'link_account';
      readonly clerkUserId: string;
      readonly email: string;
      readonly accountId: string;
      readonly membership: MembershipPlan;
    }
  | {
      readonly kind: 'membership_noop';
      readonly clerkUserId: string;
      readonly email: string;
      readonly accountId: string;
    }
  | {
      readonly kind: 'skip';
      readonly clerkUserId: string;
      readonly email: string | null;
    }
  | {
      readonly kind: 'quarantine';
      readonly clerkUserId: string;
      readonly email: string | null;
      readonly reason: QuarantineReason;
    };

export interface MigrationPlan {
  readonly decisions: readonly UserDecision[];
  readonly invitesToReissue: readonly {
    readonly email: string;
    readonly role: MigrationRole;
  }[];
  readonly counts: {
    readonly clerkUsers: number;
    readonly created: number;
    readonly linked: number;
    readonly membershipNoops: number;
    readonly skipped: number;
    readonly quarantine: number;
    readonly invitesToReissue: number;
  };
  readonly readyToFlip: boolean;
}

/** Same normalization rule as the auth domain (NFC + trim + lowercase). */
function normalizeEmail(value: string): string {
  return value.normalize('NFC').trim().toLowerCase();
}

/**
 * Owner authority only sticks for an active membership: an owner designation
 * on a disabled Clerk member surfaces as `owner_disabled` for review, and any
 * explicit operator override still lands as an ordinary disabled member
 * rather than a silently disabled owner.
 */
function planMembership(
  email: string,
  membershipStatus: MembershipStatus,
  ownerEmails: ReadonlySet<string>,
): MembershipPlan {
  const status: MembershipStatus = membershipStatus;
  const role: MigrationRole =
    status === 'active' && ownerEmails.has(email) ? 'owner' : 'member';
  return { role, status };
}

export function planCustomerWebMigration(
  input: MigrationPlanInput,
): MigrationPlan {
  const ownerEmails = new Set(input.ownerEmails.map(normalizeEmail));
  const accountsByEmail = new Map<
    string,
    MigrationPlanInput['existingAccounts'][number][]
  >();
  for (const account of input.existingAccounts) {
    const key = normalizeEmail(account.canonicalEmail);
    const bucket = accountsByEmail.get(key);
    if (bucket === undefined) accountsByEmail.set(key, [account]);
    else bucket.push(account);
  }
  const membershipByAccount = new Map(
    input.existingMemberships.map((row) => [row.accountId, row] as const),
  );
  const emailFrequency = new Map<string, number>();
  for (const user of input.clerkUsers) {
    if (user.email === null) continue;
    const key = normalizeEmail(user.email);
    emailFrequency.set(key, (emailFrequency.get(key) ?? 0) + 1);
  }
  const clerkUserById = new Map(
    input.clerkUsers.map((user) => [user.clerkUserId, user] as const),
  );

  const resolve = (
    user: MigrationPlanInput['clerkUsers'][number],
    quarantine: QuarantineReason,
    email: string | null,
  ): UserDecision => {
    const disposition = input.dispositions[user.clerkUserId];
    if (disposition?.kind === 'skip') {
      return { kind: 'skip', clerkUserId: user.clerkUserId, email };
    }
    if (disposition?.kind === 'link') {
      if (email === null) {
        return {
          kind: 'quarantine',
          clerkUserId: user.clerkUserId,
          email,
          reason: quarantine,
        };
      }
      return {
        kind: 'link_account',
        clerkUserId: user.clerkUserId,
        email,
        accountId: disposition.accountId,
        membership: planMembership(email, user.membershipStatus, ownerEmails),
      };
    }
    if (disposition?.kind === 'create') {
      // A create disposition can never mint a duplicate account row: the
      // email either already has one or has no email to create from.
      if (email === null) {
        return {
          kind: 'quarantine',
          clerkUserId: user.clerkUserId,
          email,
          reason: quarantine,
        };
      }
      if ((accountsByEmail.get(email) ?? []).length > 0) {
        return {
          kind: 'quarantine',
          clerkUserId: user.clerkUserId,
          email,
          reason: 'account_exists',
        };
      }
      return {
        kind: 'create_account',
        clerkUserId: user.clerkUserId,
        email,
        membership: planMembership(email, user.membershipStatus, ownerEmails),
      };
    }
    return {
      kind: 'quarantine',
      clerkUserId: user.clerkUserId,
      email,
      reason: quarantine,
    };
  };

  const decide = (
    user: MigrationPlanInput['clerkUsers'][number],
  ): UserDecision => {
    const email = user.email === null ? null : normalizeEmail(user.email);

    if (email === null || email.length === 0) {
      return resolve(user, 'missing_email', null);
    }
    if ((emailFrequency.get(email) ?? 0) > 1) {
      return resolve(user, 'duplicate_clerk_email', email);
    }
    if (ownerEmails.has(email) && user.membershipStatus !== 'active') {
      return resolve(user, 'owner_disabled', email);
    }

    const matches = accountsByEmail.get(email) ?? [];
    if (matches.length > 1) {
      return resolve(user, 'multiple_accounts', email);
    }
    const membership = planMembership(
      email,
      user.membershipStatus,
      ownerEmails,
    );

    if (matches.length === 0) {
      return {
        kind: 'create_account',
        clerkUserId: user.clerkUserId,
        email,
        membership,
      };
    }

    const account =
      matches[0] as MigrationPlanInput['existingAccounts'][number];
    if (account.status !== 'active') {
      return resolve(user, 'account_not_active', email);
    }

    const row = membershipByAccount.get(account.accountId);
    if (row === undefined) {
      return {
        kind: 'link_account',
        clerkUserId: user.clerkUserId,
        email,
        accountId: account.accountId,
        membership,
      };
    }
    if (row.role === membership.role && row.status === membership.status) {
      return {
        kind: 'membership_noop',
        clerkUserId: user.clerkUserId,
        email,
        accountId: account.accountId,
      };
    }
    return resolve(user, 'membership_mismatch', email);
  };

  const decisions = input.clerkUsers.map(decide);

  // An invitation is reissued only when its email will NOT hold an active
  // membership after the flip (an active-member invite is a conflict, while a
  // disabled membership or an unknown email may re-enter through acceptance).
  // First occurrence wins per normalized email; input order is preserved so
  // the evidence output stays deterministic for one export.
  const excludedEmails = new Set<string>();
  for (const decision of decisions) {
    if (decision.email === null) continue;
    if (
      (decision.kind === 'create_account' ||
        decision.kind === 'link_account') &&
      decision.membership.status === 'active'
    ) {
      excludedEmails.add(decision.email);
    }
    if (decision.kind === 'membership_noop') {
      const clerkUser = clerkUserById.get(decision.clerkUserId);
      if (clerkUser?.membershipStatus === 'active') {
        excludedEmails.add(decision.email);
      }
    }
  }
  for (const account of input.existingAccounts) {
    const email = normalizeEmail(account.canonicalEmail);
    const row = membershipByAccount.get(account.accountId);
    if (row?.status === 'active') excludedEmails.add(email);
  }

  const seenInviteEmails = new Set<string>();
  const invitesToReissue: { email: string; role: MigrationRole }[] = [];
  for (const invitation of input.clerkInvitations) {
    const email = normalizeEmail(invitation.email);
    if (seenInviteEmails.has(email)) continue;
    seenInviteEmails.add(email);
    if (excludedEmails.has(email)) continue;
    invitesToReissue.push({ email, role: invitation.role });
  }

  const counts = {
    clerkUsers: input.clerkUsers.length,
    created: decisions.filter((d) => d.kind === 'create_account').length,
    linked: decisions.filter((d) => d.kind === 'link_account').length,
    membershipNoops: decisions.filter((d) => d.kind === 'membership_noop')
      .length,
    skipped: decisions.filter((d) => d.kind === 'skip').length,
    quarantine: decisions.filter((d) => d.kind === 'quarantine').length,
    invitesToReissue: invitesToReissue.length,
  };

  return {
    decisions,
    invitesToReissue,
    counts,
    readyToFlip: counts.quarantine === 0,
  };
}

export interface EvidenceInput {
  readonly counts: MigrationPlan['counts'];
  readonly mapping: readonly MappingRow[];
  readonly invites?: readonly {
    readonly email: string;
    readonly role: MigrationRole;
  }[];
}

type MappingRow = {
  readonly clerkUserId: string;
  readonly email: string | null;
  readonly accountId: string | null;
  readonly decision: string;
};

/**
 * Canonical evidence text: object keys sorted recursively and mapping rows
 * sorted by Clerk user id, so the same facts serialize identically no matter
 * how they were assembled. The digest (SHA-256 hex) is what gets committed
 * with the runbook; the text itself contains emails and stays outside git.
 */
export function buildEvidence(input: EvidenceInput): {
  readonly text: string;
  readonly digest: string;
} {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      const source = value as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        sorted[key] = canonical(source[key]);
      }
      return sorted;
    }
    return value;
  };

  const mapping = [...input.mapping].sort((a, b) =>
    a.clerkUserId < b.clerkUserId ? -1 : a.clerkUserId > b.clerkUserId ? 1 : 0,
  );
  const payload: Record<string, unknown> = {
    counts: input.counts,
    mapping,
  };
  if (input.invites !== undefined) payload.invites = input.invites;
  const text = JSON.stringify(canonical(payload));
  return { text, digest: createHash('sha256').update(text).digest('hex') };
}

/**
 * Deterministic username derivation for pre-provisioned accounts: sanitized
 * email local part, stable Clerk-id suffix on collision, always inside the
 * 3-32 column bounds of `user_accounts.username`.
 */
export function deriveUsername(
  email: string,
  clerkUserId: string,
  taken: ReadonlySet<string>,
): string {
  const local = email.split('@')[0] ?? '';
  let base = local
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  if (base.length === 0) base = 'user';
  if (base.length < 3) base = `${base}user`.slice(0, 3);
  base = base.slice(0, 25);

  let candidate = base;
  if (taken.has(candidate)) {
    const suffix = clerkUserId
      .replace(/[^a-z0-9-]/gi, '')
      .toLowerCase()
      .slice(-6);
    candidate = `${base}-${suffix}`.slice(0, 32);
    let counter = 2;
    while (taken.has(candidate)) {
      const tail = `-${counter}`;
      candidate = `${base}-${suffix}`.slice(0, 32 - tail.length) + tail;
      counter += 1;
    }
  }
  return candidate;
}

export type MigrationExport = Pick<
  MigrationPlanInput,
  'clerkUsers' | 'clerkInvitations'
>;

export interface MigrationPorts {
  readonly loadState: () => Promise<{
    readonly existingAccounts: MigrationPlanInput['existingAccounts'];
    readonly existingMemberships: MigrationPlanInput['existingMemberships'];
    readonly takenUsernames: ReadonlySet<string>;
  }>;
  readonly createAccount: (input: {
    readonly accountId: string;
    readonly email: string;
    readonly username: string;
    readonly passwordHash: string;
  }) => Promise<string>;
  readonly upsertMembership: (input: {
    readonly accountId: string;
    readonly role: MigrationRole;
    readonly status: MembershipStatus;
  }) => Promise<void>;
  readonly hashPassword: () => Promise<string>;
  readonly writeEvidence: (text: string) => Promise<void>;
  readonly emit: (line: string) => void;
}

export interface RunMigrationInput {
  readonly clerkExport: MigrationExport;
  readonly organizationId: string;
  readonly ownerEmails: readonly string[];
  readonly dispositions: Readonly<Record<string, Disposition>>;
  readonly dryRun: boolean;
  readonly evidencePath: string;
  readonly ports: MigrationPorts;
  readonly newAccountId?: () => string;
}

export type MigrationOutcome = 'dry_run' | 'blocked_quarantine' | 'applied';

/**
 * Applies a plan only when it is ready to flip: quarantine is a hard gate, not
 * a warning. Owners are applied before anyone else so the zero-owner invariant
 * holds at every instant of the run, and evidence is written in both modes so
 * a dry run produces the same reviewable artifact as the live one.
 */
export async function runCustomerWebMigrationCommand(
  input: RunMigrationInput,
): Promise<MigrationOutcome> {
  const { ports } = input;
  const state = await ports.loadState();
  const plan = planCustomerWebMigration({
    clerkUsers: input.clerkExport.clerkUsers,
    clerkInvitations: input.clerkExport.clerkInvitations,
    existingAccounts: state.existingAccounts,
    existingMemberships: state.existingMemberships,
    ownerEmails: input.ownerEmails,
    dispositions: input.dispositions,
  });

  const newAccountId = input.newAccountId ?? ((): string => `usr_${ulid()}`);
  const taken = new Set(state.takenUsernames);
  const ordered = [...plan.decisions].sort((a, b) => {
    const ownerFirst = (d: UserDecision): number =>
      d.kind === 'create_account' || d.kind === 'link_account'
        ? d.membership.role === 'owner'
          ? 0
          : 1
        : 1;
    return ownerFirst(a) - ownerFirst(b);
  });

  // Evidence is always written, even when the run is blocked: the operator
  // reviews exactly the same artifact the live run would have committed to.
  // A blocked run only ever records ids it did not create (creates carry
  // null, links/noops carry the existing row), while an apply fills them in.
  const mapping: MappingRow[] = [];
  if (input.dryRun || !plan.readyToFlip) {
    for (const decision of ordered) {
      mapping.push({
        clerkUserId: decision.clerkUserId,
        email: decision.email,
        accountId:
          decision.kind === 'link_account' ||
          decision.kind === 'membership_noop'
            ? decision.accountId
            : null,
        decision: decision.kind,
      });
    }
  } else {
    // Owners land first so the zero-owner invariant holds at every instant
    // of the run.
    for (const decision of ordered) {
      if (decision.kind === 'create_account') {
        const username = deriveUsername(
          decision.email,
          decision.clerkUserId,
          taken,
        );
        taken.add(username);
        const accountId = await ports.createAccount({
          accountId: newAccountId(),
          email: decision.email,
          username,
          passwordHash: await ports.hashPassword(),
        });
        await ports.upsertMembership({
          accountId,
          role: decision.membership.role,
          status: decision.membership.status,
        });
        mapping.push({
          clerkUserId: decision.clerkUserId,
          email: decision.email,
          accountId,
          decision: 'create_account',
        });
        continue;
      }
      if (decision.kind === 'link_account') {
        await ports.upsertMembership({
          accountId: decision.accountId,
          role: decision.membership.role,
          status: decision.membership.status,
        });
        mapping.push({
          clerkUserId: decision.clerkUserId,
          email: decision.email,
          accountId: decision.accountId,
          decision: 'link_account',
        });
        continue;
      }
      mapping.push({
        clerkUserId: decision.clerkUserId,
        email: decision.email,
        accountId:
          decision.kind === 'membership_noop' ? decision.accountId : null,
        decision: decision.kind,
      });
    }
  }

  const evidence = buildEvidence({
    counts: plan.counts,
    mapping,
    invites: plan.invitesToReissue,
  });
  await ports.writeEvidence(evidence.text);
  emitSummary(ports, plan, evidence.digest);

  if (input.dryRun) return 'dry_run';
  if (!plan.readyToFlip) {
    ports.emit(
      'blocked: resolve every quarantine entry with a disposition, then rerun',
    );
    return 'blocked_quarantine';
  }
  return 'applied';
}

function emitSummary(
  ports: MigrationPorts,
  plan: MigrationPlan,
  digest: string,
): void {
  ports.emit(
    `plan: created=${plan.counts.created} linked=${plan.counts.linked} noop=${plan.counts.membershipNoops} skipped=${plan.counts.skipped} quarantine=${plan.counts.quarantine} invites=${plan.counts.invitesToReissue} readyToFlip=${String(plan.readyToFlip)} digest=${digest}`,
  );
  // Safe to log: Clerk user ids and reasons only — never emails.
  for (const decision of plan.decisions) {
    if (decision.kind === 'quarantine') {
      ports.emit(
        `quarantine: ${decision.clerkUserId} reason=${decision.reason}`,
      );
    }
  }
}
