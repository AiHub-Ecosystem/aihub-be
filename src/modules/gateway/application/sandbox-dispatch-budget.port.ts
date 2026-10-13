export interface SandboxDispatchReservation {
  readonly organizationId: string;
  readonly requestId: string;
}

/**
 * The Sandbox allowance as it stands for one Organization in the current UTC
 * month. Advisory: it is what a demo validation reports, never an admission.
 */
export interface SandboxAllowanceSnapshot {
  readonly monthlyLimit: number;
  readonly reserved: number;
}

export interface SandboxDispatchBudgetPort {
  /**
   * Durably reserves one dispatch. `false` means the Organization or shared
   * allowance is spent; a rejection throws, because an unreadable policy store
   * must not be reported as an exhausted allowance. Admission reads the
   * persisted allowance inside the same transaction as the counts, so a
   * concurrent request cannot take the last available unit and a lowering
   * override takes effect atomically.
   */
  reserve(input: SandboxDispatchReservation): Promise<boolean>;
  release(requestId: string): Promise<void>;
  /** null when policy state cannot be read; callers must not assume a default. */
  allowanceFor(
    organizationId: string,
  ): Promise<SandboxAllowanceSnapshot | null>;
}

export const SANDBOX_DISPATCH_BUDGET = Symbol('SANDBOX_DISPATCH_BUDGET');
