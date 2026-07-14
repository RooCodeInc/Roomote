import { describe, expect, it } from 'vitest';

import { buildCiFailureTriagePrompt } from '../ci-failure-triage-prompt';

const baseParams = {
  channelId: 'C123',
  repositoryFullNames: ['acme/api'],
  repositoryCoverage: [
    { repositoryFullName: 'acme/api', targetEnvironmentId: 'env-api' },
    { repositoryFullName: 'acme/web' },
  ],
};

describe('buildCiFailureTriagePrompt', () => {
  it('builds a focused investigate-and-fix prompt for the latest failure', () => {
    const prompt = buildCiFailureTriagePrompt({
      ...baseParams,
      trigger: 'manual',
    });

    expect(prompt).toContain('$ci-failure-triage');
    expect(prompt).toContain('<run_mode>investigate_and_fix</run_mode>');
    expect(prompt).toContain('<trigger>manual</trigger>');
    expect(prompt).toContain('<repository>acme/api</repository>');
    expect(prompt).toContain('single most recent failed workflow run');
    expect(prompt).toContain('Environment:\n- acme/api -> environment env-api');
    expect(prompt).not.toContain('acme/web -> environment');
    expect(prompt).toContain(
      'Reproduce the failing job commands in this environment',
    );
    expect(prompt).toContain('Open a draft PR');
    expect(prompt).not.toContain('<triggering_run>');
    expect(prompt).not.toContain('submit_automation_work_items');
    expect(prompt).not.toContain('work item');
    expect(prompt).not.toContain('recent feedback');
    expect(prompt).not.toContain('scan_window');
    expect(prompt).not.toContain('<run_mode>read_only</run_mode>');
  });

  it('focuses webhook-triggered prompts on the failing run only', () => {
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
    expect(prompt).toContain('Work only the failing run in triggering_run');
    expect(prompt).toContain('Do not dig through unrelated older runs');
    expect(prompt).not.toContain('submit_automation_work_items');
    expect(prompt).not.toContain('work item');
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

    expect(prompt).toContain('investigating Slack thread already exists');
    expect(prompt).toContain('Always close it out');
  });
});
