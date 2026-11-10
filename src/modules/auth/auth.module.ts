import { Module } from '@nestjs/common';
import { AccountsController } from './accounts/presentation/accounts.controller';
import { LocalCredentialsModule } from './auth-local-credentials.module';
import { AuthRuntimeModule } from './auth-runtime.module';

@Module({
  controllers: [AccountsController],
  imports: [AuthRuntimeModule, LocalCredentialsModule],
  exports: [AuthRuntimeModule, LocalCredentialsModule],
})
export class AuthModule {}
