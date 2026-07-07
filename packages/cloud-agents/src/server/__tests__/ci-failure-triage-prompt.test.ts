import { describe, expect, it } from 'vitest';

import { buildCiFailureTriagePrompt } from '../ci-failure-triage-prompt';

const baseParams = {
  channelId: 'C123',
  repositoryFullNames: ['acme/api'],
  repositoryCoverage: [
    { repositoryFullName: 'acme/api', targetEnvironmentId: 'env-api' },
    { repositoryFullName: 'acme/web' },
  ],
  scanWindowStart: new Date('2026-04-09T01:00:00.000Z'),
};

describe('buildCiFailureTriagePrompt', () => {
  it('builds an act-only sweep prompt with environment coverage', () => {
    const prompt = buildCiFailureTriagePrompt({
      ...baseParams,
      trigger: 'scheduled',
      recentThreadFeedback: '- Never disable a failing test to make CI green',
    });

    expect(prompt).toContain('$ci-failure-triage');
    expect(prompt).toContain('<run_mode>read_only</run_mode>');
    expect(prompt).toContain('<trigger>scheduled</trigger>');
    expect(prompt).toContain(
      'failed default-branch workflow runs since 2026-04-09T01:00:00.000Z',
    );
    expect(prompt).toContain('- acme/api');
    expect(prompt).toContain('submit up to 3 `act` automation work items');
    expect(prompt).toContain('Do not submit suggestion work items');
    expect(prompt).toContain(
      'at most one work item for each `targetEnvironmentId`',
    );
    expect(prompt).toContain(
      'Repository environments:\n- acme/api -> environment env-api',
    );
    expect(prompt).not.toContain('acme/web -> environment');
    expect(prompt).toContain('reproduce the failure first');
    expect(prompt).toContain('$implement-changes');
    expect(prompt).toContain('fingerprint');
    expect(prompt).toContain('gh run list');
    expect(prompt).toContain(
      'Recent feedback from earlier CI failure triage threads:',
    );
    expect(prompt).toContain('Never disable a failing test to make CI green');
    expect(prompt).toContain(
      'do not paste raw GitHub CLI commands, `gh api` invocations, or command transcripts into Slack',
    );
    expect(prompt).not.toContain('<triggering_run>');
  });

  it('focuses webhook-triggered prompts on the failing run', () => {
    const prompt = buildCiFailureTriagePrompt({
      ...baseParams,
      trigger: 'webhook',
      triggeringRun: {
        repositoryFullName: 'acme/api',
        workflowName: 'CI',
        runUrl: 'https://github.com/acme/api/actions/runs/42',
        headBranch: 'main',
        headSha: 'abc123',
      },
    });

    expect(prompt).toContain('<trigger>webhook</trigger>');
    expect(prompt).toContain('<triggering_run>');
    expect(prompt).toContain('<workflow>CI</workflow>');
    expect(prompt).toContain(
      '<run_url>https://github.com/acme/api/actions/runs/42</run_url>',
    );
    expect(prompt).toContain('<head_sha>abc123</head_sha>');
    expect(prompt).toContain(
      'A workflow run just failed on the default branch',
    );
    expect(prompt).toContain('persistent, a flake, or already fixed');
    expect(prompt).toContain('submit up to 3 `act` automation work items');
  });

  it('requires resolving the announcement thread when one was posted', () => {
    const prompt = buildCiFailureTriagePrompt({
      ...baseParams,
      trigger: 'webhook',
      hasAnnouncementThread: true,
      triggeringRun: {
        repositoryFullName: 'acme/api',
        workflowName: 'CI',
        runUrl: 'https://github.com/acme/api/actions/runs/42',
        headBranch: 'main',
        headSha: 'abc123',
      },
    });

    expect(prompt).toContain(
      'An "investigating" announcement has already been posted',
    );
    expect(prompt).toContain('never leave the announcement thread unresolved');
    expect(prompt).toContain(
      'an existing Roomote investigation already covers this failure',
    );
    expect(prompt).toContain(
      'keeping that reply plain-language and free of raw GitHub CLI commands, `gh api` invocations, or command transcripts',
    );
    expect(prompt).not.toContain('post_to_slack_channel` only for GitHub');
  });
});
