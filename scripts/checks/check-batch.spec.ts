import { readFileSync } from 'node:fs';

// Reached through require because the module under test is plain CommonJS run by
// node, the same shape host-job-image-check.spec.ts uses.
const {
  BATCHED_GATES,
  BYTES_PER_CHILD,
  MAX_CONCURRENCY,
  concurrencyFor,
  runBatch,
} = require('./check-batch.cjs') as {
  BATCHED_GATES: string[];
  BYTES_PER_CHILD: number;
  MAX_CONCURRENCY: number;
  concurrencyFor: (input: { freeBytes?: number }) => number;
  runBatch: (input: {
    gates?: string[];
    freeBytes?: number;
    run?: (gate: string) => Promise<{ code: number; output: string }>;
    log?: (...args: string[]) => void;
    error?: (...args: string[]) => void;
  }) => Promise<{
    exitCode: number;
    concurrency: number;
    peakInFlight: number;
    failed: string[];
  }>;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake runner whose gates finish in a chosen order with chosen exit codes. */
function fakeRun(
  behavior: Record<string, { delay: number; code: number; output?: string }>,
) {
  return async (gate: string) => {
    const { delay, code, output = `${gate} body\n` } = behavior[gate]!;
    await wait(delay);
    return { code, output };
  };
}

function collect() {
  const out: string[] = [];
  return {
    lines: out,
    log: (line: string) => void out.push(line),
    error: (line: string) => void out.push(line),
  };
}

describe('check batch', () => {
  it('derives its concurrency from free memory and stays inside its ceiling', () => {
    expect(concurrencyFor({ freeBytes: Number.NaN })).toBe(1);
    expect(concurrencyFor({ freeBytes: 0 })).toBe(1);
    expect(concurrencyFor({ freeBytes: BYTES_PER_CHILD })).toBe(1);
    expect(concurrencyFor({ freeBytes: BYTES_PER_CHILD * 2 })).toBe(2);
    expect(concurrencyFor({ freeBytes: 64 * 1024 ** 3 })).toBe(MAX_CONCURRENCY);
  });

  it('never runs a child it has no memory for', async () => {
    const sink = collect();
    const outcome = await runBatch({
      gates: ['a', 'b', 'c', 'd'],
      freeBytes: BYTES_PER_CHILD,
      run: fakeRun({
        a: { delay: 1, code: 0 },
        b: { delay: 1, code: 0 },
        c: { delay: 1, code: 0 },
        d: { delay: 1, code: 0 },
      }),
      ...sink,
    });
    expect(outcome.concurrency).toBe(1);
    expect(outcome.peakInFlight).toBe(1);
  });

  it('holds the ceiling even when every gate finishes instantly', async () => {
    const outcome = await runBatch({
      gates: ['a', 'b', 'c', 'd', 'e', 'f'],
      freeBytes: BYTES_PER_CHILD * 3,
      run: fakeRun(
        Object.fromEntries(
          ['a', 'b', 'c', 'd', 'e', 'f'].map((g) => [g, { delay: 0, code: 0 }]),
        ),
      ),
      log: () => undefined,
      error: () => undefined,
    });
    expect(outcome.peakInFlight).toBeLessThanOrEqual(3);
    expect(outcome.exitCode).toBe(0);
  });

  it('prints gates in declared order when they complete in another order', async () => {
    const sink = collect();
    await runBatch({
      gates: ['slow', 'middle', 'fast'],
      freeBytes: BYTES_PER_CHILD * 3,
      run: fakeRun({
        slow: { delay: 40, code: 0 },
        middle: { delay: 20, code: 0 },
        fast: { delay: 1, code: 0 },
      }),
      ...sink,
    });
    expect(sink.lines.slice(0, 3)).toEqual([
      'check:batch: slow ok',
      'check:batch: middle ok',
      'check:batch: fast ok',
    ]);
  });

  it('marks the first gate that failed in declared order, not the first to finish', async () => {
    const sink = collect();
    const outcome = await runBatch({
      gates: ['early-fail', 'late-fail', 'passing'],
      freeBytes: BYTES_PER_CHILD * 3,
      run: fakeRun({
        'early-fail': { delay: 40, code: 1, output: 'the real gate output\n' },
        'late-fail': { delay: 2, code: 1, output: 'other output\n' },
        passing: { delay: 1, code: 0 },
      }),
      ...sink,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.failed).toEqual(['early-fail', 'late-fail']);
    // verify:summary scans back from ELIFECYCLE to the last `$ ` line, so exactly
    // one marker may exist and it must name the gate, not this batch.
    const markers = sink.lines.filter((line) => line.startsWith('$ '));
    expect(markers).toEqual(['$ pnpm early-fail']);
    expect(sink.lines).toContain('the real gate output');
    expect(sink.lines).toContain('check:batch: also failed late-fail');
  });

  it('reports success compactly and exits zero when nothing failed', async () => {
    const sink = collect();
    const outcome = await runBatch({
      gates: BATCHED_GATES.slice(0, 2),
      freeBytes: BYTES_PER_CHILD * 3,
      run: fakeRun(
        Object.fromEntries(
          BATCHED_GATES.slice(0, 2).map((g) => [g, { delay: 0, code: 0 }]),
        ),
      ),
      ...sink,
    });
    expect(outcome.failed).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(sink.lines.at(-1)).toContain('gates passed');
  });

  it('refuses a name that is not a gate before any process is spawned', async () => {
    // The default runner is used on purpose: the guard has to hold in the path
    // that reaches the shell. `refused` in the output is the proof nothing ran.
    const sink = collect();
    const outcome = await runBatch({
      gates: ['a; echo spawned'],
      freeBytes: BYTES_PER_CHILD * 3,
      ...sink,
    });
    expect(outcome.failed).toEqual(['a; echo spawned']);
    expect(sink.lines).toContain('a; echo spawned: refused, not a gate name');
  });

  it('keeps every declared gate a real package script', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: { verify: string } & Record<string, string>;
    };
    expect(BATCHED_GATES.length).toBeGreaterThan(0);
    for (const gate of BATCHED_GATES) {
      expect(scripts[gate]).toBeTruthy();
    }
    expect(scripts['check:batch']).toContain('check-batch.cjs');
    // Compare tokens, not substrings: `pnpm check:imports:dist` still in verify
    // would otherwise read as if the `check:imports` member ran twice.
    const verifyGates = [...scripts.verify.matchAll(/\bpnpm\s+([\w:-]+)/g)].map(
      (match) => match[1],
    );
    expect(verifyGates).toContain('check:batch');
    for (const gate of BATCHED_GATES) {
      expect(verifyGates).not.toContain(gate);
    }
  });
});
