import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { appConfig } from '@/config/runtime-configuration';
import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
import { EMAIL_OUTBOX } from '@/modules/auth/email-delivery/application/email-outbox.port';
import { EmailDeliveryModule } from '@/modules/auth/email-delivery/email-delivery.module';
import { AUTH_MFA_SERVICE } from '@/modules/auth/mfa/application/auth-mfa-repository.port';
import { PASSWORD_RESET_TOKEN_REPOSITORY } from '@/modules/auth/password-reset/application/password-reset-token-repository.port';
import { PASSWORD_RESET_TOKEN } from '@/modules/auth/password-reset/application/password-reset-token.port';
import { AUTH_RATE_LIMITER } from '@/modules/auth/rate-limit/application/auth-rate-limiter.port';
import { AUTH_CLOCK } from '@/modules/auth/shared/application/auth-clock';
import { VERIFICATION_TOKEN_REPOSITORY } from '@/modules/auth/verification/application/verification-token-repository.port';
import { VERIFICATION_TOKEN } from '@/modules/auth/verification/application/verification-token.port';
import { REFRESH_SESSION_REPOSITORY } from '@/modules/auth/web-sessions/application/refresh-session-repository.port';
import { REFRESH_TOKEN_ISSUER } from '@/modules/auth/web-sessions/application/refresh-token.port';
import { USER_ACCESS_TOKEN_ISSUER } from '@/modules/auth/web-sessions/application/user-access-token.port';
import { USER_ACCOUNT_REPOSITORY } from './accounts/application/user-account.port';
import { AuthRuntimeModule } from './auth-runtime.module';
import type { CredentialCheckPorts } from './local-credentials/application/local-credentials';
import { LOCAL_REGISTRATION } from './local-credentials/application/local-registration.port';
import { LocalRegistrationService } from './local-credentials/application/local-registration.service';
import { LOCAL_SESSION } from './local-credentials/application/local-session.port';
import { LocalSessionService } from './local-credentials/application/local-session.service';
import { PASSWORD_CHANGE_REPOSITORY } from './local-credentials/application/password-change-repository.port';
import { PASSWORD_CHANGE } from './local-credentials/application/password-change.port';
import { PasswordChangeService } from './local-credentials/application/password-change.service';
import { PASSWORD_HASHER } from './local-credentials/application/password-hasher.port';
import { PASSWORD_RECOVERY } from './local-credentials/application/password-recovery.port';
import { PasswordRecoveryService } from './local-credentials/application/password-recovery.service';
import type { SessionTokenIssuers } from './local-credentials/application/session-token-issuers';
import { LocalAuthController } from './local-credentials/presentation/local-auth.controller';
import { PasswordChangeController } from './local-credentials/presentation/password-change.controller';
import { PasswordResetController } from './password-reset/presentation/password-reset.controller';
import { VerificationController } from './verification/presentation/verification.controller';

const EMAIL_VERIFICATION_REQUIRES_PASSWORD = Symbol(
  'EMAIL_VERIFICATION_REQUIRES_PASSWORD',
);
const CREDENTIAL_CHECK_PORTS = Symbol('CREDENTIAL_CHECK_PORTS');
const SESSION_TOKEN_ISSUERS = Symbol('SESSION_TOKEN_ISSUERS');

@Module({
  imports: [RuntimeConfigurationModule, EmailDeliveryModule, AuthRuntimeModule],
  controllers: [
    LocalAuthController,
    PasswordChangeController,
    PasswordResetController,
    VerificationController,
  ],
  providers: [
    {
      provide: EMAIL_VERIFICATION_REQUIRES_PASSWORD,
      inject: [appConfig.KEY],
      useFactory: (configuration: ConfigType<typeof appConfig>): boolean =>
        configuration.AIHUB_EMAIL_VERIFICATION_REQUIRES_PASSWORD,
    },
    {
      provide: CREDENTIAL_CHECK_PORTS,
      inject: [USER_ACCOUNT_REPOSITORY, PASSWORD_HASHER, AUTH_RATE_LIMITER],
      useFactory: (
        userAccounts: CredentialCheckPorts['userAccounts'],
        passwordHasher: CredentialCheckPorts['passwordHasher'],
        rateLimiter: CredentialCheckPorts['rateLimiter'],
      ): CredentialCheckPorts => ({
        userAccounts,
        passwordHasher,
        rateLimiter,
      }),
    },
    {
      provide: SESSION_TOKEN_ISSUERS,
      inject: [USER_ACCESS_TOKEN_ISSUER, REFRESH_TOKEN_ISSUER],
      useFactory: (
        accessTokens: SessionTokenIssuers['accessTokens'],
        refreshTokens: SessionTokenIssuers['refreshTokens'],
      ): SessionTokenIssuers => ({ accessTokens, refreshTokens }),
    },
    {
      provide: LOCAL_REGISTRATION,
      useFactory: (
        ...ports: ConstructorParameters<typeof LocalRegistrationService>
      ) => new LocalRegistrationService(...ports),
      inject: [
        CREDENTIAL_CHECK_PORTS,
        VERIFICATION_TOKEN_REPOSITORY,
        VERIFICATION_TOKEN,
        EMAIL_OUTBOX,
        SESSION_TOKEN_ISSUERS,
        AUTH_CLOCK,
        EMAIL_VERIFICATION_REQUIRES_PASSWORD,
      ],
    },
    {
      provide: PASSWORD_RECOVERY,
      useFactory: (
        ...ports: ConstructorParameters<typeof PasswordRecoveryService>
      ) => new PasswordRecoveryService(...ports),
      inject: [
        PASSWORD_RESET_TOKEN_REPOSITORY,
        PASSWORD_RESET_TOKEN,
        PASSWORD_HASHER,
        EMAIL_OUTBOX,
        AUTH_RATE_LIMITER,
        AUTH_CLOCK,
      ],
    },
    {
      provide: PASSWORD_CHANGE,
      useFactory: (
        ...ports: ConstructorParameters<typeof PasswordChangeService>
      ) => new PasswordChangeService(...ports),
      inject: [
        USER_ACCOUNT_REPOSITORY,
        PASSWORD_HASHER,
        AUTH_RATE_LIMITER,
        PASSWORD_CHANGE_REPOSITORY,
        AUTH_CLOCK,
      ],
    },
    {
      provide: LOCAL_SESSION,
      useFactory: (
        ...ports: ConstructorParameters<typeof LocalSessionService>
      ) => new LocalSessionService(...ports),
      inject: [
        CREDENTIAL_CHECK_PORTS,
        REFRESH_SESSION_REPOSITORY,
        SESSION_TOKEN_ISSUERS,
        AUTH_CLOCK,
        AUTH_MFA_SERVICE,
      ],
    },
  ],
  exports: [LOCAL_SESSION],
})
export class LocalCredentialsModule {}
