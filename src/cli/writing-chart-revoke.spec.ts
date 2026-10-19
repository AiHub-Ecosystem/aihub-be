import type {
  WritingChartRevocationAuditRecord,
  WritingChartRevocationAuditRepositoryPort,
  WritingChartRevocationStoragePort,
} from '@/modules/writing/application/writing-chart-revocation.port';
import {
  type WritingChartRevokeCliInput,
  runWritingChartRevokeCommand,
} from './writing-chart-revoke';

const ASSET_ID = 'chart_01J00000000000000000000001';
const PUBLISHED_KEY = `writing-charts/${ASSET_ID}/published`;
const PUBLIC_URL = `https://s3.wispace.app/aihub-sandbox-writing-charts/${PUBLISHED_KEY}`;
const NOW = new Date('2026-10-19T12:00:00.000Z');

function setup(includeProbe = true) {
  const records: WritingChartRevocationAuditRecord[] = [];
  const findActiveOperatorAccount = jest.fn().mockResolvedValue('usr_operator');
  const appendAuditRecord = jest.fn(
    async (record: WritingChartRevocationAuditRecord) => {
      records.push(record);
    },
  );
  const closeAudit = jest.fn().mockResolvedValue(undefined);
  const audit: WritingChartRevocationAuditRepositoryPort & {
    close: jest.Mock;
  } = {
    findActiveOperatorAccount,
    append: appendAuditRecord,
    pruneExpired: jest.fn().mockResolvedValue(0),
    close: closeAudit,
  };
  const deletePublishedObjectIfPresent = jest.fn().mockResolvedValue('deleted');
  const storage: WritingChartRevocationStoragePort = {
    deletePublishedObjectIfPresent,
  };
  const probe = jest
    .fn()
    .mockResolvedValue({ state: 'not_serving', status: 404 });
  const lines: string[] = [];
  const input: WritingChartRevokeCliInput = {
    databaseUrl: 'postgres://operator',
    environment: 'sandbox',
    url: PUBLIC_URL,
    actorUsername: 'operator',
    audit,
    storage,
    ...(includeProbe ? { probe } : {}),
    emit: (line) => lines.push(line),
    now: () => NOW,
  };
  return {
    input,
    audit,
    storage,
    probe,
    records,
    lines,
    findActiveOperatorAccount,
    appendAuditRecord,
    closeAudit,
    deletePublishedObjectIfPresent,
  };
}

