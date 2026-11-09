import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import tsModule from 'typescript';

const ts = /** @type {typeof import('typescript')} */ (tsModule);

/**
 * #1788: `.claude/rules/security.md` and `AGENTS.md` state that AIHUB never
 * logs API keys, key hashes, signed user assertions, internal JWTs, essay
 * text, raw request bodies, or raw downstream bodies, and that redaction
 * happens before logging. No other gate enforced that, so the rule held only
 * as long as review caught a regression. This check reads the same source
 * text every other source rule reads and fails a logging call whose argument
 * carries a secret-bearing identifier, unless the call site says why with a
 * `redact-ok: <reason>` marker - the same escape shape `arch-check:` uses.
 *
 * The check is syntactic on purpose: it names identifiers, not taint. A false
 * positive is cheap - rename the value, pass a redaction helper, or annotate
 * the line - and a missed taint path is exactly what CodeQL tracks instead.
 */

/** The log methods every in-scope receiver shares: Nest's Logger, pino, console. */
const LOG_METHODS = new Set([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'log',
  'verbose',
]);

/** The named identifiers the issue lists verbatim, compared lowercased. */
const SECRET_IDENTIFIERS = new Set([
  'apikey',
  'keyhash',
  'password',
  'assertion',
  'assertions',
  'internaltoken',
  'sessiontoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'essaytext',
  'rawbody',
  'userassertion',
]);

/**
 * The final scope, documented here as the issue asks the PR to do:
 *
 * - the named list above, plus the analogues below;
 * - anything ending in `token` (access, session, internal, refresh, bearer);
 * - anything ending in `assertion` or `assertions`;
 * - anything containing `password`, `cookie`, or `authorization`;
 * - `apiKey` itself and anything ending in `apiKey` or `keyHash`, so a hash of
 *   a key is caught as firmly as the key (AGENTS.md names the hashes too);
 * - `secretKey` and `signingKey` endings;
 * - anything ending in `body`, and a `.body` property access, so `rawBody`,
 *   `requestBody`, `responseBody`, `request.body` and `response.body` all land.
 *
 * `apiKeyId` stays out on purpose: the boundary check on it is a substring
 * match, and an identifier *about* a key is not the key.
 * @param {string} text
 * @returns {boolean}
 */
function isSecretIdentifier(text) {
  const name = text.toLowerCase();
  if (SECRET_IDENTIFIERS.has(name)) return true;
  if (name.endsWith('token')) return true;
  if (name.endsWith('assertion') || name.endsWith('assertions')) return true;
  if (name.includes('password')) return true;
  if (name.includes('cookie') || name.includes('authorization')) return true;
  if (name === 'apikey' || name.endsWith('apikey')) return true;
  if (name.endsWith('keyhash')) return true;
  if (name.endsWith('secretkey') || name.endsWith('signingkey')) return true;
  if (name.endsWith('essaytext')) return true;
  if (name.endsWith('body')) return true;
  return false;
}

/**
 * The receivers in scope, read from the receiver's own source text: pino
 * loggers (`this.logger`, `request.log`), `console.*`, Nest's `Logger`,
 * `ConsoleLogger` and `LoggerService`, and any object typed as a logger in
 * `src/common/observability` - which at syntax level means an identifier or
 * property whose name is a logger name. The last dotted segment decides, so
 * `catalog` and `Math` never look like a logger.
 * @param {import('typescript').Node} receiver
 * @param {import('typescript').SourceFile} sourceFile
 * @returns {boolean}
 */
function isLoggerReceiver(receiver, sourceFile) {
  const text = sourceFile.text.slice(
    receiver.getStart(sourceFile),
    receiver.getEnd(),
  );
  const segment = (text.split('.').pop() ?? '').toLowerCase();
  return (
    segment === 'console' ||
    segment === 'log' ||
    segment.endsWith('logger') ||
    segment === 'loggerservice'
  );
}

/** The escape marker, shaped like the `arch-check:` regex the raw-SQL rule uses. */
const REDACT_MARKER = /(?:^|\s)(?:\/\/|\/\*|\*)\s*redact-ok:\s*\S/;

