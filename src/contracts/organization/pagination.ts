// One page-size pair for the paginated Organization collections (ADR-0130).
// Audit events keep their own, smaller pair because their rows are heavier.
export const DEFAULT_COLLECTION_PAGE_SIZE = 100;
export const MAX_COLLECTION_PAGE_SIZE = 500;

// The cross-Organization roster pages Organizations, and every one carries a
// member list, so its pair is smaller (ADR-0133).
export const DEFAULT_ROSTER_PAGE_SIZE = 100;
export const MAX_ROSTER_PAGE_SIZE = 100;
export const ROSTER_MEMBERS_PER_ORGANIZATION = 100;
