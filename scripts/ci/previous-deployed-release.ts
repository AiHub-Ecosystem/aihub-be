import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface WorkflowRun {
  readonly id: number;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly event: string;
  readonly conclusion: string | null;
}

interface WorkflowJob {
  readonly name: string;
  readonly conclusion: string | null;
  readonly steps?: readonly {
    readonly name: string;
    readonly conclusion: string | null;
  }[];
}

interface GitHubResponse {
  readonly workflow_runs?: readonly WorkflowRun[];
  readonly jobs?: readonly WorkflowJob[];
}

interface PreviousDeployedReleaseOptions {
  readonly repository: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

export async function previousDeployedRelease({
  repository,
  token,
  fetchImpl = fetch,
}: PreviousDeployedReleaseOptions): Promise<{ runId: number; sha: string }> {
  const baseUrl = `https://api.github.com/repos/${repository}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };

  async function getJson(url: string): Promise<GitHubResponse> {
    const response = await fetchImpl(url, { headers });
    if (!response.ok) {
      throw new Error(`GitHub Actions lookup failed (${response.status})`);
    }
    return (await response.json()) as GitHubResponse;
  }

  for (let page = 1; page <= 100; page += 1) {
    const result = await getJson(
      `${baseUrl}/actions/workflows/cd.yml/runs?branch=main&status=completed&per_page=100&page=${page}`,
    );
    const runs = result.workflow_runs ?? [];

    for (const run of runs) {
      if (
        run.event !== 'workflow_run' ||
        run.head_branch !== 'main' ||
        run.conclusion !== 'success' ||
        !/^[a-f0-9]{40}$/u.test(run.head_sha)
      ) {
        continue;
      }

      const jobResult = await getJson(
        `${baseUrl}/actions/runs/${run.id}/jobs?per_page=100&page=1`,
      );
      const deployJob = jobResult.jobs?.find(
        (job) => job.name === 'Blue-green deploy to VPS',
      );
      const healthWindow = deployJob?.steps?.find(
        (step) => step.name === 'Final public health window',
      );

      if (
        deployJob?.conclusion === 'success' &&
        healthWindow?.conclusion === 'success'
      ) {
        return { runId: run.id, sha: run.head_sha };
      }
    }

    if (runs.length < 100) break;
  }

  throw new Error('No successful deployed CD revision was found');
}

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  }

  const release = await previousDeployedRelease({ repository, token });
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(
      output,
      `previous_sha=${release.sha}\nprevious_run_id=${release.runId}\n`,
    );
  } else {
    process.stdout.write(`${release.sha}\t${release.runId}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'CD lookup failed');
    process.exitCode = 1;
  });
}
