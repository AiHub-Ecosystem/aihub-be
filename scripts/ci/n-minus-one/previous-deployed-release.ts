import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface WorkflowRun {
  readonly id: number;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly updated_at: string;
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
  readonly artifacts?: readonly {
    readonly name: string;
    readonly expired: boolean;
  }[];
}

interface PreviousDeployedReleaseOptions {
  readonly repository: string;
  readonly token: string;
  readonly activeProductionSha?: string | undefined;
  readonly activeSandboxSha?: string | undefined;
  readonly fetchImpl?: typeof fetch;
}

export async function previousDeployedRelease({
  repository,
  token,
  activeProductionSha,
  activeSandboxSha,
  fetchImpl = fetch,
}: PreviousDeployedReleaseOptions): Promise<{
  production: { runId: number; sha: string; digestRunId: number };
  sandbox: { runId: number; sha: string; digestRunId: number };
}> {
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

  const runs: WorkflowRun[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await getJson(
      `${baseUrl}/actions/workflows/cd.yml/runs?branch=main&per_page=100&page=${page}`,
    );
    const pageRuns = result.workflow_runs ?? [];
    runs.push(...pageRuns);
    if (pageRuns.length < 100) break;
    if (page === 100) {
      throw new Error('CD history exceeds the safe lookup limit');
    }
  }

  const activeRun = runs.find(
    (run) =>
      run.event === 'workflow_run' &&
      run.head_branch === 'main' &&
      run.status !== 'completed',
  );
  if (activeRun !== undefined) {
    throw new Error(
      `CD run ${activeRun.id} is still active; retry after it completes`,
    );
  }

  const jobsByRun = new Map<number, readonly WorkflowJob[]>();
  const ciRunsBySha = new Map<string, readonly WorkflowRun[]>();

  async function jobsFor(runId: number): Promise<readonly WorkflowJob[]> {
    let jobs = jobsByRun.get(runId);
    if (jobs === undefined) {
      const result = await getJson(
        `${baseUrl}/actions/runs/${runId}/jobs?per_page=100&page=1`,
      );
      jobs = result.jobs ?? [];
      jobsByRun.set(runId, jobs);
    }
    return jobs;
  }

  async function digestArtifactRunFor(run: WorkflowRun): Promise<number> {
    const cdArtifacts = await getJson(
      `${baseUrl}/actions/runs/${run.id}/artifacts?per_page=100&page=1`,
    );
    if (
      cdArtifacts.artifacts?.some(
        (artifact) => artifact.name === 'image-digest' && !artifact.expired,
      )
    ) {
      return run.id;
    }

    let ciRuns = ciRunsBySha.get(run.head_sha);
    if (ciRuns === undefined) {
      const found: WorkflowRun[] = [];
      for (let page = 1; page <= 100; page += 1) {
        const result = await getJson(
          `${baseUrl}/actions/workflows/ci.yml/runs?branch=main&head_sha=${run.head_sha}&per_page=100&page=${page}`,
        );
        const pageRuns = result.workflow_runs ?? [];
        found.push(...pageRuns);
        if (pageRuns.length < 100) break;
        if (page === 100) {
          throw new Error('CI history exceeds the safe lookup limit');
        }
      }
      ciRuns = found;
      ciRunsBySha.set(run.head_sha, ciRuns);
    }

    const matchingCiRuns = ciRuns
      .filter(
        (ciRun) =>
          ciRun.event === 'push' &&
          ciRun.head_branch === 'main' &&
          ciRun.head_sha === run.head_sha &&
          ciRun.status === 'completed' &&
          ciRun.conclusion === 'success' &&
          Date.parse(ciRun.updated_at) <= Date.parse(run.created_at),
      )
      .sort(
        (left, right) =>
          Date.parse(right.updated_at) - Date.parse(left.updated_at),
      );
    if (matchingCiRuns.length !== 1) {
      throw new Error(
        `CI image digest cannot be uniquely recovered for deployed release ${run.head_sha}`,
      );
    }
    return matchingCiRuns[0]!.id;
  }

  async function selectTierRelease(
    tier: 'Production' | 'Sandbox',
    stepName: string,
    activeSha?: string,
  ): Promise<{ runId: number; sha: string; digestRunId: number }> {
    if (activeSha !== undefined && !/^[a-f0-9]{40}$/u.test(activeSha)) {
      throw new Error(`Active ${tier} revision is not a commit SHA`);
    }

    for (const run of runs) {
      if (
        run.event !== 'workflow_run' ||
        run.head_branch !== 'main' ||
        run.status !== 'completed' ||
        !/^[a-f0-9]{40}$/u.test(run.head_sha) ||
        (activeSha !== undefined && run.head_sha !== activeSha)
      ) {
        continue;
      }

      const deployJob = (await jobsFor(run.id)).find(
        (job) => job.name === 'Blue-green deploy to VPS',
      );
      const tierDeploy = deployJob?.steps?.find(
        (step) => step.name === stepName,
      );
      if (tierDeploy?.conclusion !== 'success') continue;

      const finalHealthWindow = deployJob?.steps?.find(
        (step) => step.name === 'Final public health window',
      );
      const sandboxDeploy = deployJob?.steps?.find(
        (step) => step.name === 'Deploy Sandbox release and verify caller IP',
      );
      if (finalHealthWindow?.conclusion === 'failure') {
        throw new Error(
          `CD run ${run.id} failed its final public health window after ${tier} cutover; active revision is unresolved`,
        );
      }
      if (
        tier === 'Production' &&
        finalHealthWindow?.conclusion === 'skipped' &&
        sandboxDeploy?.conclusion === 'failure'
      ) {
        // ADR-0085 leaves Production active when only the later Sandbox cutover fails.
      } else if (finalHealthWindow?.conclusion !== 'success') {
        throw new Error(
          `CD run ${run.id} has no conclusive final public health window after ${tier} cutover`,
        );
      }

      return {
        runId: run.id,
        sha: run.head_sha,
        digestRunId: await digestArtifactRunFor(run),
      };
    }
    throw new Error(
      activeSha === undefined
        ? `No successful deployed ${tier} revision was found`
        : `No successful deployed ${tier} revision ${activeSha} was found`,
    );
  }

  const production = await selectTierRelease(
    'Production',
    'Deploy Production and verify caller IP',
    activeProductionSha,
  );
  const sandbox = await selectTierRelease(
    'Sandbox',
    'Deploy Sandbox release and verify caller IP',
    activeSandboxSha,
  );
  return { production, sandbox };
}

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  }

  const release = await previousDeployedRelease({
    repository,
    token,
    activeProductionSha: process.env.ACTIVE_PRODUCTION_SHA || undefined,
    activeSandboxSha: process.env.ACTIVE_SANDBOX_SHA || undefined,
  });
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(
      output,
      `previous_sha=${release.production.sha}\nprevious_run_id=${release.production.runId}\nprevious_digest_run_id=${release.production.digestRunId}\nsandbox_sha=${release.sandbox.sha}\nsandbox_run_id=${release.sandbox.runId}\nsandbox_digest_run_id=${release.sandbox.digestRunId}\n`,
    );
  } else {
    process.stdout.write(
      `${release.production.sha}\t${release.production.digestRunId}\t${release.sandbox.sha}\t${release.sandbox.digestRunId}\n`,
    );
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
