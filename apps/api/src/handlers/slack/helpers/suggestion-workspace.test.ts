import { describe, expect, it } from 'vitest';

import {
  buildSeededSuggestionSlackText,
  buildSuggestionSlackText,
  buildSuggestionTaskPromptText,
  getSharedScheduledSuggestionSeededTextOptions,
  getSharedScheduledSuggestionSlackTextOptions,
  usesSharedScheduledSuggestionSlackModel,
} from './suggestion-workspace';

describe('buildSuggestionTaskPromptText', () => {
  it('keeps ordinary suggestion prompts generic', () => {
    const prompt = buildSuggestionTaskPromptText({
      suggestionType: 'suggested_tasks',
      title: 'Fix cron retries',
      brief: 'Fix cron retries',
      category: 'bug',
      priority: 'P0',
      investigationContext:
        'apps/api/src/jobs/retry.ts:92 drops the persisted retry delay.',
      targetRepositoryFullName: 'acme/app',
    });

    expect(prompt).not.toContain('sentry_triage_slack_reaction');
    expect(prompt).not.toContain('sentry issue merge');
    expect(prompt).toContain('Investigation context:');
  });

  it('keeps sentry triage suggestions on the sentry-triage workflow with safety guardrails', () => {
    const prompt = buildSuggestionTaskPromptText({
      suggestionType: 'sentry_triage',
      title: 'Merge duplicate API errors',
      brief: 'Merge the duplicate API-42 and API-77 issue groups.',
      readinessMessage: 'Sentry MCP is available.',
      investigationContext: 'Issue: API-42. Canonical group: API-77.',
      targetRepositoryFullName: 'acme/api',
    });

    expect(prompt.startsWith('$sentry-triage')).toBe(true);
    expect(prompt).toContain('<source>sentry_triage_suggestion</source>');
    expect(prompt).toContain(
      'This follow-up path should produce a reviewable code or instrumentation change',
    );
    expect(prompt).toContain(
      'Investigation context from the scheduled triage run:',
    );
  });

  it('keeps dependabot triage suggestions on the update-dependencies workflow with alert re-verification guidance', () => {
    const prompt = buildSuggestionTaskPromptText({
      suggestionType: 'dependabot_triage',
      title: 'Update braces in apps/api',
      brief: 'Patch the vulnerable braces version in the API workspace.',
      investigationContext: 'Alert: GHSA-123. Manifest: apps/api/package.json.',
      targetRepositoryFullName: 'acme/api',
    });

    expect(prompt.startsWith('$update-dependencies')).toBe(true);
    expect(prompt).toContain('<source>dependabot_triage_suggestion</source>');
    expect(prompt).toContain(
      'Re-verify the exact open Dependabot alert or alert bundle before changing dependencies.',
    );
  });

  it('includes workspace readiness when the suggestion falls back to bare repo mode', () => {
    const prompt = buildSuggestionTaskPromptText({
      suggestionType: 'suggested_tasks',
      title: 'Investigate worker queue lag',
      brief: 'Check why the preview worker falls behind.',
      readinessMessage: 'Worker validation is limited without setup.',
      investigationContext: null,
      targetRepositoryFullName: 'acme/worker',
    });

    expect(prompt).toContain('Workspace readiness:');
    expect(prompt).toContain('Worker validation is limited without setup.');
  });
});

describe('buildSuggestionSlackText', () => {
  it('can render suggested-task Slack copy with only the priority color emoji and block quotes', () => {
    const text = buildSuggestionSlackText(
      {
        title: 'Fix cron retries',
        brief: 'Fix cron retries',
        category: 'bug',
        priority: 'P0',
        targetRepositoryFullName: 'acme/app',
      },
      {
        badgeStyle: 'color_only',
        quote: true,
      },
    );

    expect(text).toBe(
      '> **🔴 [Bug] Fix cron retries** [acme/app](https://github.com/acme/app)\n> Fix cron retries',
    );
  });
});

describe('buildSeededSuggestionSlackText', () => {
  it('renders accepted suggestion copy without repeating the reaction emoji', () => {
    const text = buildSeededSuggestionSlackText(
      '> **Fix cron retries**\n> Fix cron retries',
      'U999',
      { statusLabel: 'accepted' },
    );

    expect(text).toBe(
      '> **Fix cron retries**\n> Fix cron retries\n\nAccepted by <@U999>',
    );
  });
});

describe('shared scheduled suggestion Slack model helpers', () => {
  it('marks suggest-ideas summaries as shared-formatting users', () => {
    expect(usesSharedScheduledSuggestionSlackModel('suggested_tasks')).toBe(
      true,
    );
    expect(usesSharedScheduledSuggestionSlackModel('sentry_triage')).toBe(
      false,
    );
    expect(usesSharedScheduledSuggestionSlackModel('dependabot_triage')).toBe(
      false,
    );
    expect(usesSharedScheduledSuggestionSlackModel('security_auditor')).toBe(
      false,
    );
    expect(
      usesSharedScheduledSuggestionSlackModel('code_quality_auditor'),
    ).toBe(false);
    expect(usesSharedScheduledSuggestionSlackModel('setup_onboarding')).toBe(
      false,
    );
  });

  it('returns the shared scheduled suggestion formatting options', () => {
    expect(
      getSharedScheduledSuggestionSlackTextOptions('suggested_tasks'),
    ).toEqual({
      badgeStyle: 'color_only',
      quote: true,
    });
    expect(
      getSharedScheduledSuggestionSlackTextOptions('dependabot_triage'),
    ).toBeUndefined();
    expect(
      getSharedScheduledSuggestionSeededTextOptions('code_quality_auditor'),
    ).toBeUndefined();
    expect(
      getSharedScheduledSuggestionSeededTextOptions('suggested_tasks'),
    ).toEqual({
      statusLabel: 'accepted',
    });
  });
});
