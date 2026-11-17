/**
 * The one column list every speaking grading job read returns. A builder
 * rather than a copied literal, so a new column reaches every SELECT and
 * RETURNING in the feature and the generated SQL stays a reviewed fragment.
 */
export function jobColumns(): string {
  return `
  job_id AS "jobId",
  organization_id AS "organizationId",
  end_user_id AS "endUserId",
  environment,
  identity_mode AS "identityMode",
  api_key_id AS "apiKeyId",
  max_concurrent AS "maxConcurrent",
  quota_tracked AS "quotaTracked",
  quota_unverified AS "quotaUnverified",
  audio_asset_id AS "audioAssetId",
  part,
  question_id AS "questionId",
  prompt_text AS "promptText",
  test_type AS "testType",
  test_code AS "testCode",
  part_result_id AS "partResultId",
  idempotency_key AS "idempotencyKey",
  status,
  lease_expires_at AS "leaseExpiresAt",
  dispatch_started_at AS "dispatchStartedAt",
  result,
  error_code AS "errorCode",
  error_message AS "errorMessage",
  error_retryable AS "errorRetryable",
  created_at AS "createdAt",
  completed_at AS "completedAt"`;
}
