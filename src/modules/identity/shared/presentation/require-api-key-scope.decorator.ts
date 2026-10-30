import { SetMetadata } from '@nestjs/common';

export const REQUIRED_API_KEY_SCOPE_METADATA = 'aihub:required-api-key-scope';

export function RequireApiKeyScope(scope: string): MethodDecorator {
  return SetMetadata(REQUIRED_API_KEY_SCOPE_METADATA, scope);
}
