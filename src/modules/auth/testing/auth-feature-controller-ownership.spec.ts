import { RequestMethod } from '@nestjs/common';
import {
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { AccountsController } from '@/modules/auth/accounts/presentation/accounts.controller';
import { LocalCredentialsModule } from '@/modules/auth/auth-local-credentials.module';
import { AuthRuntimeModule } from '@/modules/auth/auth-runtime.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { LocalAuthController } from '@/modules/auth/local-credentials/presentation/local-auth.controller';
import { PasswordChangeController } from '@/modules/auth/local-credentials/presentation/password-change.controller';
import { MfaController } from '@/modules/auth/mfa/presentation/mfa.controller';
import { PasswordResetController } from '@/modules/auth/password-reset/presentation/password-reset.controller';
import { UserAccessTokenController } from '@/modules/auth/user-access-tokens/presentation/user-access-token.controller';
import { VerificationController } from '@/modules/auth/verification/presentation/verification.controller';

type Controller = new (...args: never[]) => object;
type ControllerModule =
  | typeof AuthRuntimeModule
  | typeof LocalCredentialsModule;

const FEATURE_ROUTE_OWNERS: readonly {
  readonly controller: Controller;
  readonly module: ControllerModule;
  readonly routeIds: readonly (keyof typeof PUBLIC_ROUTES)[];
}[] = [
  {
    controller: MfaController,
    module: AuthRuntimeModule,
    routeIds: [
      'auth.mfa.enrollment',
      'auth.mfa.enrollment.confirm',
      'auth.mfa.remove',
    ],
  },
  {
    controller: PasswordResetController,
    module: LocalCredentialsModule,
    routeIds: ['auth.forgot_password', 'auth.reset_password'],
  },
  {
    controller: VerificationController,
    module: LocalCredentialsModule,
    routeIds: ['auth.verify_email', 'auth.resend_verification'],
  },
  {
    controller: AccountsController,
    module: AuthModule,
    routeIds: ['me.profile.read'],
  },
  {
    controller: UserAccessTokenController,
    module: AuthRuntimeModule,
    routeIds: ['auth.user_access_tokens.revoke'],
  },
  {
    controller: PasswordChangeController,
    module: LocalCredentialsModule,
    routeIds: ['auth.change_password'],
  },
];

function routeIdsOf(controller: Controller): string[] {
  return Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
    const handler = Object.getOwnPropertyDescriptor(controller.prototype, name)
      ?.value as object | undefined;
    if (typeof handler !== 'function') return [];

    const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
    if (typeof path !== 'string' || typeof method !== 'number') return [];

    const [routeId] =
      Object.entries(PUBLIC_ROUTES).find(
        ([, route]) =>
          route.path === path && RequestMethod[route.method] === method,
      ) ?? [];
    if (routeId === undefined) {
      throw new Error(`No catalogue route for ${path}`);
    }
    return [routeId];
  });
}

describe('Auth feature controller ownership', () => {
  it('composes the feature modules into AuthModule', () => {
    const imports: unknown = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      AuthModule,
    );
    expect(imports).toContain(AuthRuntimeModule);
    expect(imports).toContain(LocalCredentialsModule);
  });

  it.each(FEATURE_ROUTE_OWNERS)(
    'registers feature controller for its routes',
    ({ controller, module, routeIds }) => {
      const registered: unknown = Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        module,
      );
      expect(registered).toContain(controller);
      expect(routeIdsOf(controller)).toEqual(expect.arrayContaining(routeIds));
      for (const routeId of routeIds) {
        expect(routeIdsOf(LocalAuthController)).not.toContain(routeId);
      }
    },
  );
});
