import { isApprovedSpeakingAudioUrl } from './speaking-audio-url.policy';

describe('Speaking audio URL policy', () => {
  it.each([
    'https://storage.wispace.vn/audio/sample.mp3',
    'https://storage.wispace.vn/audio/sample.mp3?signature=abc',
    'https://STORAGE.WISPACE.VN/audio/sample.mp3',
  ])('accepts %s', (url) => {
    expect(isApprovedSpeakingAudioUrl(url)).toBe(true);
  });

  it.each([
    'http://storage.wispace.vn/audio/sample.mp3',
    'https://evil.example/audio/sample.mp3',
    'https://localhost/audio/sample.mp3',
    'https://127.0.0.1/audio/sample.mp3',
    'https://storage.wispace.vn:8443/audio/sample.mp3',
    'https://user:pass@storage.wispace.vn/audio/sample.mp3',
    'https://storage.wispace.vn/audio/sample.mp3#fragment',
    'https://storage.wispace.vn/audio/ sample.mp3',
    'storage.wispace.vn/audio/sample.mp3',
  ])('rejects unsafe URL %s', (url) => {
    expect(isApprovedSpeakingAudioUrl(url)).toBe(false);
  });

  it('rejects URLs longer than the public contract', () => {
    const url = `https://storage.wispace.vn/audio/${'a'.repeat(2_020)}.mp3`;
    expect(isApprovedSpeakingAudioUrl(url)).toBe(false);
  });
});
