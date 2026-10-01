type Severity = 'error' | 'warn' | 'info' | 'ignore';

type PathMatcher = string | string[];

type Rule = {
  name: string;
  severity: Severity;
  comment?: string;
  from: { path?: PathMatcher; pathNot?: PathMatcher };
  to: { path?: PathMatcher; pathNot?: PathMatcher };
};

declare const config: {
  forbidden: Rule[];
};

export = config;
