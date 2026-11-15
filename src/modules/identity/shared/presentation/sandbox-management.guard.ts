import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';

import { AppError } from '@/common/errors/app-error';
import {
  type RuntimeConfiguration,
  appConfig,
} from '@/config/runtime-configuration';

@Injectable()
export class SandboxManagementGuard implements CanActivate {
  constructor(
    @Inject(appConfig.KEY)
    private readonly configuration: Pick<
      RuntimeConfiguration,
      'AIHUB_RUNTIME_DATABASE_SCOPE'
    >,
  ) {}

  canActivate(_context: ExecutionContext): boolean {
    if (this.configuration.AIHUB_RUNTIME_DATABASE_SCOPE === 'sandbox') {
      throw new AppError({
        code: 'ENVIRONMENT_NOT_ALLOWED',
        message: 'Organization management is not available in this environment',
        retryable: false,
      });
    }
    return true;
  }
}
