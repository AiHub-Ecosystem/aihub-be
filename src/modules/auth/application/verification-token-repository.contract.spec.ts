import { InMemoryVerificationTokenAdapter } from '@/modules/auth/testing/in-memory-verification-token.adapter';
import { verificationTokenRepositoryContract } from '@/modules/auth/testing/verification-token.contract';

verificationTokenRepositoryContract({
  createRepo: (state) => new InMemoryVerificationTokenAdapter(state),
  reset: (state) => state.reset(),
});
