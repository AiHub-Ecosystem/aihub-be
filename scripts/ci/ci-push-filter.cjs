/**
 * The path filter of the CI `push` trigger, read from the workflow file. CD
 * asks it whether a later commit on `main` will get a CI run, and the filter's
 * own spec asks it the same question, so both read one implementation.
 */

/** @param {string} workflow @returns {string[]} */
function pushPathPatterns(workflow) {
  const lines = workflow.split(/\r?\n/);
  const pushIndex = lines.findIndex((line) => line === '  push:');
  const pathsIndex = lines.findIndex(
    (line, index) => index > pushIndex && line === '    paths:',
  );
  if (pushIndex < 0 || pathsIndex < 0) {
    throw new Error('CI push path filter is missing');
  }

  /** @type {string[]} */
  const patterns = [];
  for (const line of lines.slice(pathsIndex + 1)) {
    const match = /^      - "([^"]+)"$/.exec(line);
    if (match?.[1] === undefined) break;
    patterns.push(match[1]);
  }
  return patterns;
}

/** @param {string} pattern @param {string} path */
function patternMatches(pattern, path) {
  if (pattern === '**') return true;
  if (pattern === '*.md') return !path.includes('/') && path.endsWith('.md');
  if (pattern === '**/*.md') return path.endsWith('.md');
  if (pattern === '.claude/**') return path.startsWith('.claude/');
  return pattern === path;
}

/** The last matching pattern wins, as GitHub applies a `!` exclusion. @param {string} path @param {string[]} patterns */
function matchesPushFilter(path, patterns) {
  let included = false;
  for (const pattern of patterns) {
    const excluded = pattern.startsWith('!');
    if (patternMatches(excluded ? pattern.slice(1) : pattern, path)) {
      included = !excluded;
    }
  }
  return included;
}

/** @param {string[]} changedFiles @param {string[]} patterns */
function pushRunsCi(changedFiles, patterns) {
  return changedFiles.some((file) => matchesPushFilter(file, patterns));
}

module.exports = { matchesPushFilter, pushPathPatterns, pushRunsCi };
