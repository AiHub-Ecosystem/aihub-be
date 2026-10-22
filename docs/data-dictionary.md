# Data dictionary

Generated from `prisma/schema.prisma`. Do not edit by hand; run `pnpm generate:data-dictionary`.

## Tables

| Table (model)               | Owner       | Columns |
| --------------------------- | ----------- | ------- |
| ApiKey                      | identity    | 15      |
| NotificationEvent           | identity    | 8       |
| AuthIdentity                | auth        | 8       |
| EmailDeliveryRequest        | auth        | 16      |
| AuthEmailRecipientRateLimit | auth        | 5       |
| EmailDailySendBudget        | auth        | 5       |
| EmailVerificationToken      | auth        | 10      |
| IdempotencyRecord           | idempotency | 12      |
| OrganizationAuditEvent      | identity    | 13      |
| OrganizationIdentityConfig  | identity    | 11      |
| OrganizationInvitation      | identity    | 11      |
| OrganizationMembership      | identity    | 8       |
| Organization                | identity    | 20      |
| PasswordResetToken          | auth        | 7       |
| RefreshToken                | auth        | 9       |
| SandboxDispatchReservation  | gateway     | 6       |
| SandboxAllowanceDefault     | gateway     | 2       |
| SandboxAllowanceOverride    | gateway     | 3       |
| DispatchAttempt             | metering    | 7       |
| SpeakingAudioAsset          | speaking    | 9       |
| SpeakingAudioUploadIntent   | speaking    | 10      |
| WritingChartUpload          | writing     | 14      |
| WritingChartRevocationAudit | writing     | 9       |
| UsageRecord                 | metering    | 21      |
| UserAccount                 | auth        | 18      |
| UserAvatar                  | avatar      | 7       |
| UserMfaFactor               | auth        | 8       |
| UserMfaRecoveryCode         | auth        | 5       |
| WebSession                  | auth        | 8       |
| BillingAdjustment           | metering    | 10      |
| BillingMonthClosure         | metering    | 9       |

## ApiKey

Owner: `identity`

| Column              | Type                | Attributes                                                                                    |
| ------------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| id                  | String              | @id                                                                                           |
| organizationId      | String              | @map("organization_id")                                                                       |
| keyHash             | Bytes               | @unique(map: "api_keys_hash_uq") @map("key_hash")                                             |
| keyPrefix           | String              | @map("key_prefix")                                                                            |
| name                | String              |                                                                                               |
| scopes              | String[]            | @default([])                                                                                  |
| allowedEnvironments | String[]            | @default(["production"]) @map("allowed_environments")                                         |
| status              | String              | @default("active")                                                                            |
| expiresAt           | DateTime?           | @map("expires_at") @db.Timestamptz(6)                                                         |
| lastUsedAt          | DateTime?           | @map("last_used_at") @db.Timestamptz(6)                                                       |
| revokedAt           | DateTime?           | @map("revoked_at") @db.Timestamptz(6)                                                         |
| createdAt           | DateTime            | @default(now()) @map("created_at") @db.Timestamptz(6)                                         |
| internal            | Boolean             | @default(false)                                                                               |
| organization        | Organization        | @relation(fields: [organizationId], references: [id], onDelete: NoAction, onUpdate: NoAction) |
| notificationEvents  | NotificationEvent[] |                                                                                               |

## NotificationEvent

Owner: `identity`

| Column           | Type         | Attributes                                                                                    |
| ---------------- | ------------ | --------------------------------------------------------------------------------------------- |
| id               | String       | @id                                                                                           |
| kind             | String       |                                                                                               |
| organizationId   | String       | @map("organization_id")                                                                       |
| apiKeyId         | String       | @map("api_key_id")                                                                            |
| subjectExpiresAt | DateTime     | @map("subject_expires_at") @db.Timestamptz(6)                                                 |
| recordedAt       | DateTime     | @map("recorded_at") @db.Timestamptz(6)                                                        |
| organization     | Organization | @relation(fields: [organizationId], references: [id], onDelete: NoAction, onUpdate: NoAction) |
| apiKey           | ApiKey       | @relation(fields: [apiKeyId], references: [id], onDelete: NoAction, onUpdate: NoAction)       |

## AuthIdentity

Owner: `auth`

