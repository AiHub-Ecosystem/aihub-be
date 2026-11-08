export const AVATAR_COMPLETION_DEADLINE_MS = 20_000;
// Invariant: the callback deadline < transaction timeout <= server idle timeout.
export const AVATAR_COMPLETION_LOCK_TRANSACTION_TIMEOUT_MS = 30_000;
export const AVATAR_LOCK_IDLE_TRANSACTION_TIMEOUT_MS = 35_000;
export const AVATAR_COMPLETION_COPY_MIN_REMAINING_MS = 10_000;

/**
 * How many uncompleted, unexpired upload URLs one account may hold at once
 * (#374). One is enough for an account setting or replacing its Avatar, and a
 * client that uploads again after a failure reuses its slot rather than
 * stacking a second one. The Avatar bucket is public-read, so every open URL is
 * also a writable public object until completion; a small fixed number keeps a
 * single account from filling the shared SeaweedFS disk.
 */
export const AVATAR_OPEN_UPLOAD_MAX = 3;

/**
 * How many upload URLs one account may be issued in a rolling window (#374).
 * Abandoning an upload costs one issuance, so this is the ceiling on churn
 * rather than on concurrency; it sits far above any human replacing an Avatar
 * and far below the cost of filling a disk with 2 MiB objects.
 */
export const AVATAR_UPLOAD_ISSUANCE_MAX = 10;

/** The rolling window the issuance ceiling counts over. */
export const AVATAR_UPLOAD_ISSUANCE_WINDOW_MS = 60 * 60 * 1000;
