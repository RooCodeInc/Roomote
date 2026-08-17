import { describe, expect, it } from 'vitest';

import {
  formatAutomationAttributionLabel,
  formatAutomationLabel,
} from '../automation-label';

describe('formatAutomationLabel', () => {
  it.each([
    ['conflict_resolver', 'Conflict Resolver'],
    ['suggester', 'Suggester'],
    ['manager_stats', 'Manager Stats'],
    ['sentry_triage', 'Sentry Triage'],
    ['dependabot_triage', 'Dependabot Triage'],
    // Acronym tokens stay uppercase instead of being title-cased.
    ['pr_review', 'PR Review'],
    ['mcp_recommendations', 'MCP Recommendations'],
    ['ci_failure_triage', 'CI Failure Triage'],
    // Token override for a spelling that is not a plain acronym.
    ['codeql_triage', 'CodeQL Triage'],
    // Hyphens separate tokens just like underscores.
    ['ci-failure-triage', 'CI Failure Triage'],
    // Repeated and surrounding separators collapse.
    ['pr__review', 'PR Review'],
    ['_pr_review_', 'PR Review'],
  ])('humanizes %j as %j', (key, expected) => {
    expect(formatAutomationLabel(key)).toBe(expected);
  });

  it.each([
    ['issue_fixer', 'Triage Issues'],
    ['custom_automation', 'Custom'],
  ])('uses the full-key override for %j', (key, expected) => {
    expect(formatAutomationLabel(key)).toBe(expected);
  });

  it('matches acronyms case-sensitively, so uppercase keys pass through', () => {
    expect(formatAutomationLabel('PR_REVIEW')).toBe('PR REVIEW');
  });

  it.each([
    ['an empty key', ''],
    ['a separator-only key', '___'],
  ])('returns an empty string for %s', (_label, key) => {
    expect(formatAutomationLabel(key)).toBe('');
  });

  it('prefers the user-entered name for custom automations', () => {
    expect(
      formatAutomationLabel('custom_automation', {
        actorDisplayName: '  Weekly flaky-test scan  ',
      }),
    ).toBe('Weekly flaky-test scan');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])(
    'falls back to "Custom" when the name is %s',
    (_label, actorDisplayName) => {
      expect(
        formatAutomationLabel('custom_automation', { actorDisplayName }),
      ).toBe('Custom');
    },
  );

  it('ignores the custom name for fixed-catalog keys', () => {
    expect(
      formatAutomationLabel('pr_review', { actorDisplayName: 'Nightly scan' }),
    ).toBe('PR Review');
  });
});

describe('formatAutomationAttributionLabel', () => {
  it('suffixes the humanized label', () => {
    expect(formatAutomationAttributionLabel('pr_review')).toBe(
      'PR Review Automation',
    );
    expect(formatAutomationAttributionLabel('issue_fixer')).toBe(
      'Triage Issues Automation',
    );
  });

  it('suffixes the user-entered name for custom automations', () => {
    expect(
      formatAutomationAttributionLabel('custom_automation', {
        actorDisplayName: 'Weekly flaky-test scan',
      }),
    ).toBe('Weekly flaky-test scan Automation');
  });

  it('stays empty when there is no label to attribute', () => {
    expect(formatAutomationAttributionLabel('')).toBe('');
  });
});