| Column         | Type        | Attributes                                                               |
| -------------- | ----------- | ------------------------------------------------------------------------ |
| id             | String      | @id                                                                      |
| userAccountId  | String      | @map("user_account_id")                                                  |
| provider       | String      |                                                                          |
| canonicalEmail | String      | @map("canonical_email")                                                  |
| passwordHash   | String      | @map("password_hash")                                                    |
| createdAt      | DateTime    | @map("created_at") @db.Timestamptz(6)                                    |
| updatedAt      | DateTime    | @map("updated_at") @db.Timestamptz(6)                                    |
| userAccount    | UserAccount | @relation(fields: [userAccountId], references: [id], onUpdate: NoAction) |

## EmailDeliveryRequest

Owner: `auth`

| Column                      | Type      | Attributes                                                 |
| --------------------------- | --------- | ---------------------------------------------------------- |
| id                          | String    | @id                                                        |
| kind                        | String    |                                                            |
| status                      | String    | @default("queued")                                         |
| payloadCiphertext           | String?   | @map("payload_ciphertext")                                 |
| attempts                    | Int       | @default(0)                                                |
| lastAttemptAt               | DateTime? | @map("last_attempt_at") @db.Timestamptz(6)                 |
| lastErrorCode               | String?   | @map("last_error_code")                                    |
| cancelReason                | String?   | @map("cancel_reason")                                      |
| createdAt                   | DateTime  | @map("created_at") @db.Timestamptz(6)                      |
| completedAt                 | DateTime? | @map("completed_at") @db.Timestamptz(6)                    |
| leaseOwner                  | String?   | @map("lease_owner")                                        |
| leaseExpiresAt              | DateTime? | @map("lease_expires_at") @db.Timestamptz(6)                |
| failureReportedAt           | DateTime? | @map("failure_reported_at") @db.Timestamptz(6)             |
| failureNotifyLeaseExpiresAt | DateTime? | @map("failure_notify_lease_expires_at") @db.Timestamptz(6) |
| organizationId              | String?   | @map("organization_id")                                    |
| inviterId                   | String?   | @map("inviter_id")                                         |

## AuthEmailRecipientRateLimit

Owner: `auth`

| Column          | Type     | Attributes                                   |
| --------------- | -------- | -------------------------------------------- |
| keyVersion      | String   | @map("key_version")                          |
| addressHmac     | String   | @map("address_hmac")                         |
| windowStartedAt | DateTime | @map("window_started_at") @db.Timestamptz(6) |
| expiresAt       | DateTime | @map("expires_at") @db.Timestamptz(6)        |
| requestCount    | Int      | @map("request_count")                        |

## EmailDailySendBudget

Owner: `auth`

| Column           | Type     | Attributes                   |
| ---------------- | -------- | ---------------------------- |
| id               | BigInt   | @id @default(1)              |
| budgetDate       | DateTime | @map("budget_date") @db.Date |
| dailyBudget      | BigInt   | @map("daily_budget")         |
| invitationBudget | BigInt   | @map("invitation_budget")    |
| reservedSends    | BigInt   | @map("reserved_sends")       |

## EmailVerificationToken

Owner: `auth`

| Column             | Type        | Attributes                                                                                                     |
| ------------------ | ----------- | -------------------------------------------------------------------------------------------------------------- |
| id                 | String      | @id                                                                                                            |
| userAccountId      | String      | @unique(map: "email_verification_one_open_token", where: raw("(consumed_at IS NULL)")) @map("user_account_id") |
| tokenHash          | String      | @unique(map: "email_verification_tokens_token_hash_key") @map("token_hash")                                    |
| expiresAt          | DateTime    | @map("expires_at") @db.Timestamptz(6)                                                                          |
| consumedAt         | DateTime?   | @map("consumed_at") @db.Timestamptz(6)                                                                         |
| createdAt          | DateTime    | @map("created_at") @db.Timestamptz(6)                                                                          |
| consumedReason     | String?     | @map("consumed_reason")                                                                                        |
| browserBindingHash | String?     | @map("browser_binding_hash")                                                                                   |
| signedInAt         | DateTime?   | @map("signed_in_at") @db.Timestamptz(6)                                                                        |
| userAccount        | UserAccount | @relation(fields: [userAccountId], references: [id], onUpdate: NoAction)                                       |

## IdempotencyRecord

Owner: `idempotency`

