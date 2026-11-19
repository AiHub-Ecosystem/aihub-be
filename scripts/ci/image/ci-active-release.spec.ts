import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8').replaceAll(
  '\r\n',
  '\n',
);

it('requires main CI to transfer the live predecessor revisions through a same-run artifact', () => {
  const resolveJob = workflow.slice(
    workflow.indexOf('\n  resolve-active-release:'),
    workflow.indexOf('\n  image:'),
  );
  const imageJob = workflow.slice(
    workflow.indexOf('\n  image:'),
    workflow.indexOf('\n  publish-image:'),
  );

  expect(resolveJob).toContain('name: active-release-revisions');
  expect(resolveJob).toContain('path: ${{ runner.temp }}/active-release.txt');
  expect(resolveJob).toContain('if-no-files-found: error');
  expect(resolveJob).not.toContain('$GITHUB_OUTPUT');
  expect(imageJob).toContain('needs: resolve-active-release');
  expect(imageJob).toContain(
    "if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n        uses: actions/download-artifact@",
  );
  expect(imageJob).toContain('name: active-release-revisions');
  expect(imageJob).toContain(
    'mapfile -t active_revisions < "$RUNNER_TEMP/active-release.txt"',
  );
  expect(imageJob).not.toContain('needs.resolve-active-release.outputs');
});
