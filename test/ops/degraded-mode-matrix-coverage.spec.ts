import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEGRADED_MODE_PROOF,
  PROSE_OBLIGATIONS,
} from './degraded-mode-matrix-coverage';

const ROOT = resolve(__dirname, '../..');
const MATRIX = resolve(
  ROOT,
  'docs/superpowers/specs/2026-09-07-aihub/14-degraded-mode-matrix.md',
);
const SKIPPED_TEST =
  /\b(?:it|test|describe)\.(?:skip|todo)\(|\bx(?:it|describe)\(/;

/** One id per table row: `<section heading> / <seam and failure cell>`. */
function matrixRows(): string[] {
  let section = '';
  const rows: string[] = [];
  for (const line of readFileSync(MATRIX, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      section = line.slice(3).trim();
      continue;
    }
    if (!line.startsWith('|')) continue;
    const seam = line.split('|')[1]?.trim() ?? '';
    if (seam === 'Seam and failure' || /^-+$/.test(seam)) continue;
    rows.push(`${section} / ${seam}`);
  }
  return rows;
}

/** Whether the spec declares `title` as a whole string literal. */
function declaresTitle(source: string, title: string): boolean {
  return ["'", '"', '`'].some((quote) =>
    source.includes(`${quote}${title}${quote}`),
  );
}

describe('degraded-mode matrix proof map (#2019)', () => {
  const rows = matrixRows();
  const obligations = [...rows, ...PROSE_OBLIGATIONS];

  it('reads every table row of the matrix once', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(obligations).size).toBe(obligations.length);
  });

  it('maps every matrix row and prose obligation to a proof', () => {
    expect(obligations.filter((row) => !(row in DEGRADED_MODE_PROOF))).toEqual(
      [],
    );
  });

  it('keeps no proof for an obligation the matrix no longer has', () => {
    expect(
      Object.keys(DEGRADED_MODE_PROOF).filter(
        (row) => !obligations.includes(row),
      ),
    ).toEqual([]);
  });

  it('points each tested proof at exact titles in specs that skip nothing', () => {
    const broken: string[] = [];
    for (const [row, proof] of Object.entries(DEGRADED_MODE_PROOF)) {
      if (!('tests' in proof)) continue;
      for (const { file, titles } of proof.tests) {
        const path = resolve(ROOT, file);
        const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
        if (SKIPPED_TEST.test(source)) broken.push(`${row} -> ${file}: skips`);
        for (const title of titles) {
          if (!declaresTitle(source, title)) {
            broken.push(`${row} -> ${file}: ${title}`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('gives every proof at least one title or a stated reason', () => {
    const empty = Object.entries(DEGRADED_MODE_PROOF)
      .filter(([, proof]) => {
        if ('tests' in proof) {
          return proof.tests.every(({ titles }) => titles.length === 0);
        }
        const reason = 'untestable' in proof ? proof.untestable : proof.pending;
        return reason.trim() === '';
      })
      .map(([row]) => row);
    expect(empty).toEqual([]);
  });
});