| Column             | Type      | Attributes                                            |
| ------------------ | --------- | ----------------------------------------------------- |
| organizationId     | String?   | @map("organization_id")                               |
| operation          | String    |                                                       |
| idempotencyKey     | String    | @map("idempotency_key")                               |
| requestFingerprint | Bytes     | @map("request_fingerprint")                           |
| state              | String    |                                                       |
| requestId          | String    | @map("request_id")                                    |
| responseStatus     | Int?      | @map("response_status")                               |
| responseBody       | Json?     | @map("response_body")                                 |
| createdAt          | DateTime  | @default(now()) @map("created_at") @db.Timestamptz(6) |
| completedAt        | DateTime? | @map("completed_at") @db.Timestamptz(6)               |
| expiresAt          | DateTime  | @map("expires_at") @db.Timestamptz(6)                 |
| actorScope         | String    | @default("") @map("actor_scope")                      |

## OrganizationAuditEvent

Owner: `identity`

| Column             | Type         | Attributes                                                                    |
| ------------------ | ------------ | ----------------------------------------------------------------------------- |
| id                 | String       | @id                                                                           |
| organizationId     | String       | @map("organization_id")                                                       |
| actorUserAccountId | String       | @map("actor_user_account_id")                                                 |
| action             | String       |                                                                               |
| outcome            | String       |                                                                               |
| targetType         | String       | @map("target_type")                                                           |
| targetId           | String       | @map("target_id")                                                             |
| targetLabel        | String?      | @map("target_label")                                                          |
| detail             | Json?        |                                                                               |
| requestId          | String       | @map("request_id")                                                            |
| occurredAt         | DateTime     | @map("occurred_at") @db.Timestamptz(6)                                        |
| actor              | UserAccount  | @relation(fields: [actorUserAccountId], references: [id], onUpdate: NoAction) |
| organization       | Organization | @relation(fields: [organizationId], references: [id], onUpdate: NoAction)     |

## OrganizationIdentityConfig

Owner: `identity`

| Column                 | Type         | Attributes                                                                                    |
| ---------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| organizationId         | String       | @id @map("organization_id")                                                                   |
| issuer                 | String       | @unique(map: "oic_issuer_uq")                                                                 |
| jwksUrl                | String?      | @map("jwks_url")                                                                              |
| publicKeysJwks         | Json?        | @map("public_keys_jwks")                                                                      |
| allowedAlgorithms      | String[]     | @default(["RS256", "ES256"]) @map("allowed_algorithms")                                       |
| maxAssertionTtlSeconds | Int          | @default(300) @map("max_assertion_ttl_seconds")                                               |
| status                 | String       | @default("active")                                                                            |
| createdAt              | DateTime     | @default(now()) @map("created_at") @db.Timestamptz(6)                                         |
| updatedAt              | DateTime     | @default(now()) @map("updated_at") @db.Timestamptz(6)                                         |
| jwksCacheVersion       | BigInt       | @default(1) @map("jwks_cache_version")                                                        |
| organization           | Organization | @relation(fields: [organizationId], references: [id], onDelete: NoAction, onUpdate: NoAction) |

## OrganizationInvitation

Owner: `identity`

| Column         | Type         | Attributes                                                                 |
| -------------- | ------------ | -------------------------------------------------------------------------- |
| id             | String       | @id                                                                        |
| organizationId | String       | @map("organization_id")                                                    |
| email          | String       |                                                                            |
| role           | String       |                                                                            |
| invitedBy      | String       | @map("invited_by")                                                         |
| tokenHash      | String       | @unique(map: "organization_invitations_token_hash_key") @map("token_hash") |
| expiresAt      | DateTime     | @map("expires_at") @db.Timestamptz(6)                                      |
| consumedAt     | DateTime?    | @map("consumed_at") @db.Timestamptz(6)                                     |
| createdAt      | DateTime     | @map("created_at") @db.Timestamptz(6)                                      |
| invitedByUser  | UserAccount  | @relation(fields: [invitedBy], references: [id], onUpdate: NoAction)       |
| organization   | Organization | @relation(fields: [organizationId], references: [id], onUpdate: NoAction)  |

## OrganizationMembership

Owner: `identity`

