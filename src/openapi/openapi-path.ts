/**
 * Renders a Nest route path in OpenAPI form: `:organizationId` becomes
 * `{organization_id}`.
 *
 * The two spellings are not interchangeable — a generated client that sends a
 * literal `organization_id` segment receives a 404 from the Nest route — so the
 * Public API Route registry stores the Nest form that a route declaration can
 * bind directly, and the document derives this one from it.
 */
export function toOpenApiPath(nestPath: string): string {
  return nestPath
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? `{${toSnakeCase(segment.slice(1))}}` : segment,
    )
    .join('/');
}

function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
