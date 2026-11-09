/**
 * The DAST rules configuration, code-owned like the Operation Catalog.
 *
 * Two ZAP Automation Framework plan renders consume it: the passive
 * pull-request scan and the scheduled active scan. The renderer
 * (`scripts/ci/dast/dast-render-plan.ts`) injects these entries at the
 * `@dast-rules` markers of `ops/dast/zap-plan.template.yaml`, so this file is
 * the single statement of what the scans ignore and why. Every `off` entry
 * carries its reason as a required field, and the type system rejects an
 * ignore without one.
 *
 * Rules not listed here run at ZAP's default threshold. Add an entry only with
 * evidence from a scan run: the finding, why this target's architecture makes
 * it noise, and what other control covers the risk it would have caught.
 *
 * @owner gateway
 */

export type DastThreshold = 'off' | 'low' | 'medium' | 'high';
export type DastStrength = 'low' | 'medium' | 'high';

interface DastRuleIdentity {
  /** The ZAP scan rule id, as published at zaproxy.org/docs/alerts/. */
  readonly id: number;
  /** The rule name, for readability in this file and the rendered plan. */
  readonly name: string;
}

/** A passive scan rule entry. An `off` threshold is an IGNORE and needs a reason. */
export type PassiveRule = DastRuleIdentity &
  (
    | { readonly threshold: 'off'; readonly reason: string }
    | {
        readonly threshold: Exclude<DastThreshold, 'off'>;
        readonly reason?: string;
      }
  );

/** An active scan policy entry. ZAP alerts these at or above the threshold. */
export type ActiveRule = DastRuleIdentity & {
  readonly threshold: Exclude<DastThreshold, 'off'>;
  readonly strength?: DastStrength;
};

/**
 * Passive rules the pull-request scan runs with, tuned for this target.
 *
 * The DAST target is the application container on the runner's loopback,
 * reached over plain HTTP and without the nginx edge. Rules about what the
 * edge adds, or about browser rendering of JSON, are noise here by design;
 * the controls they would demand live in `ops/nginx/` and are reviewed there.
 */
export const PASSIVE_RULES: readonly PassiveRule[] = [
  {
    id: 10038,
    name: 'Content Security Policy (CSP) Header Not Set',
    threshold: 'off',
    reason:
      'The scan target serves JSON over plain HTTP inside CI; CSP governs browser-rendered HTML, and the one HTML surface (/docs) carries its baseline headers through the nginx edge (issue #316), which this target deliberately bypasses.',
  },
  {
    id: 10035,
    name: 'Strict-Transport-Security Header Not Set',
    threshold: 'off',
    reason:
      'HSTS is set by the nginx edge (ops/nginx/aihub-api.conf, ops/nginx/sandbox.conf); the DAST target is the application container reached directly over HTTP, so the header cannot and should not appear here.',
  },
  {
    id: 10020,
    name: 'X-Frame-Options Header Not Set',
    threshold: 'off',
    reason:
      'API responses are JSON, which browsers do not frame; the frameable HTML surface (/docs) is covered by the edge baseline headers (issue #316), not by the application the scan targets.',
  },
  {
    id: 10015,
    name: 'Incomplete or No Cache-control and Pragma HTTP Header Set',
    threshold: 'off',
    reason:
      'The application sets Cache-Control deliberately per route (no-store on authentication and grading surfaces) and leaves public reference responses cacheable on purpose; a blanket per-response rule would only restate that policy.',
  },
];

/**
 * Active scan policy entries for the scheduled run. Injection-class rules are
 * named here explicitly and duplicated in `DAST_FAILING_RULE_IDS`, so a rule
 * id that stops matching its alert turns into a gate failure, not a silent
 * pass.
 */
export const ACTIVE_RULES: readonly ActiveRule[] = [
  { id: 40018, name: 'SQL Injection', threshold: 'medium' },
  { id: 40012, name: 'Cross Site Scripting (Reflected)', threshold: 'medium' },
  { id: 40034, name: 'OS Command Injection', threshold: 'medium' },
  { id: 40043, name: 'Server Side Request Forgery', threshold: 'medium' },
];

/**
 * The injection-class rule ids whose alerts fail the scheduled active scan
 * (issue #319 acceptance criterion 4). Matched against the SARIF rule ids and,
 * as a fallback against drift, the rule names in `DAST_FAILING_RULE_NAMES`.
 */
export const DAST_FAILING_RULE_IDS: readonly number[] = [
  40018, 40012, 40034, 40043,
];

/** Name patterns for the same classes, matched when the id does not. */
export const DAST_FAILING_RULE_NAMES: readonly RegExp[] = [
  /sql injection/i,
  /cross site scripting|cross-site scripting|xss/i,
  /command injection/i,
  /server side request forgery|server-side request forgery|ssrf/i,
];
