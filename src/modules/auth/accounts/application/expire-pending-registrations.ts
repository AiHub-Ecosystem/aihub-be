/** A pending account is deleted this long after its latest registration (ADR-0123). */
export const PENDING_REGISTRATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const PENDING_REGISTRATION_BATCH_SIZE = 500;
// A run is bounded; a backlog beyond this many batches waits for the next day.
export const PENDING_REGISTRATION_MAX_BATCHES = 100;

export interface PendingRegistrationRecordPort {
  /**
   * Deletes up to `limit` User Accounts still pending verification whose
   * latest registration is at or before `expiredAtOrBefore`, with their Auth
   * Identity and verification tokens, and returns how many it deleted.
   */
  deleteExpiredPending(input: {
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<number>;
}

export interface PendingRegistrationExpirySummary {
  readonly deleted: number;
  readonly batches: number;
}

/**
 * Releases the email and username of a registration nobody verified, so they
 * are not reserved forever. Counts only: the result names no account.
 */
export class ExpirePendingRegistrations {
  constructor(private readonly records: PendingRegistrationRecordPort) {}

  async run(now: Date): Promise<PendingRegistrationExpirySummary> {
    const expiredAtOrBefore = new Date(
      now.getTime() - PENDING_REGISTRATION_LIFETIME_MS,
    );
    let deleted = 0;
    let batches = 0;
    while (batches < PENDING_REGISTRATION_MAX_BATCHES) {
      const count = await this.records.deleteExpiredPending({
        expiredAtOrBefore,
        limit: PENDING_REGISTRATION_BATCH_SIZE,
      });
      batches += 1;
      deleted += count;
      if (count < PENDING_REGISTRATION_BATCH_SIZE) break;
    }
    return { deleted, batches };
  }
}
