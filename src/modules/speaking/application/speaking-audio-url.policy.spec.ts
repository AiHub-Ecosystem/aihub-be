import { isApprovedSpeakingAudioUrl } from './speaking-audio-url.policy';

describe('Speaking audio URL policy', () => {
  it.each([
    'https://s3.wispace.app/audio/sample.mp3',
    'https://s3.wispace.app/audio/sample.mp3?signature=abc',
    'https://S3.WISPACE.APP/audio/sample.mp3',
  ])('accepts %s', (url) => {
    expect(isApprovedSpeakingAudioUrl(url)).toBe(true);
  });

  it.each([
    'http://s3.wispace.app/audio/sample.mp3',
    'https://storage.wispace.vn/audio/sample.mp3',
    'https://evil.example/audio/sample.mp3',
    'https://localhost/audio/sample.mp3',
    'https://127.0.0.1/audio/sample.mp3',
    'https://s3.wispace.app:8443/audio/sample.mp3',
    'https://user:pass@s3.wispace.app/audio/sample.mp3',
    'https://s3.wispace.app/audio/sample.mp3#fragment',
    'https://s3.wispace.app/audio/ sample.mp3',
    's3.wispace.app/audio/sample.mp3',
  ])('rejects unsafe URL %s', (url) => {
    expect(isApprovedSpeakingAudioUrl(url)).toBe(false);
  });

  it('rejects URLs longer than the public contract', () => {
    const url = `https://s3.wispace.app/audio/${'a'.repeat(2_020)}.mp3`;
    expect(isApprovedSpeakingAudioUrl(url)).toBe(false);
  });
});
