export type SpeakingV2ResultKind = 'response' | 'part' | 'test';

export interface SpeakingV2ResultOwner {
  readonly organizationId: string;
  readonly environment: string;
  readonly endUserId: string;
}

export interface SpeakingV2ResultOwnershipPort {
  record(
    owner: SpeakingV2ResultOwner,
    kind: SpeakingV2ResultKind,
    id: string,
  ): Promise<void>;
  findOwnedIds(
    owner: SpeakingV2ResultOwner,
    kind: SpeakingV2ResultKind,
    ids: readonly string[],
  ): Promise<readonly string[]>;
}

export const SPEAKING_V2_RESULT_OWNERSHIP = Symbol(
  'SPEAKING_V2_RESULT_OWNERSHIP',
);
