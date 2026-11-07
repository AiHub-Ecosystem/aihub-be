# DAST: OWASP ZAP over the CI-booted image

The repository's dynamic application security testing (issue #319). A ZAP
Automation Framework plan scans the same production image CD ships, booted in
CI against a disposable PostgreSQL and Redis, driven by the generated OpenAPI
document instead of a spider.

## What runs, and when

`.github/workflows/dast.yml` has one job with two modes:

- **Passive** — every pull request. Builds and boots the image, imports
  `openapi.json` from the running application, makes authenticated requests
  with the seeded credentials, and waits for the passive scanner. Findings are
  published as SARIF; the build does not fail.
- **Active** — the weekly schedule (Mondays 03:23 UTC) and manual
  `workflow_dispatch` with `mode: active`. The same plan plus an active scan
  bounded to 12 minutes. An alert from an injection-class rule (SQL injection,
  reflected XSS, OS command injection, SSRF — `DAST_FAILING_RULE_IDS` in
  `ops/dast/zap-rules.ts`) fails the job through `scripts/ci/dast-gate.ts`.
  Every other finding stays report-only.

Results are published twice: as a workflow artifact (`dast-sarif-<mode>`,
always) and, best-effort, to Code Scanning with the `dast-<mode>` category.
The artifact is the durable copy — ZAP's SARIF names findings by URL, which
Code Scanning ingestion has been known to reject, so a failed upload is not a
failed scan.

## Why the target is safe

- The only target is the loopback name `dast.aihub.invalid` added to the
  runner's `/etc/hosts` by the job itself. The plan template cannot name any
  other host, and the job declares no `environment` and references no secret,
  so it cannot reach the deploy boundary (#314) or a real host (#298).
- The scan's PostgreSQL and Redis are the job's own service containers;
  migrations and seed data are thrown away with the job.
- Credentials are minted inside the job (`scripts/ci/dast-seed.ts`): one
  Organization with a gateway API key, one User Account with a random
  password, and no Organization membership. Organization-scoped management
  routes therefore answer the safe authorization denial, which bounds what a
  destructive request could do even if an exclusion were bypassed.
- Destructive management operations — API key withdraw and rotate, member
  removal and ownership transfer, invitation revoke, avatar delete — are out
  of scope through the plan's `excludePaths` (#319's constraint).
- Grading calls fail closed: the downstream AI Service hosts stay
  unreachable, so a scanned grading route never spends a model call.
- The bearer token lives at most 900 seconds (the User Access JWT ceiling),
  which is why `maxScanDurationInMins` is 12. Raising the scan window needs a
  mid-scan token refresh first, not a bigger number.

## Files

| Path                                  | Role                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ops/dast/zap-plan.template.yaml`     | The plan template; the renderer fills the placeholders and markers                             |
| `ops/dast/zap-rules.ts`               | The rules configuration: every IGNORE with its reason, the active policy, the failing rule ids |
| `scripts/ci/dast-render-plan.ts`      | Renders the plan for one run; refuses placeholders or markers left behind                      |
| `scripts/ci/dast-render-plan.spec.ts` | Proves both renders, the substitutions, and the exclusions                                     |
| `scripts/ci/dast-boot-config.cjs`     | The boot configuration, repointed at the disposable databases                                  |
| `scripts/ci/dast-seed.ts`             | Mints and seeds the scan credentials                                                           |
| `scripts/ci/dast-gate.ts`             | Fails the active scan on injection-class alerts                                                |
| `.github/workflows/dast.yml`          | The job itself                                                                                 |

## Triaging a finding

1. Read the alert in the SARIF artifact (or Code Scanning): the rule id and
   name, the URL, the parameter, the evidence, and the confidence.
2. Decide which of the three it is:
   - **Real finding** — file an issue with the `security` prefix this
     repository's triage uses, the evidence, and the STRIDE class. A
     passive-scan finding on a pull request is treated like any other security
     report.
   - **Noise from this target's architecture** — add an entry with
     `threshold: 'off'` to `PASSIVE_RULES` (or tune the active policy) in
     `ops/dast/zap-rules.ts`, with a `reason` that names the control that
     covers the risk somewhere else. The type system rejects an ignore without
     a reason, and the renderer copies the reason into the rendered plan as an
     `# IGNORE:` comment.
   - **Unclear** — leave the rule alone and note it in the pull request; a
     report-only scan is allowed to accumulate a question mark.
3. Re-run locally against a booted image when adjusting rules:

   ```sh
   node --import tsx scripts/ci/dast-render-plan.ts --mode passive \
     --target http://dast.aihub.invalid:3000 \
     --api-key <seeded key> --bearer <token> \
     --out temp/dast/zap-plan.yaml
   docker run --rm --network host -v "$PWD/temp/dast:/zap/wrk:rw" \
     ghcr.io/zaproxy/zaproxy:<pinned digest> \
     zap.sh -cmd -autorun /zap/wrk/zap-plan.yaml
   ```

## When the pull-request scan stops being report-only

The passive scan reports without failing the build on purpose: the first runs
will surface the backlog the 2026-10-06 review found by hand (#316, #297 are
the closed examples), and a blocking gate over an untriaged backlog teaches
the team to ignore red. Move it to blocking when all of these hold:

- four consecutive weekly active scans have completed with no injection-class
  finding (the gate already enforces that class);
- every passive finding raised across those weeks is closed or carries an
  IGNORE entry with a reason in `ops/dast/zap-rules.ts`;
- the change is recorded in this file with the date and the decision, the way
  an ADR records one.

Until then, a red active-scan gate means exactly what it says: an
injection-class alert against the image CD would ship.
