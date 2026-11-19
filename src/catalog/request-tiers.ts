import type { PublicRouteId } from './public-routes';

/**
 * How the gateway ranks a request when it must shed load (#1591).
 *
 * - `critical`: refusing it cannot save the capacity that is short. Only routes
 *   that merely authenticate, bill, or mint credentials live here.
 * - `standard`: authenticated control-plane work.
 * - `best-effort`: the dispatch that leaves the process. Shed first.
 */
export type RequestTier = 'critical' | 'standard' | 'best-effort';

/**
 * The tier of every public route, beside the registry it describes.
 *
 * Typed as a `Record<PublicRouteId, …>` on purpose: a new route without a tier
 * is a compile error rather than a silent default. `record` keeps the reading
 * order of the registry so a review of both files lines up.
 */
export const PUBLIC_ROUTE_TIERS: Record<PublicRouteId, RequestTier> = {
  'speaking.questions': 'standard',
  'writing.v2.task1.templates': 'standard',
  'writing.v2.task2.templates': 'standard',
  'speaking.v2.library': 'standard',
  'listening.v2.tests': 'standard',
  'reading.v2.tests': 'standard',
  'speaking.gradingJobs.create': 'standard',
  'speaking.gradingJobs.get': 'standard',
  'speaking.audioUploads.create': 'standard',
  'speaking.audioUploads.refresh': 'standard',
  'speaking.audioUploads.complete': 'standard',
  'writing.chartUploads.create': 'standard',
  'writing.chartUploads.refresh': 'standard',
  'writing.chartUploads.complete': 'standard',
  'me.avatar.uploads.create': 'standard',
  'me.avatar.uploads.complete': 'standard',
  'me.avatar.read': 'standard',
  'me.avatar.remove': 'standard',
  'organizations.create': 'critical',
  'organizations.rename': 'critical',
  'organizations.me.members.list': 'critical',
  'organizations.members.list': 'critical',
  'organizations.invitations.list': 'critical',
  'organizations.invitations.create': 'critical',
  'organizations.invitations.revoke': 'critical',
  'organizations.invitations.accept': 'critical',
  'organizations.members.change_role': 'critical',
  'organizations.members.disable': 'critical',
  'organizations.members.transfer': 'critical',
  'organizations.apiKeys.list': 'critical',
  'organizations.apiKeys.create': 'critical',
  'organizations.apiKeys.revoke': 'critical',
  'organizations.apiKeys.rotate': 'critical',
  'organizations.identityConfig.set': 'critical',
  'organizations.identityConfig.read': 'critical',
  'organizations.auditEvents.list': 'critical',
  'auth.register': 'critical',
  'auth.login': 'critical',
  'auth.mfa.enrollment': 'critical',
  'auth.mfa.enrollment.confirm': 'critical',
  'auth.mfa.remove': 'critical',
  'auth.verify_email': 'critical',
  'auth.resend_verification': 'critical',
  'auth.forgot_password': 'critical',
  'auth.reset_password': 'critical',
  'auth.change_password': 'critical',
  'auth.refresh': 'critical',
  'auth.logout': 'critical',
  'auth.user_access_tokens.revoke': 'critical',
  'me.profile.read': 'critical',
  'auth.web_sessions.create': 'critical',
  'auth.web_sessions.verification': 'critical',
  'auth.web_sessions.exchange': 'critical',
  'auth.web_sessions.logout': 'critical',
  'sandbox.assertions.mint': 'critical',
  'sandbox.demo-key.validate': 'critical',
};
