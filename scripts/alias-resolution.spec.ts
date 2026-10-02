import { AppError } from '@/common/errors/app-error';

// ADR-0067: the alias is resolved by the SWC transform, so an import that stops
// resolving fails at load time here rather than in a hand-run command.
describe('@/ alias', () => {
  it('resolves a module under src through the alias', () => {
    expect(typeof AppError).toBe('function');
  });
});