/**
 * The marker must carry a reason on the call's own line, the line after it
 * (the formatter moves a trailing comment down), or the call's closing line,
 * which is where a multi-line call's trailing comment lands.
 * @param {import('typescript').SourceFile} sourceFile
 * @param {import('typescript').Node} call
 * @param {string[]} lines
 * @returns {boolean}
 */
function hasRedactMarker(sourceFile, call, lines) {
  const start = sourceFile.getLineAndCharacterOfPosition(
    call.getStart(sourceFile),
  ).line;
  const end = sourceFile.getLineAndCharacterOfPosition(call.getEnd()).line;
  const candidates = [lines[start + 1]];
  for (let index = start; index <= end; index += 1) {
    candidates.push(lines[index]);
  }
  return candidates.some(
    (candidate) => candidate !== undefined && REDACT_MARKER.test(candidate),
  );
}

/**
 * Secret-bearing identifiers inside one argument: identifier names and
 * property-access names, so `{ keyHash }`, `headers.authorization` and
 * `request.body` are all seen. String literals are never read - a message
 * *about* a key is not the key.
 * @param {import('typescript').Node} argument
 * @returns {string[]}
 */
function secretIdentifiersIn(argument) {
  /** @type {Set<string>} */
  const found = new Set();
  /** @param {import('typescript').Node} node */
  const visit = (node) => {
    if (ts.isIdentifier(node) && isSecretIdentifier(node.text)) {
      found.add(node.text);
    } else if (
      ts.isPropertyAccessExpression(node) &&
      isSecretIdentifier(node.name.text)
    ) {
      found.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(argument);
  return [...found];
}

/** @param {string} directory @returns {string[]} */
function collectTypeScriptFiles(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Every rule decision, in one place and callable without a process. The CLI
 * below runs it over the real tree; a spec passes `files` and `readSource` to
 * check a fixture held in memory.
 *
 * Spec and testing code may assert on captured log output, so `*.spec.ts` and
 * `*.test.ts` files are out of scope, and so is `src/common/observability`,
 * which constructs the log records themselves.
 *
 * @param {{ root: string, files?: readonly string[], readSource?: (file: string) => string }} options
 * @returns {{ failures: string[] }}
 */
export function collectLogRedactionFailures(options) {
  const { root } = options;
  const readSource =
    options.readSource ?? ((file) => readFileSync(file, 'utf8'));
  const srcDirectory = join(root, 'src');
  const observabilityDirectory = join(srcDirectory, 'common', 'observability');
  const allFiles = options.files ?? collectTypeScriptFiles(srcDirectory);
  const sourceFiles = allFiles.filter(
    (file) =>
      file.startsWith(`${srcDirectory}${sep}`) &&
      !file.endsWith('.spec.ts') &&
      !file.endsWith('.test.ts') &&
      !file.startsWith(`${observabilityDirectory}${sep}`),
  );
  /** @type {string[]} */
  const failures = [];

  for (const file of sourceFiles) {
    const source = readSource(file);
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const lines = source.split(/\r?\n/);

    /** @param {import('typescript').Node} node */
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        LOG_METHODS.has(node.expression.name.text) &&
        isLoggerReceiver(node.expression.expression, sourceFile) &&
        !hasRedactMarker(sourceFile, node, lines)
      ) {
        /** @type {string[]} */
        const offenders = [];
        for (const argument of node.arguments) {
          for (const name of secretIdentifiersIn(argument)) {
            if (!offenders.includes(name)) offenders.push(name);
          }
        }
        if (offenders.length > 0) {
          const line =
            sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
              .line + 1;
          failures.push(
            `${relative(root, file)}:${line} logs ${offenders.join(', ')}; redact before logging, or mark the call with "redact-ok: <reason>"`,
          );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  return { failures };
}

/** Prints each failure as the CLI always did and reports whether any exist. */
/** @param {string[]} failures @returns {boolean} */
function report(failures) {
  for (const message of failures) {
    console.error(`Log redaction check failed: ${message}`);
  }
  return failures.length > 0;
}

function main() {
  const root = process.cwd();
  const { failures } = collectLogRedactionFailures({ root });
  process.exit(report(failures) ? 1 : 0);
}

if (
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
