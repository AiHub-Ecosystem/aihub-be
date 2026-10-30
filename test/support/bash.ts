import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

export function bashExecutable(): string {
  if (process.platform !== 'win32') {
    return 'bash';
  }

  const pathValue = Object.entries(process.env).find(
    ([key]) => key.toLowerCase() === 'path',
  )?.[1];
  const gitPath = pathValue
    ?.split(delimiter)
    .map((directory) => join(directory, 'git.exe'))
    .find(existsSync);
  const gitBash = gitPath
    ? resolve(dirname(gitPath), '..', 'bin', 'bash.exe')
    : undefined;

  return gitBash && existsSync(gitBash) ? gitBash : 'bash';
}
