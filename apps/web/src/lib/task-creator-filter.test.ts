import { describe, expect, it } from 'vitest';

import {
  buildCreatorFilterValue,
  formatAutomationAttributionLabel,
  formatAutomationLabel,
  parseCreatorFilterValue,
} from './task-creator-filter';

describe('task creator filter helpers', () => {
  it('round-trips automation creator filter values', () => {
    const value = buildCreatorFilterValue({
      initiatorKind: 'automation',
      initiatorUserId: null,
      initiatorAutomation: 'pr_review',
      actorExternalId: null,
    });

    expect(value).toBe('automation:pr_review');
    expect(parseCreatorFilterValue(value ?? '')).toEqual({
      kind: 'automation',
      key: 'pr_review',
    });
  });

  it('returns null for automation initiators without a key', () => {
    expect(
      buildCreatorFilterValue({
        initiatorKind: 'automation',
        initiatorUserId: null,
        initiatorAutomation: null,
        actorExternalId: null,
      }),
    ).toBeNull();
  });

  it('uses the plain user id for linked human initiators', () => {
    const value = buildCreatorFilterValue({
      initiatorKind: 'user',
      initiatorUserId: 'user_123',
      initiatorAutomation: null,
      actorExternalId: null,
    });

    expect(value).toBe('user_123');
    expect(parseCreatorFilterValue(value ?? '')).toEqual({
      kind: 'user',
      userId: 'user_123',
    });
  });

  it('round-trips external actor filter values', () => {
    const value = buildCreatorFilterValue({
      initiatorKind: 'user',
      initiatorUserId: null,
      initiatorAutomation: null,
      actorExternalId: 'slack:U123',
    });

    expect(value).toBe(`external:${encodeURIComponent('slack:U123')}`);
    expect(parseCreatorFilterValue(value ?? '')).toEqual({
      kind: 'external',
      externalId: 'slack:U123',
    });
  });

  it('returns null when no initiator columns identify a creator', () => {
    expect(
      buildCreatorFilterValue({
        initiatorKind: 'user',
        initiatorUserId: null,
        initiatorAutomation: null,
        actorExternalId: null,
      }),
    ).toBeNull();
  });

  it('treats plain values as opaque user ids when parsing', () => {
    expect(parseCreatorFilterValue('user_123')).toEqual({
      kind: 'user',
      userId: 'user_123',
    });
  });

  it('falls back to the opaque user path for malformed external values', () => {
    expect(parseCreatorFilterValue('external:%E0%A4%A')).toEqual({
      kind: 'user',
      userId: 'external:%E0%A4%A',
    });
  });

  it('falls back to the opaque user path for empty automation keys', () => {
    expect(parseCreatorFilterValue('automation:')).toEqual({
      kind: 'user',
      userId: 'automation:',
    });
  });
});

describe('formatAutomationLabel', () => {
  it('title-cases snake_case automation keys', () => {
    expect(formatAutomationLabel('conflict_resolver')).toBe(
      'Conflict Resolver',
    );
  });

  it('uppercases well-known acronyms', () => {
    expect(formatAutomationLabel('pr_review')).toBe('PR Review');
    expect(formatAutomationLabel('mcp_recommendations')).toBe(
      'MCP Recommendations',
    );
    expect(formatAutomationLabel('ci-fixer')).toBe('CI Fixer');
    expect(formatAutomationLabel('codeql_triage')).toBe('CodeQL Triage');
    expect(formatAutomationLabel('issue_fixer')).toBe('Triage Issues');
  });

  it('does not treat Object.prototype keys as token overrides', () => {
    expect(formatAutomationLabel('constructor')).toBe('Constructor');
    expect(formatAutomationLabel('toString')).toBe('ToString');
  });
});

describe('formatAutomationAttributionLabel', () => {
  it('attributes automation keys as "{name} Automation"', () => {
    expect(formatAutomationAttributionLabel('review_code')).toBe(
      'Review Code Automation',
    );
    expect(formatAutomationAttributionLabel('conflict_resolver')).toBe(
      'Conflict Resolver Automation',
    );
  });

  it('uses the user-entered custom automation name when provided', () => {
    expect(
      formatAutomationAttributionLabel('custom_automation', {
        actorDisplayName: 'Weekly flaky-test scan',
      }),
    ).toBe('Weekly flaky-test scan Automation');
    expect(formatAutomationAttributionLabel('custom_automation')).toBe(
      'Custom Automation',
    );
  });
});
