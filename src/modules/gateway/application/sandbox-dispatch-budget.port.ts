export interface SandboxDispatchReservation {
  readonly organizationId: string;
  readonly requestId: string;
  readonly organizationLimit: number | null;
}

export interface SandboxDispatchBudgetPort {
  reserve(input: SandboxDispatchReservation): Promise<boolean>;
  release(requestId: string): Promise<void>;
}

export const SANDBOX_DISPATCH_BUDGET = Symbol('SANDBOX_DISPATCH_BUDGET');
