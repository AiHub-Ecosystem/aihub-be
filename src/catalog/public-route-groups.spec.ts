import { servedRouteShapes } from '../../test/support/route-handler-statuses';
import { OPERATION_CATALOG } from './operation-catalog';
import { OPERATION_IDS, isOperationId } from './operation-id';
import { PUBLIC_ROUTES, isPublicRouteId } from './public-routes';
import {
  AUTH_PUBLIC_ROUTES,
  WEB_SESSION_PUBLIC_ROUTES,
} from './public-routes/auth';
import {
  AVATAR_PUBLIC_ROUTES,
  ME_PUBLIC_ROUTES,
  SANDBOX_PUBLIC_ROUTES,
} from './public-routes/identity';
import { ORGANIZATION_CONTROL_PUBLIC_ROUTES } from './public-routes/organization-control';
import { ORGANIZATION_MEMBERS_PUBLIC_ROUTES } from './public-routes/organization-members';
import { REFERENCE_PUBLIC_ROUTES } from './public-routes/reference';
import { SPEAKING_PUBLIC_ROUTES } from './public-routes/speaking';
import { WRITING_PUBLIC_ROUTES } from './public-routes/writing';

const GROUP_ROUTES = [
  REFERENCE_PUBLIC_ROUTES,
  SPEAKING_PUBLIC_ROUTES,
  WRITING_PUBLIC_ROUTES,
  AVATAR_PUBLIC_ROUTES,
  ORGANIZATION_MEMBERS_PUBLIC_ROUTES,
  ORGANIZATION_CONTROL_PUBLIC_ROUTES,
  AUTH_PUBLIC_ROUTES,
  ME_PUBLIC_ROUTES,
  WEB_SESSION_PUBLIC_ROUTES,
  SANDBOX_PUBLIC_ROUTES,
] as const;

/** Independent snapshot of the declared public routes, in document order. */
const EXPECTED_PUBLIC_ROUTE_IDS = [
  'speaking.questions',
  'writing.v2.task1.templates',
  'writing.v2.task2.templates',
  'speaking.v2.library',
  'listening.v2.tests',
  'reading.v2.tests',
  'speaking.gradingJobs.create',
  'speaking.gradingJobs.get',
  'speaking.audioUploads.create',
  'speaking.audioUploads.refresh',
  'speaking.audioUploads.complete',
  'writing.chartUploads.create',
  'writing.chartUploads.refresh',
  'writing.chartUploads.complete',
  'me.avatar.uploads.create',
  'me.avatar.uploads.complete',
  'me.avatar.read',
  'me.avatar.remove',
  'organizations.create',
  'organizations.rename',
  'organizations.me.members.list',
  'organizations.members.list',
  'organizations.invitations.list',
  'organizations.invitations.create',
  'organizations.invitations.revoke',
  'organizations.invitations.accept',
  'organizations.members.change_role',
  'organizations.members.disable',
  'organizations.members.transfer',
  'organizations.apiKeys.list',
  'organizations.apiKeys.create',
  'organizations.apiKeys.revoke',
  'organizations.apiKeys.rotate',
  'organizations.identityConfig.set',
  'organizations.identityConfig.read',
  'organizations.auditEvents.list',
  'auth.register',
  'auth.login',
  'auth.mfa.enrollment',
  'auth.mfa.enrollment.confirm',
  'auth.mfa.remove',
  'auth.verify_email',
  'auth.resend_verification',
  'auth.forgot_password',
  'auth.reset_password',
  'auth.change_password',
  'auth.refresh',
  'auth.logout',
  'auth.user_access_tokens.revoke',
  'me.profile.read',
  'auth.web_sessions.create',
  'auth.web_sessions.verification',
  'auth.web_sessions.exchange',
  'auth.web_sessions.logout',
  'sandbox.assertions.mint',
  'sandbox.demo-key.validate',
] as const;

describe('public route registry groups', () => {
  it('splits into groups with no id declared twice', () => {
    const ids = GROUP_ROUTES.flatMap((group) => Object.keys(group));

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(EXPECTED_PUBLIC_ROUTE_IDS);
  });

  it('keeps every declared public route in the exported registry, in order', () => {
    expect(Object.keys(PUBLIC_ROUTES)).toEqual(EXPECTED_PUBLIC_ROUTE_IDS);
  });

  it('rejects an id declared in both the Operation Catalog and the public registry', () => {
    expect(OPERATION_IDS.filter(isPublicRouteId)).toEqual([]);
    expect(Object.keys(PUBLIC_ROUTES).filter(isOperationId)).toEqual([]);
  });

  it('covers every controller-served public route exactly once', () => {
    const declared = [
      ...Object.values(PUBLIC_ROUTES),
      ...Object.values(OPERATION_CATALOG),
    ].map(
      (route) => `${route.method} ${route.path.replace(/\{([^}]+)\}/g, ':$1')}`,
    );
    const duplicates = declared.filter(
      (shape, index) => declared.indexOf(shape) !== index,
    );
    const servedPublic = servedRouteShapes().filter((shape) =>
      / \/v[1-9][0-9]*\//.test(shape),
    );
    const undeclared = servedPublic.filter(
      (shape) => !declared.includes(shape),
    );

    expect(duplicates).toEqual([]);
    expect(undeclared).toEqual([]);
  });
});
