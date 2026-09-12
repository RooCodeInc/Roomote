import { describe, expect, it } from 'vitest';

import { personIdentitySlug } from '../brain-collectors/identity';
import {
  buildTaskMemoryPage,
  resolveTaskMemoryRequest,
  summarizePullRequestOutcome,
} from '../task-memory-projection';

describe('task memory page identity', () => {
  const base = {
    taskId: 'task-1',
    taskTitle: 'Remember the fix',
    completedAt: new Date('2026-08-13T10:00:00Z'),
    environmentName: null,
    agentSummary: 'Used the durable approach.',
    initiator: { kind: 'user' as const, userId: 'user-1', name: 'Sam Lee' },
    workflow: 'standard' as const,
    request: null,
    pullRequests: [],
  };

  it('links a linked member to their person page', () => {
    const page = buildTaskMemoryPage({ ...base, runId: 101 });
    const slug = personIdentitySlug('user-1');

    expect(slug).toMatch(/^people\/roomote-member-[0-9a-f]{16}$/);
    expect(page.content).toContain('\ninitiated_by: "Sam Lee"\n');
    expect(page.content).toContain('\nroomote_user_id: user-1\n');
    expect(page.content).toContain(
      `\ninitiated_by_person: ${JSON.stringify(slug)}\n`,
    );
    expect(page.content).toContain(`\nInitiated by [Sam Lee](${slug}).\n`);
  });

  it('names an unlinked human without inventing a person page', () => {
    const page = buildTaskMemoryPage({
      ...base,
      runId: 101,
      initiator: { kind: 'user', userId: null, name: 'octocat' },
    });

    expect(page.content).toContain('\ninitiated_by: "octocat"\n');
    expect(page.content).not.toContain('roomote_user_id');
    expect(page.content).not.toContain('initiated_by_person');
    expect(page.content).toContain('\nInitiated by octocat.\n');
  });

  it('names the automation that started a task', () => {
    const page = buildTaskMemoryPage({
      ...base,
      runId: 101,
      initiator: { kind: 'automation', automation: 'issue_fixer' },
    });

    expect(page.content).toContain('\ninitiated_by_automation: issue_fixer\n');
    expect(page.content).not.toContain('initiated_by:');
    expect(page.content).toContain(
      '\nInitiated by the issue_fixer automation.\n',
    );
  });

  it('never links a person to a review the member merely triggered', () => {
    const page = buildTaskMemoryPage({
      ...base,
      runId: 101,
      workflow: 'pr_review',
    });

    expect(page.content).not.toContain('Initiated by');
    expect(page.content).not.toContain('initiated_by');
    expect(page.content).not.toContain('roomote_user_id');
  });

  it('carries the request the member made, ahead of the outcome', () => {
    const page = buildTaskMemoryPage({
      ...base,
      runId: 101,
      request: 'Make the flaky upload test deterministic.',
    });

    const request = page.content.indexOf('## Request');
    const summary = page.content.indexOf('Used the durable approach.');

    expect(page.content).toContain(
      '## Request\n\nMake the flaky upload test deterministic.\n',
    );
    expect(request).toBeGreaterThan(-1);
    expect(request).toBeLessThan(summary);
  });

  it('omits the initiator line when nothing is known about them', () => {
    const page = buildTaskMemoryPage({
      ...base,
      runId: 101,
      initiator: { kind: 'user', userId: null, name: null },
    });

    expect(page.content).not.toContain('Initiated by');
    expect(page.content).not.toContain('initiated_by');
  });

  it('keeps separate runs of the same task distinct', () => {
    const first = buildTaskMemoryPage({ ...base, runId: 101 });
    const followUp = buildTaskMemoryPage({ ...base, runId: 102 });

    expect(first.slug).toBe('tasks/task-1/runs/101');
    expect(followUp.slug).toBe('tasks/task-1/runs/102');
  });

  it('dates live and backfilled memories by task completion', () => {
    const page = buildTaskMemoryPage({ ...base, runId: 101 });

    expect(page.content).toContain('\ndate: 2026-08-13\n');
    expect(page.content).toContain(
      '\ncompleted_at: 2026-08-13T10:00:00.000Z\n',
    );
  });

  it('does not emit an invalid date when legacy completion time is missing', () => {
    const page = buildTaskMemoryPage({
      ...base,
      completedAt: null,
      runId: 101,
    });

    expect(page.content).not.toContain('\ndate:');
    expect(page.content).not.toContain('\ncreated:');
    expect(page.content).toContain('\ncompleted_at: unknown\n');
  });

  it('stamps type, title, and a stable created on memory pages', () => {
    const page = buildTaskMemoryPage({ ...base, runId: 101 });

    expect(page.content).toMatch(
      /^---\ntype: task-memory\ntitle: "[^"]+"\ncreated: 2026-08-13T10:00:00\.000Z\n/,
    );
  });
});

