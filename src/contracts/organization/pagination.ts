// One page-size pair for the paginated Organization collections (ADR-0130).
// Audit events keep their own, smaller pair because their rows are heavier.
export const DEFAULT_COLLECTION_PAGE_SIZE = 100;
export const MAX_COLLECTION_PAGE_SIZE = 500;
