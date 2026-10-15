import { isAllowedTask1ImageUrl } from './task1-image-url.policy';

describe('Writing Task 1 image URL policy', () => {
  it.each([
    ['HTTP scheme', 'http://charts.example/chart.png'],
    ['userinfo', 'https://user:pass@charts.example/chart.png'],
    ['empty userinfo', 'https://@charts.example/chart.png'],
    ['non-default port', 'https://charts.example:8443/chart.png'],
    ['private IPv4', 'https://10.0.0.5/chart.png'],
    ['loopback IPv4', 'https://127.0.0.1/chart.png'],
    ['short IPv4 loopback form', 'https://127.1/chart.png'],
    ['hex IPv4 loopback form', 'https://0x7f000001/chart.png'],
    ['integer IPv4 loopback form', 'https://2130706433/chart.png'],
    ['octal IPv4 loopback form', 'https://0177.0.0.1/chart.png'],
    ['link-local IPv4', 'https://169.254.169.254/latest/meta-data/'],
    ['multicast IPv4', 'https://224.0.0.1/chart.png'],
    ['unspecified IPv4', 'https://0.0.0.0/chart.png'],
    ['reserved IPv4', 'https://240.0.0.1/chart.png'],
    ['documentation IPv4', 'https://192.0.2.1/chart.png'],
    ['loopback IPv6', 'https://[::1]/chart.png'],
    ['unspecified IPv6', 'https://[::]/chart.png'],
    ['IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/chart.png'],
    ['unique-local IPv6', 'https://[fc00::1]/chart.png'],
    ['link-local IPv6', 'https://[fe80::1]/chart.png'],
    ['multicast IPv6', 'https://[ff02::1]/chart.png'],
    ['documentation IPv6', 'https://[2001:db8::1]/chart.png'],
    ['reserved IPv6', 'https://[2002::1]/chart.png'],
    ['unsupported scheme', 'file:///etc/passwd'],
    ['oversized URL', `https://charts.example/${'a'.repeat(2_000)}`],
    ['URL with whitespace', 'https://charts.example/chart image.png'],
  ])('rejects %s', (_description, value) => {
    expect(isAllowedTask1ImageUrl(value)).toBe(false);
  });

  it.each([
    'https://cdn.example/chart.png',
    'HTTPS://cdn.example/chart.png',
    'https://cdn.example:443/chart.png',
    'https://8.8.8.8/chart.png',
    'https://[2001:4860:4860::8888]/chart.png',
  ])('accepts public URL %s without resolving DNS', (value) => {
    expect(isAllowedTask1ImageUrl(value)).toBe(true);
  });
});
