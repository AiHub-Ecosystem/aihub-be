import { isApprovedSpeakingAudioUrl } from './speaking-audio-url.policy';

const options = {
  organizationId: 'org_acme',
  audioAssetBucket: 'aihub-speaking-recordings',
  sampleBucket: 'aihub-speaking-samples',
} as const;

const ownAsset =
  'https://s3.wispace.app/aihub-speaking-recordings/orgs/org_acme/speaking/aud_01ARZ3NDEKTSV4RRFFQ69G5FAV/original';

describe('Speaking audio URL policy', () => {
  it.each([
    ownAsset,
    `${ownAsset}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc%2Fdef`,
    'https://s3.wispace.app/ielts-task1/speaking-answers/part-1/do-you-enjoy-living-in-your-city-or-hometown.webm',
    'https://s3.wispace.app/aihub-speaking-samples/speaking-samples/part-1/sample.webm?X-Amz-Signature=abc%2Fdef',
    ownAsset.replace('s3.wispace.app', 'S3.WISPACE.APP'),
  ])('accepts approved URL family %s', (url) => {
    expect(isApprovedSpeakingAudioUrl(url, options)).toEqual({
      approved: true,
    });
  });

  it.each([
    [
      'https://s3.wispace.app/aihub-speaking-recordings/orgs/org_other/speaking/aud_01ARZ3NDEKTSV4RRFFQ69G5FAV/original',
      'foreign_tenant',
    ],
    [
      'https://s3.wispace.app/aihub-user-assets/orgs/org_acme/avatar.webp',
      'unapproved_bucket',
    ],
    [
      'https://s3.wispace.app/other-bucket/orgs/org_acme/audio.mp3',
      'unapproved_bucket',
    ],
    [
      'https://s3.wispace.app/aihub-speaking-recordings/orgs/org_acme/audio.mp3',
      'unapproved_bucket',
    ],
    [
      'https://s3.wispace.app/aihub-speaking-recordings/orgs/org_acme/../org_other/speaking/aud_01ARZ3NDEKTSV4RRFFQ69G5FAV/original',
      'traversal',
    ],
    [
      'https://s3.wispace.app/aihub-speaking-recordings/orgs/org_acme/%2e%2e/org_other/speaking/aud_01ARZ3NDEKTSV4RRFFQ69G5FAV/original',
      'traversal',
    ],
    [
      'https://s3.wispace.app/aihub-speaking-recordings/orgs/org_acme%2f..%2forg_other/speaking/aud_01ARZ3NDEKTSV4RRFFQ69G5FAV/original',
      'traversal',
    ],
    [
      'https://s3.wispace.app/aihub-speaking-recordings/orgs/org_acme\\..\\org_other/speaking/aud_01ARZ3NDEKTSV4RRFFQ69G5FAV/original',
      'traversal',
    ],
    [
      'https://s3.wispace.app//aihub-speaking-recordings/orgs/org_acme/speaking/aud_01ARZ3NDEKTSV4RRFFQ69G5FAV/original',
      'traversal',
    ],
    [
      'https://s3.wispace.app.evil.example/aihub-speaking-recordings/orgs/org_acme/speaking/aud_01ARZ3NDEKTSV4RRFFQ69G5FAV/original',
      'malformed',
    ],
    [
      'https://s3.wispace.app:8443/aihub-speaking-recordings/orgs/org_acme/speaking/aud_01ARZ3NDEKTSV4RRFFQ69G5FAV/original',
      'malformed',
    ],
    [
      'https://user:pass@s3.wispace.app/aihub-speaking-recordings/orgs/org_acme/speaking/aud_01ARZ3NDEKTSV4RRFFQ69G5FAV/original',
      'malformed',
    ],
    [
      'https://s3.wispace.app/aihub-speaking-recordings/orgs/org_acme/speaking/aud_01ARZ3NDEKTSV4RRFFQ69G5FAV/original#fragment',
      'malformed',
    ],
    [
      'http://s3.wispace.app/aihub-speaking-recordings/orgs/org_acme/speaking/aud_01ARZ3NDEKTSV4RRFFQ69G5FAV/original',
      'malformed',
    ],
    [
      'https://evil.example/aihub-speaking-recordings/orgs/org_acme/speaking/aud_01ARZ3NDEKTSV4RRFFQ69G5FAV/original',
      'malformed',
    ],
    [
      `https://s3.wispace.app/aihub-speaking-recordings/${'a'.repeat(2_050)}`,
      'malformed',
    ],
  ] as const)('rejects URL with bounded reason %s', (url, reason) => {
    expect(isApprovedSpeakingAudioUrl(url, options)).toEqual({
      approved: false,
      reason,
    });
  });
});
