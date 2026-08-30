import type { AutomationRuntime } from '@roomote/db/server';

import {
  handleMergeAnnouncerPush,
  type MergeAnnouncerPushEvent,
} from '../merge-announcer';

const runtime: AutomationRuntime = {
  key: 'merge_announcer',
  enabled: true,
  scheduleMode: 'daily',
  lastRunAt: null,
  instructions: null,
  settings: {},
  targets: [],
  scanCursor: null,
  slackChannelId: null,
  managerSlackChannelId: null,
  managerDiscordChannelId: null,
  destination: null,
};

function createPayload(
  overrides: Partial<MergeAnnouncerPushEvent> = {},
): MergeAnnouncerPushEvent {
  return {
    provider: 'github',
    ref: 'refs/heads/main',
    compareUrl: 'https://github.com/acme/widgets/compare/before...after',
    commitCount: 2,
    repository: {
      externalId: '42',
      fullName: 'acme/widgets',
      host: 'github.com',
      htmlUrl: 'https://github.com/acme/widgets',
    },
    pusher: 'alice',
    commits: [
      {
        id: '1111111111111111111111111111111111111111',
        message: 'Add widget export',
        author: { name: 'Bob Builder', username: 'bob' },
      },
      {
        id: '2222222222222222222222222222222222222222',
        message: 'Fix widget validation',
        author: { name: 'Carol Coder' },
      },
    ],
    ...overrides,
  };
}

function createDependencies() {
  const postMessage = vi.fn().mockResolvedValue(undefined);
  return {
    postMessage,
    dependencies: {
      findRepository: vi.fn().mockResolvedValue({
        defaultBranch: 'main',
        fullName: 'acme/widgets',
      }),
      generateSummary: vi
        .fn()
        .mockResolvedValue('Adds exports and strengthens widget validation.'),
      getAdapter: vi.fn().mockResolvedValue({ postMessage }),
      getRuntime: vi.fn().mockResolvedValue(runtime),
      listConnectedProviders: vi.fn().mockResolvedValue(['slack']),
      recordOutcome: vi.fn().mockResolvedValue(undefined),
      resolveDestination: vi.fn().mockResolvedValue({
        provider: 'slack',
        channelId: 'C123',
        source: 'automation_target',
      }),
    },
  };
}

