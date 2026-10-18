import { idempotencyRepositoryContract } from '@/modules/idempotency/testing/idempotency.contract';
import { InMemoryIdempotencyRepository } from '@/modules/idempotency/testing/in-memory-idempotency.repository';

idempotencyRepositoryContract(
  () => new InMemoryIdempotencyRepository(),
  async () => {},
);