| Column         | Type         | Attributes                                                                |
| -------------- | ------------ | ------------------------------------------------------------------------- |
| organizationId | String       | @map("organization_id")                                                   |
| userAccountId  | String       | @map("user_account_id")                                                   |
| role           | String       |                                                                           |
| status         | String       | @default("active")                                                        |
| createdAt      | DateTime     | @default(now()) @map("created_at") @db.Timestamptz(6)                     |
| updatedAt      | DateTime     | @default(now()) @map("updated_at") @db.Timestamptz(6)                     |
| organization   | Organization | @relation(fields: [organizationId], references: [id], onUpdate: NoAction) |
| userAccount    | UserAccount  | @relation(fields: [userAccountId], references: [id], onUpdate: NoAction)  |

## Organization

Owner: `identity`

| Column                 | Type                        | Attributes                                                                                                                       |
| ---------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| id                     | String                      | @id                                                                                                                              |
| name                   | String                      |                                                                                                                                  |
| status                 | String                      | @default("active")                                                                                                               |
| entitlements           | String[]                    | @default([])                                                                                                                     |
| rateLimitRpm           | Int                         | @default(600) @map("rate_limit_rpm")                                                                                             |
| maxConcurrent          | Int                         | @default(20) @map("max_concurrent")                                                                                              |
| monthlyRequestQuota    | Int?                        | @map("monthly_request_quota")                                                                                                    |
| hardStopOnQuota        | Boolean                     | @default(false) @map("hard_stop_on_quota")                                                                                       |
| createdAt              | DateTime                    | @default(now()) @map("created_at") @db.Timestamptz(6)                                                                            |
| updatedAt              | DateTime                    | @default(now()) @map("updated_at") @db.Timestamptz(6)                                                                            |
| createdByUserAccountId | String?                     | @map("created_by_user_account_id")                                                                                               |
| apiKeys                | ApiKey[]                    |                                                                                                                                  |
| auditEvents            | OrganizationAuditEvent[]    |                                                                                                                                  |
| billingAdjustments     | BillingAdjustment[]         |                                                                                                                                  |
| billingMonthClosures   | BillingMonthClosure[]       |                                                                                                                                  |
| identityConfig         | OrganizationIdentityConfig? |                                                                                                                                  |
| invitations            | OrganizationInvitation[]    |                                                                                                                                  |
| memberships            | OrganizationMembership[]    |                                                                                                                                  |
| notificationEvents     | NotificationEvent[]         |                                                                                                                                  |
| createdByUserAccount   | UserAccount?                | @relation("organization_created_by", fields: [createdByUserAccountId], references: [id], onDelete: Restrict, onUpdate: NoAction) |

## PasswordResetToken

Owner: `auth`

| Column        | Type        | Attributes                                                                                                 |
| ------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| id            | String      | @id                                                                                                        |
| userAccountId | String      | @unique(map: "password_reset_one_open_token", where: raw("(consumed_at IS NULL)")) @map("user_account_id") |
| tokenHash     | String      | @unique(map: "password_reset_tokens_token_hash_key") @map("token_hash")                                    |
| expiresAt     | DateTime    | @map("expires_at") @db.Timestamptz(6)                                                                      |
| consumedAt    | DateTime?   | @map("consumed_at") @db.Timestamptz(6)                                                                     |
| createdAt     | DateTime    | @map("created_at") @db.Timestamptz(6)                                                                      |
| userAccount   | UserAccount | @relation(fields: [userAccountId], references: [id], onUpdate: NoAction)                                   |

## RefreshToken

Owner: `auth`

| Column        | Type        | Attributes                                                               |
| ------------- | ----------- | ------------------------------------------------------------------------ |
| id            | String      | @id                                                                      |
| familyId      | String      | @map("family_id")                                                        |
| userAccountId | String      | @map("user_account_id")                                                  |
| tokenHash     | String      | @unique(map: "refresh_tokens_token_hash_key") @map("token_hash")         |
| issuedAt      | DateTime    | @map("issued_at") @db.Timestamptz(6)                                     |
| expiresAt     | DateTime    | @map("expires_at") @db.Timestamptz(6)                                    |
| usedAt        | DateTime?   | @map("used_at") @db.Timestamptz(6)                                       |
| revokedAt     | DateTime?   | @map("revoked_at") @db.Timestamptz(6)                                    |
| userAccount   | UserAccount | @relation(fields: [userAccountId], references: [id], onUpdate: NoAction) |

## SandboxDispatchReservation

Owner: `gateway`

