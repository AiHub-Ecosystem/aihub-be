/**
 * The downstream services metering can attribute usage to. Metering owns this
 * narrow vocabulary so application code does not depend on transport types;
 * the union stays structurally identical to the catalog's downstream ids.
 */
export type MeteringDownstreamId = 'ai-writing' | 'ai-speaking';
