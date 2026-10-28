import {
  PublicApiMajorUsageBuffer,
  type PublicApiMajorUsageRepositoryPort,
  type PublicApiMajorUsageRow,
} from './public-api-major-usage';
import { PublicApiMajorUsageFlusher } from './public-api-major-usage-flusher';

class RecordingRepository implements PublicApiMajorUsageRepositoryPort {
  readonly writes: {
    environment: string;
    rows: readonly PublicApiMajorUsageRow[];
  }[] = [];
  fail = false;

  async add(
    environment: string,
    rows: readonly PublicApiMajorUsageRow[],
  ): Promise<void> {
    if (this.fail) {
      throw new Error('connection refused to postgres://secret@host');
    }
    this.writes.push({ environment, rows });
  }

  async snapshot(): Promise<never> {
    throw new Error('not used');
  }
}

const sample = (iso: string) => ({
  major: 1,
  failed: false,
  at: new Date(iso),
});

describe('PublicApiMajorUsageFlusher', () => {
  it('writes the buffered rows under its Environment and empties the buffer', async () => {
    const buffer = new PublicApiMajorUsageBuffer();
    const repository = new RecordingRepository();
    const flusher = new PublicApiMajorUsageFlusher(
      buffer,
      repository,
      'sandbox',
      () => undefined,
    );
    buffer.record(sample('2026-10-28T10:00:00Z'));

    await flusher.flush();
    await flusher.flush();

    expect(repository.writes).toHaveLength(1);
    expect(repository.writes[0]?.environment).toBe('sandbox');
    expect(repository.writes[0]?.rows).toHaveLength(1);
  });

  it('keeps the counts when a write fails and reports no connection detail', async () => {
    const buffer = new PublicApiMajorUsageBuffer();
    const repository = new RecordingRepository();
    const reports: string[] = [];
    const flusher = new PublicApiMajorUsageFlusher(
      buffer,
      repository,
      'production',
      (message) => reports.push(message),
    );
    buffer.record(sample('2026-10-28T10:00:00Z'));

    repository.fail = true;
    await flusher.flush();
    repository.fail = false;
    buffer.record(sample('2026-10-28T10:00:05Z'));
    await flusher.flush();

    expect(reports).toEqual(['public API major usage flush failed']);
    expect(repository.writes[0]?.rows[0]).toMatchObject({ requestCount: 2 });
  });
});
