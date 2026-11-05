import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';

const STAMP = 'dist/generated/prisma/.stamp';
const COMPILED_CLIENT = 'dist/generated/prisma/client.js';

type Mode = 'plain' | 'runtime';
type Plan = 'skip' | 'compile' | 'generate';
interface Stamp {
  readonly hash: string;
  readonly mode: Mode;
}
interface PlanInput {
  readonly runtime: boolean;
  readonly hash: string;
  readonly stamp: Stamp | undefined;
  readonly hasClientTs: boolean;
  readonly hasClientJs: boolean;
}

const { formatStamp, nextStamp, parseStamp, planGeneration } =
  require('./prisma-client-stamp.cjs') as {
    formatStamp: (stamp: Stamp) => string;
    nextStamp: (
      plan: Plan,
      runtime: boolean,
      hash: string,
      stamp: Stamp | undefined,
    ) => Stamp | undefined;
    parseStamp: (text: string) => Stamp | undefined;
    planGeneration: (input: PlanInput) => Plan;
  };

const HASH = 'a'.repeat(64);

/** The generator's state on disk between two gate steps of `verify`. */
interface Disk {
  stamp: Stamp | undefined;
  hasClientTs: boolean;
  hasClientJs: boolean;
}

/** Runs the plan the generator would run and applies its effect to the disk. */
function runGate(disk: Disk, runtime: boolean, hash = HASH): Plan {
  const plan = planGeneration({
    runtime,
    hash,
    stamp: disk.stamp,
    hasClientTs: disk.hasClientTs,
    hasClientJs: disk.hasClientJs,
  });
  if (plan === 'generate') {
    disk.hasClientTs = true;
    disk.hasClientJs = false;
  }
  if (runtime && plan !== 'skip') {
    disk.hasClientJs = true;
  }
  disk.stamp = nextStamp(plan, runtime, hash, disk.stamp);
  return plan;
}

const emptyDisk = (): Disk => ({
  stamp: undefined,
  hasClientTs: false,
  hasClientJs: false,
});

describe('prisma client stamp', () => {
  it('round-trips a stamp and refuses an unmoded legacy stamp', () => {
    expect(parseStamp(formatStamp({ hash: HASH, mode: 'runtime' }))).toEqual({
      hash: HASH,
      mode: 'runtime',
    });
    expect(parseStamp(`${HASH}\n`)).toBeUndefined();
    expect(parseStamp(`${HASH} sideways\n`)).toBeUndefined();
    expect(parseStamp('')).toBeUndefined();
  });

  it.each([
    ['plain', false],
    ['runtime', true],
  ])('generates a %s request with no stamp', (_name, runtime) => {
    expect(runGate(emptyDisk(), runtime)).toBe('generate');
  });

  it('generates when the inputs changed or the sources are gone', () => {
    const disk = emptyDisk();
    runGate(disk, true);

    expect(runGate(disk, false, 'b'.repeat(64))).toBe('generate');
    disk.hasClientTs = false;
    expect(runGate(disk, false, 'b'.repeat(64))).toBe('generate');
  });

  it('plain then runtime generates once and only compiles the second time', () => {
    const disk = emptyDisk();

    expect([runGate(disk, false), runGate(disk, true)]).toEqual([
      'generate',
      'compile',
    ]);
    expect(runGate(disk, true)).toBe('skip');
  });

  it('runtime then plain generates once and the plain run changes nothing', () => {
    const disk = emptyDisk();

    expect([runGate(disk, true), runGate(disk, false)]).toEqual([
      'generate',
      'skip',
    ]);
    expect(disk.stamp).toEqual({ hash: HASH, mode: 'runtime' });
    expect(runGate(disk, true)).toBe('skip');
  });

  it('compiles a runtime stamp whose compiled client is missing', () => {
    const disk = emptyDisk();
    runGate(disk, true);
    disk.hasClientJs = false;

    expect(runGate(disk, true)).toBe('compile');
  });

  it('runs a verify-shaped gate sequence with one generation', () => {
    const disk = emptyDisk();
    // knip, lint, type-check (plain), then test and build (runtime), then a
    // second lint and type-check (plain) before the build gate again.
    const plans = [false, false, false, true, true, false, false, true].map(
      (runtime) => runGate(disk, runtime),
    );

    expect(plans.filter((plan) => plan === 'generate')).toHaveLength(1);
    expect(plans.filter((plan) => plan === 'compile')).toHaveLength(1);
    expect(plans.filter((plan) => plan === 'skip')).toHaveLength(6);
  });
});

describe('generate-prisma-client fast path', () => {
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ['scripts/generate/generate-prisma-client.mjs', ...args],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

  it('skips regeneration on a consecutive run with unchanged inputs', () => {
    run('--runtime');
    const second = run('--runtime');
    expect(second.stdout + second.stderr).toMatch(/skipping regeneration/);
    expect(second.status).toBe(0);
  });

  it('compiles over plain outputs without running prisma generate', () => {
    run('--runtime');
    const [hash] = readFileSync(STAMP, 'utf8').split(' ');
    writeFileSync(STAMP, `${hash} plain\n`);

    const runtime = run('--runtime');
    const output = runtime.stdout + runtime.stderr;

    expect(runtime.status).toBe(0);
    expect(output).toMatch(/Successfully compiled: \d+ files/);
    expect(output).not.toMatch(/Generated Prisma Client/);
    expect(readFileSync(STAMP, 'utf8')).toBe(`${hash} runtime\n`);
  });

  it('keeps valid runtime outputs when a plain run follows', () => {
    run('--runtime');
    const before = {
      stamp: readFileSync(STAMP, 'utf8'),
      compiledAt: statSync(COMPILED_CLIENT).mtimeMs,
    };
    const plain = run();
    const runtime = run('--runtime');

    // The plain run neither downgrades the stamp nor rewrites the compiled
    // client, so the later runtime run has nothing to redo.
    expect({
      stamp: readFileSync(STAMP, 'utf8'),
      compiledAt: statSync(COMPILED_CLIENT).mtimeMs,
    }).toEqual(before);
    expect(plain.stdout + plain.stderr).toMatch(/skipping regeneration/);
    expect(plain.status).toBe(0);
    expect(runtime.stdout + runtime.stderr).toMatch(/skipping regeneration/);
    expect(runtime.status).toBe(0);
  });
});
