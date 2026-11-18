/** A template's anchored pattern, for a caller that tests many paths. */
export function compilePathTemplate(template: string): RegExp {
  const pattern = template
    .split('/')
    .map((segment) =>
      /^\{[^/{}]+\}$/.test(segment) || /^:[^/]+$/.test(segment)
        ? '[^/]+'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${pattern}$`);
}

export function matchesPathTemplate(template: string, path: string): boolean {
  return compilePathTemplate(template).test(path);
}
