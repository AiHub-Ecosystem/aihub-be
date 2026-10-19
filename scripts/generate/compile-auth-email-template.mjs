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
const { default: mjml2html } = await import('mjml');
const { html, errors } = await mjml2html(await readFile(templatePath, 'utf8'), {
  filePath: templatePath,
  validationLevel: 'strict',
});

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