| Column         | Type      | Attributes                                            |
| -------------- | --------- | ----------------------------------------------------- |
| requestId      | String    | @id @map("request_id")                                |
| organizationId | String    | @map("organization_id")                               |
| monthStart     | DateTime  | @map("month_start") @db.Date                          |
| status         | String    | @default("reserved")                                  |
| createdAt      | DateTime  | @default(now()) @map("created_at") @db.Timestamptz(6) |
| releasedAt     | DateTime? | @map("released_at") @db.Timestamptz(6)                |

## SandboxAllowanceDefault

Owner: `gateway`

| Column     | Type     | Attributes                       |
| ---------- | -------- | -------------------------------- |
| monthStart | DateTime | @id @map("month_start") @db.Date |
| allowance  | Int      | @map("allowance")                |

## SandboxAllowanceOverride

Owner: `gateway`

| Column         | Type     | Attributes                   |
| -------------- | -------- | ---------------------------- |
| organizationId | String   | @map("organization_id")      |
| monthStart     | DateTime | @map("month_start") @db.Date |
| allowance      | Int      | @map("allowance")            |

## DispatchAttempt

Owner: `metering`

| Column         | Type     | Attributes                               |
| -------------- | -------- | ---------------------------------------- |
| attemptId      | String   | @id @map("attempt_id") @db.Uuid          |
| requestId      | String   | @map("request_id")                       |
| organizationId | String   | @map("organization_id")                  |
| operation      | String   |                                          |
| createdAt      | DateTime | @map("created_at") @db.Timestamptz(6)    |
| unknownAfter   | DateTime | @map("unknown_after") @db.Timestamptz(6) |
| outcome        | String?  |                                          |

## SpeakingAudioAsset

Owner: `speaking`

| Column             | Type     | Attributes                                                              |
| ------------------ | -------- | ----------------------------------------------------------------------- |
| id                 | String   | @id                                                                     |
| organizationId     | String   | @map("organization_id")                                                 |
| endUserId          | String   | @map("end_user_id")                                                     |
| environment        | String   |                                                                         |
| objectKey          | String   | @unique(map: "speaking_audio_assets_object_key_key") @map("object_key") |
| contentType        | String   | @map("content_type")                                                    |
| byteSize           | Int      | @map("byte_size")                                                       |
| acceptedAt         | DateTime | @map("accepted_at") @db.Timestamptz(6)                                  |
| retentionExpiresAt | DateTime | @map("retention_expires_at") @db.Timestamptz(6)                         |

## SpeakingAudioUploadIntent

Owner: `speaking`

| Column         | Type     | Attributes                                                                      |
| -------------- | -------- | ------------------------------------------------------------------------------- |
| id             | String   | @id                                                                             |
| organizationId | String   | @map("organization_id")                                                         |
| endUserId      | String   | @map("end_user_id")                                                             |
| environment    | String   |                                                                                 |
| objectKey      | String   | @unique(map: "speaking_audio_upload_intents_object_key_key") @map("object_key") |
| contentType    | String   | @map("content_type")                                                            |
| byteSize       | Int      | @map("byte_size")                                                               |
| status         | String   | @default("open")                                                                |
| createdAt      | DateTime | @map("created_at") @db.Timestamptz(6)                                           |
| expiresAt      | DateTime | @map("expires_at") @db.Timestamptz(6)                                           |

## WritingChartUpload

Owner: `writing`

| Column             | Type      | Attributes                                                                    |
| ------------------ | --------- | ----------------------------------------------------------------------------- |
| id                 | String    | @id                                                                           |
| organizationId     | String    | @map("organization_id")                                                       |
| endUserId          | String    | @map("end_user_id")                                                           |
| environment        | String    |                                                                               |
| stagingKey         | String    | @unique(map: "writing_chart_uploads_staging_key_key") @map("staging_key")     |
| publishedKey       | String    | @unique(map: "writing_chart_uploads_published_key_key") @map("published_key") |
| contentType        | String    | @map("content_type")                                                          |
| byteSize           | Int       | @map("byte_size")                                                             |
| status             | String    | @default("open")                                                              |
| imageUrl           | String?   | @map("image_url")                                                             |
| createdAt          | DateTime  | @map("created_at") @db.Timestamptz(6)                                         |
| expiresAt          | DateTime  | @map("expires_at") @db.Timestamptz(6)                                         |
| publishedAt        | DateTime? | @map("published_at") @db.Timestamptz(6)                                       |
| retentionExpiresAt | DateTime? | @map("retention_expires_at") @db.Timestamptz(6)                               |