describe('resolveTaskMemoryRequest', () => {
  it('reads the visible prompt from the launch payload', () => {
    expect(
      resolveTaskMemoryRequest(
        { description: '  Fix the login redirect loop.  ' },
        'standard',
      ),
    ).toBe('Fix the login redirect loop.');
    expect(
      resolveTaskMemoryRequest({ text: 'Ship the banner.' }, 'standard'),
    ).toBe('Ship the banner.');
  });

  it('reads a Linear-launched request the way the agent prompt did', () => {
    const issue = {
      issueTitle: 'Login redirect loop',
      issueDescription: 'Users bounce between /login and /home.',
    };

    expect(
      resolveTaskMemoryRequest(
        { ...issue, commentBody: '@roomote please fix this' },
        'standard',
      ),
    ).toBe('@roomote please fix this');
    expect(resolveTaskMemoryRequest(issue, 'standard')).toBe(
      'Users bounce between /login and /home.',
    );
    expect(
      resolveTaskMemoryRequest({ issueTitle: issue.issueTitle }, 'standard'),
    ).toBe('Login redirect loop');
  });

  it('leaves out generated, hidden, and non-standard prompts', () => {
    expect(
      resolveTaskMemoryRequest({ description: 'Review this PR.' }, 'pr_review'),
    ).toBeNull();
    expect(
      resolveTaskMemoryRequest(
        { description: 'Set up.', visibleInTranscript: false },
        'standard',
      ),
    ).toBeNull();
    expect(
      resolveTaskMemoryRequest(
        { description: '<workflow>bootstrap</workflow> go' },
        'standard',
      ),
    ).toBeNull();
    expect(resolveTaskMemoryRequest({}, 'standard')).toBeNull();
  });

  it('bounds a long request and says where the rest lives', () => {
    const request = resolveTaskMemoryRequest(
      { description: 'x'.repeat(2_000) },
      'standard',
    );

    expect(request).toHaveLength(
      1_500 + '\n\n_Request truncated; open the task for the rest._'.length,
    );
    expect(request?.endsWith('open the task for the rest._')).toBe(true);
  });
});

describe('task memory pull request outcomes', () => {
  const base = {
    runId: 7,
    taskId: 'task-1',
    taskTitle: 'Ship the fix',
    completedAt: new Date('2026-08-13T10:00:00Z'),
    environmentName: null,
    agentSummary: 'Opened a PR with the durable approach.',
    initiator: { kind: 'automation' as const, automation: 'issue_fixer' },
    workflow: 'standard' as const,
    request: null,
  };
  const pr = {
    repository: 'owner/repo',
    prNumber: 42,
    prTitle: 'Serialize the writer',
    prUrl: 'https://example.test/owner/repo/pull/42',
  };

  it('stamps a merged outcome the completion-time summary could not know', () => {
    const page = buildTaskMemoryPage({
      ...base,
      pullRequests: [{ ...pr, status: 'merged' }],
    });

    expect(page.content).toContain('\npr_outcome: merged\n');
    expect(page.content).toContain(
      '- owner/repo#42: Serialize the writer (https://example.test/owner/repo/pull/42): merged',
    );
    expect(page.content).toContain(
      'Outcome: the pull request was merged, so this work shipped.',
    );
  });

  it('records work that did not ship when every PR closed unmerged', () => {
    const page = buildTaskMemoryPage({
      ...base,
      pullRequests: [
        { ...pr, status: 'closed' },
        { ...pr, prNumber: 43, status: 'closed' },
      ],
    });

    expect(page.content).toContain('\npr_outcome: closed\n');
    expect(page.content).toContain(
      'Outcome: the pull requests closed without merging, so this work did not ship as written.',
    );
  });

  it('treats any merge as shipped even when a sibling PR was closed', () => {
    expect(
      summarizePullRequestOutcome([{ status: 'closed' }, { status: 'merged' }]),
    ).toBe('merged');
  });

  it('reports open and draft PRs as not yet an outcome', () => {
    expect(summarizePullRequestOutcome([{ status: 'open' }])).toBe('open');
    expect(summarizePullRequestOutcome([{ status: 'draft' }])).toBe('open');
    expect(
      summarizePullRequestOutcome([{ status: 'closed' }, { status: 'open' }]),
    ).toBe('open');

    const page = buildTaskMemoryPage({
      ...base,
      pullRequests: [{ ...pr, status: 'open' }],
    });

    expect(page.content).toContain('\npr_outcome: open\n');
    expect(page.content).toContain(
      'Outcome: the pull request was still open when this memory was last refreshed.',
    );
  });

  it('keeps a never-observed status unknown instead of calling it open', () => {
    expect(summarizePullRequestOutcome([{ status: null }])).toBeNull();
    expect(summarizePullRequestOutcome([{}])).toBeNull();
    expect(
      summarizePullRequestOutcome([{ status: 'closed' }, { status: null }]),
    ).toBeNull();
    expect(
      summarizePullRequestOutcome([{ status: null }, { status: 'merged' }]),
    ).toBe('merged');
    expect(summarizePullRequestOutcome([])).toBeNull();

    const page = buildTaskMemoryPage({
      ...base,
      pullRequests: [{ ...pr, status: null }],
    });

    expect(page.content).not.toContain('pr_outcome');
    expect(page.content).toContain(': status unknown');
    expect(page.content).not.toContain('Outcome:');
    expect(page.content).toContain('## Pull requests');
  });

  it('omits the outcome field entirely when the task opened no PR', () => {
    const page = buildTaskMemoryPage({ ...base, pullRequests: [] });

    expect(page.content).not.toContain('pr_outcome');
    expect(page.content).not.toContain('## Pull requests');
  });
});
