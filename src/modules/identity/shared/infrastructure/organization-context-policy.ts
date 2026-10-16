import type { RequestContext } from '@/common/request-context/request-context';

export type OrganizationContextPolicy =
  | { readonly kind: 'required'; readonly organizationId: string }
  | { readonly kind: 'optional'; readonly organizationId: string }
  | { readonly kind: 'forbidden' };

export function isOrganizationContextAllowed(
  context: RequestContext,
  policy: OrganizationContextPolicy,
): boolean {
  switch (policy.kind) {
    case 'required':
      return context.organizationId === policy.organizationId;
    case 'optional':
      return (
        context.organizationId === undefined ||
        context.organizationId === policy.organizationId
      );
    case 'forbidden':
      return context.organizationId === undefined;
  }
}
