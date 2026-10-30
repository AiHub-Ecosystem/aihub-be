export function pushPathPatterns(workflow: string): string[];
export function matchesPushFilter(path: string, patterns: string[]): boolean;
export function pushRunsCi(changedFiles: string[], patterns: string[]): boolean;