describe('handleMergeAnnouncerPush', () => {
  it('summarizes default-branch commits with pusher and author attribution', async () => {
    const { dependencies, postMessage } = createDependencies();
    dependencies.findRepository.mockResolvedValue({
      defaultBranch: 'develop',
      fullName: 'acme/widgets',
    });

    const result = await handleMergeAnnouncerPush(
      createPayload({ ref: 'refs/heads/develop' }),
      dependencies,
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'Merge announcement posted',
    });
    expect(dependencies.generateSummary).toHaveBeenCalledWith(
      expect.stringContaining('Pushed by: alice'),
    );
    expect(dependencies.findRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        repository: expect.objectContaining({ externalId: '42' }),
      }),
    );
    expect(dependencies.generateSummary).toHaveBeenCalledWith(
      expect.stringContaining('1111111 by bob: Add widget export'),
    );
    expect(postMessage).toHaveBeenCalledWith({
      channelId: 'C123',
      text: expect.stringContaining(
        'alice pushed 2 commits to develop in acme/widgets.',
      ),
      blocks: [
        expect.objectContaining({
          type: 'container',
          title: expect.objectContaining({ text: 'Merge Announcer' }),
          subtitle: {
            type: 'plain_text',
            text: 'acme/widgets · develop · alice',
          },
          icon: expect.objectContaining({
            image_url: expect.stringContaining(
              '/automation-icons/git-commit-vertical.png',
            ),
          }),
          child_blocks: expect.arrayContaining([
            expect.objectContaining({
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'Adds exports and strengthens widget validation.',
              },
            }),
            expect.objectContaining({
              type: 'actions',
              elements: expect.arrayContaining([
                expect.objectContaining({
                  action_id: 'merge_announcer_view_changes',
                  text: expect.objectContaining({ text: 'View changes' }),
                }),
                expect.objectContaining({
                  action_id: 'late_bound_automation_configure',
                  text: expect.objectContaining({ text: 'Configure' }),
                }),
              ]),
            }),
          ]),
        }),
      ],
    });
    expect(dependencies.recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'merge_announcer', status: 'succeeded' }),
    );
  });

  it('delivers to a configured cross-provider DM destination', async () => {
    const { dependencies, postMessage } = createDependencies();
    dependencies.listConnectedProviders.mockResolvedValue(['discord']);
    dependencies.resolveDestination.mockResolvedValue({
      provider: 'discord',
      channelId: 'dm-123',
      source: 'automation_target',
    });

    await handleMergeAnnouncerPush(
      createPayload({ provider: 'gitea', pusher: 'fallback-pusher' }),
      dependencies,
    );

    expect(dependencies.resolveDestination).toHaveBeenCalledWith({
      runtime,
      slackConnected: false,
    });
    expect(dependencies.getAdapter).toHaveBeenCalledWith({
      provider: 'discord',
      channelId: 'dm-123',
      source: 'automation_target',
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'dm-123',
        text: expect.stringContaining(
          '**fallback-pusher** pushed 2 commits to **main**',
        ),
        buttons: [
          [
            expect.objectContaining({ text: 'View changes' }),
            expect.objectContaining({ text: 'Configure' }),
          ],
        ],
      }),
    );
  });

  it('prioritizes bounded, redacted merged PR context in the summary prompt', async () => {
    const { dependencies } = createDependencies();
    const changedFiles = Array.from({ length: 21 }, (_, index) => ({
      path: `src/file-${index + 1}.ts`,
      status: 'modified',
      additions: index + 1,
      deletions: index,
    }));

    await handleMergeAnnouncerPush(
      createPayload({
        pullRequest: {
          number: 7,
          title: 'Ship widget export',
          body: `API_TOKEN=supersecretvalue\n${'supporting context '.repeat(300)}`,
          changedFileCount: 21,
          additions: 231,
          deletions: 210,
          changedFiles,
        },
      }),
      dependencies,
    );

    const prompt = dependencies.generateSummary.mock.calls[0]?.[0] as string;
    expect(prompt).toContain(
      'one compact bullet per meaningful merged pull request',
    );
    expect(prompt).toContain('using • as the bullet marker');
    expect(prompt).toContain(
      'plain-language past-tense verb such as Fixed, Added, or Improved',
    );
    expect(prompt).toContain('practical user or operational benefit');
    expect(prompt).toContain(
      "pull request link inline using the announcement provider's native clickable format",
    );
    expect(prompt).toContain(
      'Do not include a heading, preamble, conclusion, author list, implementation-detail enumeration, or generic praise',
    );
    expect(prompt).toContain(
      'treat its title and body as the primary source of intent',
    );
    expect(prompt).toContain('<merged_pull_request>');
    expect(prompt).toContain('Number: #7');
    expect(prompt).toContain('Title: Ship widget export');
    expect(prompt).toContain('API_TOKEN=[redacted]');
    expect(prompt).toContain('… [truncated]');
    expect(prompt).toContain('Change stats: 21 files (+231/-210)');
    expect(prompt).toContain('Changed files shown (20 of 21)');
    expect(prompt).toContain('modified src/file-20.ts (+20/-19)');
    expect(prompt).not.toContain('src/file-21.ts');
    expect(prompt).not.toContain('supersecretvalue');
  });

  it('excludes pushes to non-default branches before generating a summary', async () => {
    const { dependencies, postMessage } = createDependencies();

    const result = await handleMergeAnnouncerPush(
      createPayload({ ref: 'refs/heads/feature/new-widget' }),
      dependencies,
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'Not the default branch — skipping',
    });
    expect(dependencies.getRuntime).not.toHaveBeenCalled();
    expect(dependencies.generateSummary).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('falls back to commit subjects when helper summary generation fails', async () => {
    const { dependencies, postMessage } = createDependencies();
    dependencies.generateSummary.mockRejectedValue(
      new Error('model unavailable'),
    );

    const result = await handleMergeAnnouncerPush(
      createPayload(),
      dependencies,
    );

    expect(result.status).toBe('ok');
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          'Changes include Add widget export; Fix widget validation.',
        ),
      }),
    );
  });

  it('falls back to the redacted PR title when merged PR summarization fails', async () => {
    const { dependencies, postMessage } = createDependencies();
    dependencies.generateSummary.mockRejectedValue(
      new Error('model unavailable'),
    );

    await handleMergeAnnouncerPush(
      createPayload({
        pullRequest: {
          number: 7,
          title: '<!channel> Ship widget & <export>!',
          body: 'Detailed rationale',
          changedFileCount: 2,
          additions: 20,
          deletions: 4,
        },
      }),
      dependencies,
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          'Merged pull request: &lt;!channel&gt; Ship widget &amp; &lt;export&gt;.',
        ),
        blocks: [
          expect.objectContaining({
            child_blocks: expect.arrayContaining([
              expect.objectContaining({
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: 'Merged pull request: &lt;!channel&gt; Ship widget &amp; &lt;export&gt;.',
                },
              }),
            ]),
          }),
        ],
      }),
    );
  });
});
