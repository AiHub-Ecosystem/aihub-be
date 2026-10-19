import { readFileSync } from 'node:fs';

// A cleanup command is how AIHUB keeps a retention promise. One that nothing
// runs keeps none, so each must be scheduled by the host crontab or named here
// as manual, with the reason it is not scheduled.
const MANUAL_CLEANUP_COMMANDS: Readonly<Record<string, string>> = {
  'idempotency:cleanup':
    'Scheduling and batching are owned by #272; until then it runs by hand.',
};

const CLEANUP_COMMAND = /(?:sweep|prune|cleanup)$/;

function cliCommands(): string[] {
  const source = readFileSync('scripts/cli/cli.mjs', 'utf8');
  return [...source.matchAll(/command === '([a-z0-9:-]+)'/g)].map(
    (match) => match[1] as string,
  );
}

function wrapperCommandsByJob(): Map<string, string[]> {
  const source = readFileSync(
    'scripts/ops/host-jobs/host-scheduled-job.sh',
    'utf8',
  );
  const jobs = new Map<string, string[]>();
  for (const match of source.matchAll(
    /^\s+([a-z-]+)\) commands=\(([^)]*)\);/gm,
  )) {
    jobs.set(match[1] as string, (match[2] as string).trim().split(/\s+/));
  }
  return jobs;
}

function scheduledJobs(): string[] {
  const source = readFileSync('ops/host-jobs/aihub.crontab', 'utf8');
  return [...source.matchAll(/host-scheduled-job\.sh' ([a-z-]+)/g)].map(
    (match) => match[1] as string,
  );
}

function scheduledCommands(): Set<string> {
  const byJob = wrapperCommandsByJob();
  return new Set(scheduledJobs().flatMap((job) => byJob.get(job) ?? []));
}

describe('cleanup command schedule', () => {
  it('finds the commands, the wrapper jobs, and the crontab entries it checks', () => {
    expect(cliCommands()).toContain('usage:prune');
    expect(wrapperCommandsByJob().get('prune')).toEqual(['usage:prune']);
    expect(scheduledJobs()).toContain('prune');
  });

  it('schedules every cleanup command or names it as manual with a reason', () => {
    const scheduled = scheduledCommands();
    const unscheduled = cliCommands()
      .filter((command) => CLEANUP_COMMAND.test(command))
      .filter(
        (command) =>
          !scheduled.has(command) && !(command in MANUAL_CLEANUP_COMMANDS),
      );

    expect(unscheduled).toEqual([]);
  });

  it('keeps the manual list to commands that exist and are not scheduled', () => {
    const commands = new Set(cliCommands());
    const scheduled = scheduledCommands();
    for (const [command, reason] of Object.entries(MANUAL_CLEANUP_COMMANDS)) {
      expect(commands.has(command)).toBe(true);
      expect(scheduled.has(command)).toBe(false);
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  it('runs every scheduled job through a wrapper mapping', () => {
    const byJob = wrapperCommandsByJob();
    expect(scheduledJobs().filter((job) => !byJob.has(job))).toEqual([]);
  });
});
