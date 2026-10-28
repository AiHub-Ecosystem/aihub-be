import { deprecationDateErrors } from './deprecation-dates';

describe('deprecationDateErrors', () => {
  it('allows a past deprecation date before a future sunset', () => {
    expect(
      deprecationDateErrors(
        'legacy.route',
        {
          deprecationAt: '2023-01-01T00:00:00Z',
          sunsetAt: '2027-06-30T00:00:00Z',
        },
        Date.parse('2026-01-01T00:00:00Z'),
      ),
    ).toEqual([]);
  });

  it('rejects a sunset before deprecation', () => {
    expect(
      deprecationDateErrors(
        'legacy.route',
        {
          deprecationAt: '2027-06-30T00:00:00Z',
          sunsetAt: '2027-01-01T00:00:00Z',
        },
        Date.parse('2026-01-01T00:00:00Z'),
      ),
    ).toEqual(['legacy.route: sunsetAt is earlier than deprecationAt.']);
  });
});