describe('runWritingChartRevokeCommand', () => {
  it('deletes only the selected tier key, probes separately, and stores safe audit metadata', async () => {
    const {
      input,
      probe,
      records,
      lines,
      findActiveOperatorAccount,
      closeAudit,
      deletePublishedObjectIfPresent,
    } = setup();
    probe.mockResolvedValue({ state: 'serving', status: 200 });

    await expect(runWritingChartRevokeCommand(input)).resolves.toMatchObject({
      assetId: ASSET_ID,
      origin: 'deleted',
      edge: { state: 'serving', status: 200 },
      propagationPending: true,
    });

    expect(findActiveOperatorAccount).toHaveBeenCalledWith('operator');
    expect(deletePublishedObjectIfPresent).toHaveBeenCalledWith({
      environment: 'sandbox',
      publishedKey: PUBLISHED_KEY,
    });
    expect(probe).toHaveBeenCalledWith(PUBLIC_URL);
    expect(records).toEqual([
      {
        assetId: ASSET_ID,
        actorUserAccountId: 'usr_operator',
        occurredAt: NOW,
        phase: 'requested',
        originOutcome: null,
        edgeOutcome: null,
        edgeStatus: null,
      },
      {
        assetId: ASSET_ID,
        actorUserAccountId: 'usr_operator',
        occurredAt: NOW,
        phase: 'completed',
        originOutcome: 'deleted',
        edgeOutcome: 'serving',
        edgeStatus: 200,
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(PUBLIC_URL);
    expect(lines.join('\n')).not.toContain('raw report');
    expect(closeAudit).toHaveBeenCalledTimes(1);
  });

  it('probes the public GET path with one byte and cancels the chart body', async () => {
    const { input } = setup(false);
    const cancelBody = jest.fn().mockResolvedValue(undefined);
    const fetchRequest = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      body: { cancel: cancelBody },
    } as unknown as Response);

    try {
      await expect(runWritingChartRevokeCommand(input)).resolves.toMatchObject({
        edge: { state: 'serving', status: 200 },
      });
      expect(fetchRequest).toHaveBeenCalledWith(
        PUBLIC_URL,
        expect.objectContaining({
          method: 'GET',
          headers: { Range: 'bytes=0-0' },
          redirect: 'manual',
        }),
      );
      expect(cancelBody).toHaveBeenCalledTimes(1);
    } finally {
      fetchRequest.mockRestore();
    }
  });

  it('accepts only exact HTTPS chart URLs in the selected environment bucket', async () => {
    const invalidUrls = [
      PUBLIC_URL.replace('https:', 'http:'),
      PUBLIC_URL.replace('https://', 'https://user:pass@'),
      PUBLIC_URL.replace('https://', 'https://@'),
      PUBLIC_URL.replace('s3.wispace.app/', 's3.wispace.app:8443/'),
      `${PUBLIC_URL}?download=1`,
      `${PUBLIC_URL}#fragment`,
      PUBLIC_URL.replace('s3.wispace.app', 'charts.wispace.app'),
      PUBLIC_URL.replace(
        'aihub-sandbox-writing-charts',
        'aihub-writing-charts',
      ),
      PUBLIC_URL.replace('/published', '/staging'),
      PUBLIC_URL.replace('chart_01J00000000000000000000001', 'chart_%2F'),
    ];

    for (const url of invalidUrls) {
      const {
        input,
        findActiveOperatorAccount,
        probe,
        deletePublishedObjectIfPresent,
      } = setup();
      await expect(
        runWritingChartRevokeCommand({ ...input, url }),
      ).rejects.toMatchObject({ code: 'INVALID_PUBLIC_URL' });
      expect(findActiveOperatorAccount).not.toHaveBeenCalled();
      expect(deletePublishedObjectIfPresent).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
    }

    const { input, findActiveOperatorAccount, deletePublishedObjectIfPresent } =
      setup();
    await expect(
      runWritingChartRevokeCommand({ ...input, environment: 'production' }),
    ).rejects.toMatchObject({ code: 'INVALID_PUBLIC_URL' });
    expect(findActiveOperatorAccount).not.toHaveBeenCalled();
    expect(deletePublishedObjectIfPresent).not.toHaveBeenCalled();
  });

  it('requires an active AIHUB account before attempting deletion', async () => {
    const {
      input,
      findActiveOperatorAccount,
      probe,
      records,
      deletePublishedObjectIfPresent,
    } = setup();
    findActiveOperatorAccount.mockResolvedValue(undefined);

    await expect(runWritingChartRevokeCommand(input)).rejects.toMatchObject({
      code: 'ACTOR_INVALID',
    });

    expect(deletePublishedObjectIfPresent).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('checks the audit timestamp before performing the irreversible delete', async () => {
    const { input, probe, records, deletePublishedObjectIfPresent } = setup();

    await expect(
      runWritingChartRevokeCommand({
        ...input,
        now: () => new Date(Number.NaN),
      }),
    ).rejects.toMatchObject({ code: 'DATABASE_FAILURE' });

    expect(deletePublishedObjectIfPresent).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('reports a missing origin object as already absent and probes again on a repeat', async () => {
    const { input, records, lines, deletePublishedObjectIfPresent } = setup();
    deletePublishedObjectIfPresent.mockResolvedValue('already_absent');

    const first = await runWritingChartRevokeCommand(input);
    const second = await runWritingChartRevokeCommand(input);

    expect(first.origin).toBe('already_absent');
    expect(second.origin).toBe('already_absent');
    expect(
      records.filter((record) => record.phase === 'completed'),
    ).toHaveLength(2);
    expect(
      records.filter((record) => record.phase === 'requested'),
    ).toHaveLength(2);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).toContain('already_absent');
  });

  it('does not delete when the durable request event cannot be recorded', async () => {
    const { input, appendAuditRecord, deletePublishedObjectIfPresent } =
      setup();
    appendAuditRecord.mockRejectedValue(new Error('database unavailable'));

    await expect(runWritingChartRevokeCommand(input)).rejects.toMatchObject({
      code: 'DATABASE_FAILURE',
    });

    expect(deletePublishedObjectIfPresent).not.toHaveBeenCalled();
  });

  it('keeps the durable request event if the completion event cannot be recorded', async () => {
    const {
      input,
      appendAuditRecord,
      records,
      deletePublishedObjectIfPresent,
    } = setup();
    appendAuditRecord.mockImplementation(async (record) => {
      if (record.phase === 'completed') {
        throw new Error('database unavailable');
      }
      records.push(record);
    });

    await expect(runWritingChartRevokeCommand(input)).rejects.toMatchObject({
      code: 'AUDIT_COMPLETION_FAILURE',
    });

    expect(deletePublishedObjectIfPresent).toHaveBeenCalledTimes(1);
    expect(records).toMatchObject([{ phase: 'requested' }]);
  });

  it('records origin failure while retaining the independent edge observation', async () => {
    const { input, probe, records, lines, deletePublishedObjectIfPresent } =
      setup();
    deletePublishedObjectIfPresent.mockRejectedValue(
      new Error('storage secret detail'),
    );
    probe.mockResolvedValue({ state: 'unavailable', status: null });

    await expect(runWritingChartRevokeCommand(input)).resolves.toMatchObject({
      origin: 'failed',
      edge: { state: 'unavailable', status: null },
    });

    expect(
      records.find((record) => record.phase === 'completed'),
    ).toMatchObject({
      phase: 'completed',
      originOutcome: 'failed',
      edgeOutcome: 'unavailable',
      edgeStatus: null,
    });
    expect(lines.join('\n')).not.toContain('storage secret detail');
  });
});
