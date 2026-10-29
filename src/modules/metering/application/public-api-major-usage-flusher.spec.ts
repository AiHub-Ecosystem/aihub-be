import {
  PublicApiMajorUsageBuffer,
  type PublicApiMajorUsageRepositoryPort,
  type PublicApiMajorUsageWrite,
} from './public-api-major-usage';
import { PublicApiMajorUsageFlusher } from './public-api-major-usage-flusher';

class RecordingRepository implements PublicApiMajorUsageRepositoryPort {
  readonly writes: { environment: string; write: PublicApiMajorUsageWrite }[] =
    [];
  fail = false;
  /** When set, each write waits for this before it settles. */
  gate: Promise<void> | undefined;

  async add(
    environment: string,
    write: PublicApiMajorUsageWrite,
  ): Promise<void> {
    await this.gate;
    if (this.fail) {
      throw new Error('connection refused to postgres://secret@host');
    }
    this.writes.push({ environment, write });
  }

  async snapshot(): Promise<never> {
    throw new Error('not used');
  }
}

const COLLECTOR = {
  processId: '7d9f1f0e-58c4-4c3a-9a43-1d0f0f1e2a10',
  startedAt: new Date('2026-10-28T09:00:00Z'),
};
const NOW = new Date('2026-10-28T10:00:30Z');

const sample = (iso: string, organizationId?: string) => ({
  major: 1,
  failed: false,
  callerKind: 'api-key' as const,
  at: new Date(iso),
  ...(organizationId === undefined ? {} : { organizationId }),
});

function setup(reports: string[] = []) {
  const buffer = new PublicApiMajorUsageBuffer();
  const repository = new RecordingRepository();
  const flusher = new PublicApiMajorUsageFlusher(
    buffer,
    repository,
    'sandbox',
    COLLECTOR,
    (message) => reports.push(message),
    () => NOW,
  );
  return { buffer, repository, flusher };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('PublicApiMajorUsageFlusher', () => {
  it('writes the buffered counts with its collection record and empties the buffer', async () => {
    const { buffer, repository, flusher } = setup();
    buffer.record(sample('2026-10-28T10:00:00Z', 'org_a'));

    await flusher.flush();

    expect(repository.writes).toEqual([
      {
        environment: 'sandbox',
        write: expect.objectContaining({
          collector: COLLECTOR,
          coveredThrough: NOW,
          stoppedCleanly: false,
        }) as unknown,
      },
    ]);
    expect(repository.writes[0]?.write.rows).toHaveLength(1);
    expect(buffer.drain().rows).toEqual([]);
  });

  it('still writes with nothing buffered, so the collection record keeps advancing', async () => {
    const { repository, flusher } = setup();

    await flusher.flush();

    expect(repository.writes[0]?.write).toMatchObject({
      rows: [],
      unattributed: [],
      coveredThrough: NOW,
    });
  });

  it('keeps the counts when a write fails and reports no connection detail', async () => {
    const reports: string[] = [];
    const { buffer, repository, flusher } = setup(reports);
    buffer.record(sample('2026-10-28T10:00:00Z'));

    repository.fail = true;
    await flusher.flush();
    repository.fail = false;
    buffer.record(sample('2026-10-28T10:00:05Z'));
    await flusher.flush();

    expect(reports).toEqual(['public API major usage flush failed']);
    expect(repository.writes[0]?.write.rows[0]).toMatchObject({
      requestCount: 2,
    });
    expect(repository.writes[0]?.write.unattributed[0]).toMatchObject({
      callerKind: 'api-key',
      requestCount: 2,
    });
  });

  it('skips a periodic pass while the previous one is still writing', async () => {
    const { repository, flusher } = setup();
    const gate = deferred();
    repository.gate = gate.promise;

    const first = flusher.flush();
    await flusher.flush();
    gate.resolve();
    await first;

    expect(repository.writes).toHaveLength(1);
  });

  it('on shutdown waits for the pass in flight, then writes the rest as a clean stop', async () => {
    const { buffer, repository, flusher } = setup();
    const gate = deferred();
    repository.gate = gate.promise;
    buffer.record(sample('2026-10-28T10:00:00Z'));
    const periodic = flusher.flush();
    buffer.record(sample('2026-10-28T10:00:10Z'));

    const finishing = flusher.finish(1_000);
    gate.resolve();
    await Promise.all([periodic, finishing]);

    expect(
      repository.writes.map(({ write }) => [
        write.stoppedCleanly,
        write.rows[0]?.requestCount,
      ]),
    ).toEqual([
      [false, 1],
      [true, 1],
    ]);
  });

  it('records no clean stop when the last write fails', async () => {
    const reports: string[] = [];
    const { repository, flusher } = setup(reports);
    repository.fail = true;

    await flusher.finish(1_000);

    expect(repository.writes).toEqual([]);
    expect(reports).toEqual(['public API major usage flush failed']);
  });

  it('stops waiting for a last write that does not settle in time', async () => {
    jest.useFakeTimers();
    try {
      const reports: string[] = [];
      const { repository, flusher } = setup(reports);
      repository.gate = new Promise<void>(() => undefined);

      const finishing = flusher.finish(10_000);
      await jest.advanceTimersByTimeAsync(10_000);
      await finishing;

      expect(repository.writes).toEqual([]);
      expect(reports).toEqual(['public API major usage final flush timed out']);
    } finally {
      jest.useRealTimers();
    }
  });
});
