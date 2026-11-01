export function matchesPathTemplate(template: string, path: string): boolean {
  const pattern = template
    .split('/')
    .map((segment) =>
      /^\{[^/{}]+\}$/.test(segment) || /^:[^/]+$/.test(segment)
        ? '[^/]+'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${pattern}$`).test(path);
}
