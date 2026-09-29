export function postgresOperationName(queryText: string): string {
  return /^\s*([A-Za-z]+)/.exec(queryText)?.[1]?.toUpperCase() ?? 'QUERY';
}

export function redisOperationName(commandName: string): string {
  return commandName.toUpperCase();
}

export function downstreamUrlAttributes(origin: string, path: string) {
  const url = new URL(path, origin);
  return {
    'url.full': `${url.origin}${url.pathname}`,
    'url.query': '',
  };
}
