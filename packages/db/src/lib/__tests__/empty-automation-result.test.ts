import { describe, expect, it } from 'vitest';

import { isEmptyAutomationOutcome } from '../empty-automation-result';

describe('empty automation outcomes', () => {
  it.each([
    ['dependabot_triage', 'No open alerts. No remediation work needed.'],
    ['codeql_triage', 'Scan complete: 0 actionable alerts.'],
    ['announcer', 'No merged PRs to summarize.'],
    ['code_quality_auditor', 'No actionable findings; no follow-up needed.'],
    ['platform_issue_alerts', 'No configuration errors detected.'],
  ] as const)('clears a terse no-op from %s', (key, content) => {
    expect(isEmptyAutomationOutcome(key, content)).toBe(true);
  });

  it.each([
    'No open alerts. GitHub access was blocked for two repositories.',
    'No actionable alerts, but one high severity issue needs review.',
    'No findings in this scan. Submitted a follow-up task.',
    'No alerts in one repository; see the linked PR for the others.',
    'No output because the scan failed.',
    '0 open alerts in repo A, 3 open alerts in repo B.',
    'No findings. Coverage is unknown for the archived repository.',
    '## Blocker\nNo alerts.',
    'No alerts? Access may be missing.',
  ])('preserves substantive or uncertain reports: %s', (content) => {
    expect(isEmptyAutomationOutcome('dependabot_triage', content)).toBe(false);
  });

  it('does not clear other automations', () => {
    expect(isEmptyAutomationOutcome('security_auditor', 'No findings.')).toBe(
      false,
    );
  });
});
