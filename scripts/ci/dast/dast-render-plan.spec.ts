import {
  ACTIVE_RULES,
  DAST_FAILING_RULE_IDS,
  PASSIVE_RULES,
} from '../../../ops/dast/zap-rules';
import { renderPlan } from './dast-render-plan';

const BASE: Parameters<typeof renderPlan>[0] = {
  mode: 'passive',
  target: 'http://dast.aihub.invalid:3000',
  apiKey: 'aihub_prod_test',
  bearer: 'test-token',
};

const passivePlan = (): string => renderPlan(BASE);

const activePlan = (): string => renderPlan({ ...BASE, mode: 'active' });

describe('dast-render-plan', () => {
  it('renders a passive plan without the active-scan block', () => {
    const plan = passivePlan();

    expect(plan).not.toContain('type: activeScan');
    expect(plan).not.toContain('@dast-only');
    expect(plan).not.toContain('@dast-rules:');
    expect(plan).toContain('type: openapi');
    expect(plan).toContain('type: passiveScan-wait');
    expect(plan).toContain('type: report');
  });

  it('renders an active plan with the bounded active scan', () => {
    const plan = activePlan();

    expect(plan).toContain('type: activeScan');
    expect(plan).toContain('maxScanDurationInMins: 12');
    expect(plan).toContain('type: report');
    expect(plan).not.toContain('@dast-only');
    expect(plan).not.toContain('@dast-rules:');
  });

  it('substitutes the target and the minted credentials everywhere', () => {
    for (const plan of [passivePlan(), activePlan()]) {
      expect(plan).not.toMatch(/\$\{[^}]*\}/);
      expect(plan).toContain('apiFile: /zap/wrk/openapi.json');
      expect(plan).not.toContain('apiUrl:');
      expect(plan).toContain('replacementString: aihub_prod_test');
      expect(plan).toContain('replacementString: Bearer test-token');
    }
  });

  it('injects the passive rules with a reason on every IGNORE', () => {
    const plan = passivePlan();

    for (const rule of PASSIVE_RULES) {
      expect(plan).toContain(`- id: ${rule.id}`);
      expect(plan).toContain(`threshold: ${rule.threshold}`);
    }
    const ignoreComments = PASSIVE_RULES.map((rule) =>
      rule.threshold === 'off' ? `# IGNORE: ${rule.reason}` : null,
    ).filter((comment): comment is string => comment !== null);
    for (const comment of ignoreComments) {
      expect(plan).toContain(comment);
    }
  });

  it('injects the active policy rules into the scheduled plan', () => {
    const plan = activePlan();

    for (const rule of ACTIVE_RULES) {
      expect(plan).toContain(`- id: ${rule.id}`);
      expect(plan).toContain(`threshold: ${rule.threshold}`);
    }
  });

  it('keeps the failing gate and the active policy over the same rules', () => {
    for (const rule of ACTIVE_RULES) {
      expect(DAST_FAILING_RULE_IDS).toContain(rule.id);
    }
  });

  it('excludes the destructive management operations from scope', () => {
    const plan = passivePlan();

    for (const excluded of [
      'api-keys/[^/]+/rotate',
      'members/[^/]+/transfer',
      'invitations/[^/]+',
      'me/avatar$',
    ]) {
      expect(plan).toContain(excluded);
    }
  });
});
