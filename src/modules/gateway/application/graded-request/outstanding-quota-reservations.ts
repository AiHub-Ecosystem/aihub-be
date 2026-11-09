/**
 * Quota already promised to accepted work that has not reached metering yet,
 * such as an async Speaking grading job. Graded admission subtracts it from the
 * monthly quota so a synchronous call cannot spend quota a queued job holds.
 */
export interface OutstandingQuotaReservationSource {
  outstanding(input: {
    readonly organizationId: string;
    readonly environment: 'production' | 'sandbox';
  }): Promise<number>;
}

export interface OutstandingQuotaReservationsPort {
  count(input: {
    readonly organizationId: string;
    readonly environment: 'production' | 'sandbox';
  }): Promise<number>;
}

export const OUTSTANDING_QUOTA_RESERVATIONS = Symbol(
  'OUTSTANDING_QUOTA_RESERVATIONS',
);

/**
 * Gateway cannot import the modules that hold reservations, so each registers
 * its source here at startup and Gateway sums them.
 */
export class OutstandingQuotaReservationRegistry
  implements OutstandingQuotaReservationsPort
{
  private readonly sources: OutstandingQuotaReservationSource[] = [];

  register(source: OutstandingQuotaReservationSource): void {
    this.sources.push(source);
  }

  async count(input: {
    readonly organizationId: string;
    readonly environment: 'production' | 'sandbox';
  }): Promise<number> {
    const counts = await Promise.all(
      this.sources.map((source) => source.outstanding(input)),
    );
    return counts.reduce((total, count) => total + count, 0);
  }
}
