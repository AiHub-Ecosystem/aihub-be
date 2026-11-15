import { parseCustomerWebBaseUrl } from './customer-web-base-url';

describe('parseCustomerWebBaseUrl', () => {
  it.each([
    [
      'https://customer.example.com/app/',
      true,
      'https://customer.example.com/app',
    ],
    [' https://customer.example.com ', true, 'https://customer.example.com'],
    ['http://localhost:3000', false, 'http://localhost:3000'],
  ])('normalizes %p', (value, requireHttps, expected) => {
    expect(parseCustomerWebBaseUrl(value, requireHttps)).toBe(expected);
  });

  it.each([
    ['http://customer.example.com', true],
    ['ftp://customer.example.com', false],
    ['https://user:password@customer.example.com', false],
    ['https://customer.example.com?campaign=welcome', false],
    ['https://customer.example.com#verification', false],
    ['https://customer.example.com?', false],
    ['not a url', false],
    ['   ', false],
  ])('refuses %p', (value, requireHttps) => {
    expect(parseCustomerWebBaseUrl(value, requireHttps)).toBeUndefined();
  });
});