## WritingChartRevocationAudit

Owner: `writing`

| Column             | Type        | Attributes                                                                                        |
| ------------------ | ----------- | ------------------------------------------------------------------------------------------------- |
| id                 | String      | @id                                                                                               |
| assetId            | String      | @map("asset_id")                                                                                  |
| actorUserAccountId | String      | @map("actor_user_account_id")                                                                     |
| occurredAt         | DateTime    | @map("occurred_at") @db.Timestamptz(6)                                                            |
| phase              | String      |                                                                                                   |
| originOutcome      | String?     | @map("origin_outcome")                                                                            |
| edgeOutcome        | String?     | @map("edge_outcome")                                                                              |
| edgeStatus         | Int?        | @map("edge_status")                                                                               |
| actor              | UserAccount | @relation(fields: [actorUserAccountId], references: [id], onDelete: Restrict, onUpdate: NoAction) |

## UsageRecord

Owner: `metering`

| Column           | Type     | Attributes                                            |
| ---------------- | -------- | ----------------------------------------------------- |
| requestId        | String   | @id @map("request_id")                                |
| organizationId   | String   | @map("organization_id")                               |
| apiKeyId         | String   | @map("api_key_id")                                    |
| actorId          | String?  | @map("actor_id")                                      |
| service          | String   |                                                       |
| operation        | String   |                                                       |
| environment      | String   |                                                       |
| outcome          | String   |                                                       |
| httpStatus       | Int      | @map("http_status")                                   |
| errorCode        | String?  | @map("error_code")                                    |
| billableRequests | Int      | @default(0) @map("billable_requests")                 |
| inputTokens      | Int?     | @map("input_tokens")                                  |
| outputTokens     | Int?     | @map("output_tokens")                                 |
| totalTokens      | Int?     | @map("total_tokens")                                  |
| models           | Json?    |                                                       |
| meteringStatus   | String   | @map("metering_status")                               |
| totalMs          | Int      | @map("total_ms")                                      |
| downstreamMs     | Int?     | @map("downstream_ms")                                 |
| aiProcessingMs   | Int?     | @map("ai_processing_ms")                              |
| createdAt        | DateTime | @default(now()) @map("created_at") @db.Timestamptz(6) |
| billingBasis     | String   | @default("response") @map("billing_basis")            |

## UserAccount

Owner: `auth`

| Column                       | Type                          | Attributes                                 |
| ---------------------------- | ----------------------------- | ------------------------------------------ |
| id                           | String                        | @id                                        |
| username                     | String                        | @unique(map: "user_accounts_username_key") |
| status                       | String                        |                                            |
| createdAt                    | DateTime                      | @map("created_at") @db.Timestamptz(6)      |
| updatedAt                    | DateTime                      | @map("updated_at") @db.Timestamptz(6)      |
| authIdentities               | AuthIdentity[]                |                                            |
| createdOrganizations         | Organization[]                | @relation("organization_created_by")       |
| auditEvents                  | OrganizationAuditEvent[]      |                                            |
| emailVerificationTokens      | EmailVerificationToken?       |                                            |
| invitations                  | OrganizationInvitation[]      |                                            |
| memberships                  | OrganizationMembership[]      |                                            |
| passwordResetTokens          | PasswordResetToken?           |                                            |
| refreshTokens                | RefreshToken[]                |                                            |
| avatar                       | UserAvatar?                   |                                            |
| mfaFactor                    | UserMfaFactor?                |                                            |
| mfaRecoveryCodes             | UserMfaRecoveryCode[]         |                                            |
| webSessions                  | WebSession[]                  |                                            |
| writingChartRevocationAudits | WritingChartRevocationAudit[] |                                            |

## UserAvatar

Owner: `avatar`

| Column        | Type        | Attributes                                                               |
| ------------- | ----------- | ------------------------------------------------------------------------ |
| id            | String      | @id                                                                      |
| userAccountId | String      | @unique(map: "user_avatars_one_per_account") @map("user_account_id")     |
| objectKey     | String      | @unique(map: "user_avatars_object_key_key") @map("object_key")           |
| contentType   | String      | @map("content_type")                                                     |
| byteSize      | Int         | @map("byte_size")                                                        |
| acceptedAt    | DateTime    | @map("accepted_at") @db.Timestamptz(6)                                   |
| userAccount   | UserAccount | @relation(fields: [userAccountId], references: [id], onUpdate: NoAction) |

