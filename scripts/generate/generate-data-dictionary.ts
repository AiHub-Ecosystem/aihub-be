import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const schemaPath = resolve(process.cwd(), 'prisma/schema.prisma');
const outPath = resolve(
  process.cwd(),
  process.argv[2] ?? 'docs/data-dictionary.md',
);

const schema = readFileSync(schemaPath, 'utf8');

interface Field {
  name: string;
  type: string;
  attributes: string;
}

interface Model {
  name: string;
  owner: string;
  fields: Field[];
}

const models: Model[] = [];
const lines = schema.split(/\r?\n/);
let i = 0;
while (i < lines.length) {
  // collect doc comments preceding model
  const docLines: string[] = [];
  while (i < lines.length && /^\s*\/\/\//.test(lines[i] ?? '')) {
    docLines.push((lines[i] ?? '').replace(/^\s*\/\/\/\s?/, ''));
    i += 1;
  }
  const modelMatch = /^\s*model\s+(\w+)\s*\{/.exec(lines[i] ?? '');
  if (!modelMatch) {
    i += 1;
    continue;
  }
  const name = modelMatch[1];
  const ownerLine = docLines.find(
    (l) => /@owner\s+\w+/.test(l) || /^owner:\s*\w+/.test(l),
  );
  const ownerMatch = ownerLine?.match(/(?:@owner|owner:)\s*(\w+)/);
  const owner = ownerMatch ? ownerMatch[1] : 'unknown';
  i += 1;
  const fields: Field[] = [];
  while (i < lines.length && !/^\s*\}/.test(lines[i] ?? '')) {
    const line = (lines[i] ?? '').trim();
    if (line && !line.startsWith('//') && !line.startsWith('@@')) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        fields.push({
          name: parts[0] ?? '',
          type: parts[1] ?? '',
          attributes: parts.slice(2).join(' '),
        });
      }
    }
    i += 1;
  }
  i += 1; // skip closing brace
  models.push({ name: name ?? '', owner: owner ?? 'unknown', fields });
}

const out: string[] = [];
out.push('# Data dictionary');
out.push('');
out.push(
  'Generated from `prisma/schema.prisma`. Do not edit by hand; run `bun run generate:data-dictionary`.',
);
out.push('');
out.push('## Tables');
out.push('');
out.push('| Table (model) | Owner | Columns |');
out.push('| --- | --- | --- |');
for (const m of models) {
  out.push(`| ${m.name} | ${m.owner} | ${m.fields.length} |`);
}
out.push('');
for (const m of models) {
  out.push(`## ${m.name}`);
  out.push('');
  out.push(`Owner: \`${m.owner}\``);
  out.push('');
  out.push('| Column | Type | Attributes |');
  out.push('| --- | --- | --- |');
  for (const f of m.fields) {
    out.push(`| ${f.name} | ${f.type} | ${f.attributes} |`);
  }
  out.push('');
}

// ... after writeFileSync
writeFileSync(outPath, out.join('\n'));
execFileSync(
  process.execPath,
  [
    createRequire(import.meta.url).resolve('prettier/bin/prettier.cjs'),
    '--write',
    outPath,
  ],
  { stdio: 'inherit' },
);
console.log(`wrote ${outPath} (${models.length} models)`);
