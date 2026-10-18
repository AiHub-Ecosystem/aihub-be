import { avatarRepositoryContract } from '@/modules/avatar/testing/avatar.contract';
import { InMemoryAvatarRepository } from '@/modules/avatar/testing/in-memory-avatar.repository';

avatarRepositoryContract(
  () => new InMemoryAvatarRepository(),
  async () => {},
);
