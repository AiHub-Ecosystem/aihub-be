import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const templatePath = resolve(
  root,
  'src/modules/auth/email-delivery/application/templates/transactional-email.mjml',
);
const outputPath = resolve(
  root,
  'src/modules/auth/email-delivery/application/templates/transactional-email.template.generated.ts',
);
/** @typedef {(input: string, options: {filePath: string, validationLevel: 'strict'}) => Promise<{html: string, errors: unknown[]}>} MjmlCompiler */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/** @param {unknown} value @returns {value is MjmlCompiler} */
function isMjmlCompiler(value) {
  return typeof value === 'function';
}

const mjmlModule = /** @type {unknown} */ (await import('mjml'));
const compiler = isRecord(mjmlModule) ? mjmlModule.default : undefined;
if (!isMjmlCompiler(compiler)) {
  throw new Error('MJML compiler is unavailable');
}

const compiled = /** @type {unknown} */ (
  await compiler(await readFile(templatePath, 'utf8'), {
    filePath: templatePath,
    validationLevel: 'strict',
  })
);
if (
  !isRecord(compiled) ||
  typeof compiled.html !== 'string' ||
  !Array.isArray(compiled.errors)
) {
  throw new Error('MJML compiler returned an invalid result');
}
const html = compiled.html;
const errors = /** @type {unknown[]} */ (compiled.errors);

if (errors.length > 0) {
  throw new Error(
    `MJML email template validation failed: ${errors.length} error(s)`,
  );
}
if (!html.includes('href="{{url}}"')) {
  throw new Error(
    'MJML compilation did not preserve the URL placeholder in href',
  );
}

await writeFile(
  outputPath,
  `// Generated from transactional-email.mjml by compile-auth-email-template.mjs.\n// biome-ignore format: generated from MJML by the build.\nexport const AUTH_TRANSACTIONAL_EMAIL_TEMPLATE = ${JSON.stringify(html)};\n`,
);
