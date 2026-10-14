import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_DIR = '.github/workflows';

// A tag can be moved to other code after review; a commit cannot. The trailing
// comment is what Dependabot rewrites alongside the SHA.
const PINNED_USE =
  /^(\s*-?\s*)uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;

function workflowLines(): { file: string; line: string; index: number }[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) =>
      readFileSync(join(WORKFLOW_DIR, file), 'utf8')
        .split(/\r?\n/)
        .map((line, index) => ({ file, line, index })),
    );
}

describe('workflow actions', () => {
  it('pins every action to a full commit SHA with its version beside it', () => {
    const unpinned = workflowLines()
      .filter(({ line }) => /^\s*-?\s*uses: /.test(line))
      .filter(({ line }) => !PINNED_USE.test(line))
      .map(({ file, line, index }) => `${file}:${index + 1}: ${line.trim()}`);

    expect(unpinned).toEqual([]);
  });

  it('never leaves the job token in a checkout', () => {
    const lines = workflowLines();
    const leaking = lines
      .filter(({ line }) => /uses: actions\/checkout@/.test(line))
      .filter(({ file, index }) => {
        // The step's `with:` block is the indented run of lines after `uses:`.
        const step = lines
          .filter((other) => other.file === file && other.index > index)
          .slice(0, 8)
          .map((other) => other.line);
        const end = step.findIndex((line) => /^\s*- /.test(line));
        const block = end < 0 ? step : step.slice(0, end);
        return !block.some((line) =>
          /^\s+persist-credentials: false$/.test(line),
        );
      })
      .map(({ file, index }) => `${file}:${index + 1}`);

    expect(leaking).toEqual([]);
  });
});