## UserMfaFactor

Owner: `auth`

| Column           | Type        | Attributes                                                                   |
| ---------------- | ----------- | ---------------------------------------------------------------------------- |
| factorId         | String      | @id @map("factor_id")                                                        |
| userAccountId    | String      | @unique(map: "user_mfa_factors_user_account_id_key") @map("user_account_id") |
| secretKeyId      | String      | @map("secret_key_id")                                                        |
| secretCiphertext | String      | @map("secret_ciphertext")                                                    |
| status           | String      |                                                                              |
| createdAt        | DateTime    | @map("created_at") @db.Timestamptz(6)                                        |
| updatedAt        | DateTime    | @map("updated_at") @db.Timestamptz(6)                                        |
| userAccount      | UserAccount | @relation(fields: [userAccountId], references: [id], onUpdate: NoAction)     |

## UserMfaRecoveryCode

Owner: `auth`

| Column        | Type        | Attributes                                                               |
| ------------- | ----------- | ------------------------------------------------------------------------ |
| userAccountId | String      | @map("user_account_id")                                                  |
| codeHash      | String      | @map("code_hash")                                                        |
| createdAt     | DateTime    | @map("created_at") @db.Timestamptz(6)                                    |
| consumedAt    | DateTime?   | @map("consumed_at") @db.Timestamptz(6)                                   |
| userAccount   | UserAccount | @relation(fields: [userAccountId], references: [id], onUpdate: NoAction) |

## WebSession

Owner: `auth`

| Column        | Type        | Attributes                                                               |
| ------------- | ----------- | ------------------------------------------------------------------------ |
| id            | String      | @id                                                                      |
| userAccountId | String      | @map("user_account_id")                                                  |
| tokenHash     | String      | @unique(map: "web_sessions_token_hash_key") @map("token_hash")           |
| createdAt     | DateTime    | @map("created_at") @db.Timestamptz(6)                                    |
| expiresAt     | DateTime    | @map("expires_at") @db.Timestamptz(6)                                    |
| lastRenewedAt | DateTime    | @map("last_renewed_at") @db.Timestamptz(6)                               |
| revokedAt     | DateTime?   | @map("revoked_at") @db.Timestamptz(6)                                    |
| userAccount   | UserAccount | @relation(fields: [userAccountId], references: [id], onUpdate: NoAction) |

## BillingAdjustment

Owner: `metering`

| Column         | Type         | Attributes                                                                                    |
| -------------- | ------------ | --------------------------------------------------------------------------------------------- |
| id             | String       | @id                                                                                           |
| organizationId | String       | @map("organization_id")                                                                       |
| billingMonth   | DateTime     | @map("billing_month") @db.Date                                                                |
| operation      | String       |                                                                                               |
| requests       | Int          |                                                                                               |
| reason         | String       |                                                                                               |
| corrects       | Json         |                                                                                               |
| actor          | String       |                                                                                               |
| createdAt      | DateTime     | @default(now()) @map("created_at") @db.Timestamptz(6)                                         |
| organization   | Organization | @relation(fields: [organizationId], references: [id], onDelete: NoAction, onUpdate: NoAction) |

## BillingMonthClosure

Owner: `metering`

| Column             | Type         | Attributes                                                                                    |
| ------------------ | ------------ | --------------------------------------------------------------------------------------------- |
| organizationId     | String       | @map("organization_id")                                                                       |
| billingMonth       | DateTime     | @map("billing_month") @db.Date                                                                |
| operation          | String       |                                                                                               |
| billableRequests   | Int          | @map("billable_requests")                                                                     |
| adjustmentRequests | Int          | @map("adjustment_requests")                                                                   |
| totalRequests      | Int          | @map("total_requests")                                                                        |
| closedBy           | String       | @map("closed_by")                                                                             |
| closedAt           | DateTime     | @default(now()) @map("closed_at") @db.Timestamptz(6)                                          |
| organization       | Organization | @relation(fields: [organizationId], references: [id], onDelete: NoAction, onUpdate: NoAction) |
