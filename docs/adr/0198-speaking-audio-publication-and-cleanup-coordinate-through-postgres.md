# ADR-0198: Speaking audio publication and cleanup coordinate through PostgreSQL

- Status: Accepted
- Date: 2026-11-27
- Related issue: [#2055](https://github.com/AiHub-Ecosystem/aihub-be/issues/2055)
- Amends: [ADR-0070](0070-speaking-audio-upload-intent-and-retention.md) (published object key and completion transaction), [ADR-0196](0196-one-upload-session-core-serves-avatar-speaking-and-writing.md) (Speaking's transaction boundary in decision 7)
- Related: [ADR-0065](0065-aihub-owns-audio-asset-catalog-and-playback-urls.md), [ADR-0128](0128-persisted-values-and-vault-document-keys-are-read-before-they-are-written.md), [ADR-0184](0184-evaluate-fencing-tokens-for-lease-owned-workers.md)

## Context

The Speaking adapter reports that publication has started before its database
transaction has acquired the intent row lock. Two application instances can
therefore both copy the staged audio. The sweep adapter also keeps the
selected row and expiry cutoff in memory, so another worker cannot use the
same candidate to finish cleanup.

## Decision

1. Commit a time-limited publication reservation in PostgreSQL before copying.
   Bind it to the Organization, End-User ID, asset ID, environment, and a
   private destination key unique to that reservation. PostgreSQL time governs
   expiry. The copy runs outside the transaction. Any application instance can
   finalize a live reservation with its identifier and matching owner after the
   destination has been verified. Finalization records the destination as the
   Audio asset key and consumes the Audio Upload Intent in one transaction.
   An expired or superseded reservation cannot finalize or release a newer
   reservation. Its late copy can only write to its own destination.
2. When completion requests overlap, the second waits within its existing
   completion deadline for the publication record. It returns that Audio
   asset if available, or the existing retryable storage error if the first
   attempt is still in progress when the wait ends. A repeat after success
   returns the recorded Audio asset. Each live reservation authorizes one
   publisher. An eligible retry after expiry takes a fresh reservation and
   key. Existing deadlines, limits, retention, and HTTP contracts apply.
3. A Speaking sweep worker claims a candidate in PostgreSQL before deleting
   an object. The candidate carries its expiry cutoff. A claim rechecks
   eligibility and excludes a live publication before the worker touches
   storage. PostgreSQL rechecks the claim and eligibility when removing the
   record. Another worker can finish interrupted cleanup after the claim
   expires. Missing objects count as deleted. Rejected intents remain eligible
   immediately, and expired open intents retain their 24-hour grace period.
   Abandoned publication destinations remain discoverable after the intent is
   consumed, including if an in-flight copy finishes after a cleanup pass.
   Cleanup protects the recorded Audio asset key. Audio asset retention stays
   at 30 days. This decision applies to Speaking.
   The first successful deletion retains the reservation so a later sweep can
   delete a late copy. The row becomes eligible for removal after another
   24-hour grace period. A copy that continues past both cleanup passes leaves
   an untracked object, but still cannot replace an accepted asset.
4. Keep the documented `/original` URL form accepted by v1 grading. For an
   existing Audio asset at `/original`, keep its current URL handling. For an
   Audio asset at a reservation-specific key, resolve the URL to the live
   asset for the authenticated Organization, End-User ID, and environment.
   Sign the recorded key for provider retrieval. Keep the existing trusted
   host and bucket checks, and the sample URL path. V2 continues to read by the
   recorded key. Both paths use the private audio buckets.

The reservation table is temporarily exempt from row-level security while
[#298](https://github.com/AiHub-Ecosystem/aihub-be/issues/298) blocks enabling
policies under [ADR-0109](0109-adopt-postgres-row-level-security-as-tenant-backstop.md).
Request queries keep explicit Organization predicates. Only the sweep lists
candidates across Organizations, then claims and removes them under the
candidate's Organization.

## Rollout and rollback

The bridge release expands the schema compatibly and can read both object-key
forms. It ships both sides of the new coordination protocol, controlled by
activation state shared by request handlers and sweep workers in the same
environment. It keeps writing the legacy form while its predecessor is a
rollback target. The second release activates the new writes after confirming
the bridge is deployed and pre-bridge writers and sweep workers have drained.
Both releases honor the same activation state during blue-green overlap.
Rolling back the application to the bridge keeps the protocol active and the
schema expanded. With new writes enabled, the bridge is the oldest supported
rollback target.

Deploy the bridge with the migration defaults intact. A bridge sweep can
claim legacy intents, which still have the same cleanup eligibility during
overlap. Reservation destinations are eligible only after activation.
For the second release, after draining all pre-bridge handlers and sweep
processes, run the following on each database that serves Speaking uploads.

```sql
UPDATE speaking_audio_publication_protocol
SET activated_at = clock_timestamp()
WHERE id = true AND activated_at IS NULL;

SELECT activated_at
FROM speaking_audio_publication_protocol
WHERE id = true;
```

Confirm the query returns a timestamp. This is a one-way switch. On rollback
to the bridge, leave the timestamp and expanded schema in place.

## Verification

- Use independent core instances and PostgreSQL connections to prove cross-instance
  reservation finalization, one copy under normal contention, and replay of the
  winning result. Delay an expired publisher's copy until the retry has published
  and prove both the winning record and its bytes survive.
- Use independent sweep workers to prove a live claim excludes another worker,
  an expired claim can be recovered when the object is already gone, and an
  abandoned destination can be cleaned after the intent is consumed. Include a
  late copy that appears after the first cleanup pass.
- Exercise v1 with legacy and new Audio assets, foreign and expired assets, and
  sample URLs. Exercise v2 against both stored key forms.
- Rehearse the bridge and second release against shared state through activation
  and rollback. Verify legacy and new rows stay usable by both.
- Keep the existing behavior assertions. Record any remaining process-local
  coordination and its upgrade trigger in the [marker ledger](https://github.com/AiHub-Ecosystem/aihub-be/issues/1732).
