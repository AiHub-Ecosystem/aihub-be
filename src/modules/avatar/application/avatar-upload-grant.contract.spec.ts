import { avatarUploadGrantContract } from '@/modules/avatar/testing/avatar.contract';
import { InMemoryAvatarRepository } from '@/modules/avatar/testing/in-memory-avatar.repository';

avatarUploadGrantContract(
  () => new InMemoryAvatarRepository(),
  async () => {},
);
