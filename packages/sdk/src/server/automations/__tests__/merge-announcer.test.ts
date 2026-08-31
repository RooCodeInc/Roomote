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
        url: 'https://github.com/acme/widgets/commit/2222222',
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
      generateAnnouncement: vi.fn().mockResolvedValue({
        summary: 'Adds exports and strengthens widget validation.',
        imageCandidateId: null,
      }),
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
    expect(dependencies.generateAnnouncement).toHaveBeenCalledWith(
      expect.stringContaining('Pushed by: alice'),
    );
    expect(dependencies.findRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        repository: expect.objectContaining({ externalId: '42' }),
      }),
    );
    expect(dependencies.generateAnnouncement).toHaveBeenCalledWith(
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
              '/automation-icons/git-merge.png',
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
                  url: 'https://github.com/acme/widgets/compare/before...after',
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

  it('grounds the artifact announcement in verified PR context and links the PR', async () => {
    const { dependencies, postMessage } = createDependencies();
    dependencies.findRepository.mockResolvedValue({
      defaultBranch: 'develop',
      fullName: 'RooCodeInc/Roomote',
    });

    await handleMergeAnnouncerPush(
      createPayload({
        ref: 'refs/heads/develop',
        commitCount: 1,
        commits: [
          {
            id: 'd17604dc8bbca8a20ebe1d68f722f72889c95c5e',
            message: 'fix: keep Session artifacts in execution details (#1896)',
            url: 'https://github.com/RooCodeInc/Roomote/commit/d17604dc',
          },
        ],
        pullRequest: {
          number: 1896,
          url: 'https://github.com/RooCodeInc/Roomote/pull/1896',
          title: '[Improve] Keep Session artifacts in execution details',
          body: 'Open artifacts inside the execution-details panel without leaving the Session.',
          changedFileCount: 2,
          additions: 271,
          deletions: 100,
          changedFiles: [
            {
              path: 'apps/web/src/app/(sandbox)/sessions/[sessionId]/SessionWorkspace.tsx',
              status: 'modified',
              additions: 92,
              deletions: 9,
            },
          ],
        },
      }),
      dependencies,
    );

    expect(dependencies.generateAnnouncement).toHaveBeenCalledWith(
      expect.stringContaining(
        'Open artifacts inside the execution-details panel without leaving the Session.',
      ),
    );
    expect(dependencies.generateAnnouncement).toHaveBeenCalledWith(
      expect.stringContaining(
        'modified apps/web/src/app/(sandbox)/sessions/[sessionId]/SessionWorkspace.tsx (+92/-9)',
      ),
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            child_blocks: expect.arrayContaining([
              expect.objectContaining({
                type: 'actions',
                elements: expect.arrayContaining([
                  expect.objectContaining({
                    action_id: 'merge_announcer_view_changes',
                    url: 'https://github.com/RooCodeInc/Roomote/pull/1896',
                  }),
                ]),
              }),
            ]),
          }),
        ],
      }),
    );
  });

  it('includes one representative PR image in the Slack announcement', async () => {
    const { dependencies, postMessage } = createDependencies();
    dependencies.generateAnnouncement.mockResolvedValue({
      summary: 'Updates the saved settings experience.',
      imageCandidateId: 'unknown-candidate',
    });

    await handleMergeAnnouncerPush(
      createPayload({
        pullRequest: {
          number: 7,
          url: 'https://github.com/acme/widgets/pull/7',
          title: 'Ship widget export',
          changedFileCount: 2,
          additions: 20,
          deletions: 4,
          imageCandidates: [
            {
              id: 'image-1',
              url: 'https://github.com/user-attachments/assets/product-preview',
              altText: 'Product screenshot after save',
              surroundingText: 'The refreshed settings screen after save.',
            },
          ],
        },
      }),
      dependencies,
    );

    const postedBlocks = postMessage.mock.calls[0]?.[0]?.blocks;
    expect(postedBlocks).toEqual([
      expect.objectContaining({
        type: 'container',
        child_blocks: expect.arrayContaining([
          {
            type: 'image',
            image_url:
              'https://github.com/user-attachments/assets/product-preview',
            alt_text: 'Product screenshot after save',
          },
        ]),
      }),
    ]);
    const container = postedBlocks?.[0];
    expect(
      container?.child_blocks?.filter(
        (block: { type?: string }) => block.type === 'image',
      ),
    ).toHaveLength(1);
  });

  it('uses the merge-summary model candidate choice when it is valid', async () => {
    const { dependencies, postMessage } = createDependencies();
    dependencies.generateAnnouncement.mockResolvedValue({
      summary: 'Updates the saved settings experience.',
      imageCandidateId: 'image-2',
    });

    await handleMergeAnnouncerPush(
      createPayload({
        pullRequest: {
          number: 7,
          url: 'https://github.com/acme/widgets/pull/7',
          title: 'Update settings',
          changedFileCount: 2,
          additions: 20,
          deletions: 4,
          imageCandidates: [
            {
              id: 'image-1',
              url: 'https://cdn.example.com/architecture.png',
              altText: 'Architecture',
              surroundingText: 'Internal architecture diagram.',
            },
            {
              id: 'image-2',
              url: 'https://cdn.example.com/settings.png',
              altText: 'Settings screenshot',
              surroundingText: 'Updated settings after save.',
            },
          ],
        },
      }),
      dependencies,
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            child_blocks: expect.arrayContaining([
              expect.objectContaining({
                type: 'image',
                image_url: 'https://cdn.example.com/settings.png',
              }),
            ]),
          }),
        ],
      }),
    );
  });

  it('retries a rejected Slack image announcement without the image', async () => {
    const { dependencies, postMessage } = createDependencies();
    postMessage
      .mockRejectedValueOnce(new Error('invalid_blocks'))
      .mockResolvedValueOnce(undefined);

    const result = await handleMergeAnnouncerPush(
      createPayload({
        pullRequest: {
          number: 7,
          url: 'https://github.com/acme/widgets/pull/7',
          title: 'Update settings',
          changedFileCount: 1,
          additions: 10,
          deletions: 2,
          imageCandidates: [
            {
              id: 'image-1',
              url: 'https://cdn.example.com/settings.png',
              altText: 'Settings screenshot',
              surroundingText: 'Updated settings after save.',
            },
          ],
        },
      }),
      dependencies,
    );

    expect(result.status).toBe('ok');
    expect(postMessage).toHaveBeenCalledTimes(2);
    const firstContainer = postMessage.mock.calls[0]?.[0]?.blocks?.[0];
    const secondContainer = postMessage.mock.calls[1]?.[0]?.blocks?.[0];
    expect(
      firstContainer?.child_blocks?.some(
        (block: { type?: string }) => block.type === 'image',
      ),
    ).toBe(true);
    expect(
      secondContainer?.child_blocks?.some(
        (block: { type?: string }) => block.type === 'image',
      ),
    ).toBe(false);
  });

  it('omits the Slack image block when PR context has no image', async () => {
    const { dependencies, postMessage } = createDependencies();

    await handleMergeAnnouncerPush(
      createPayload({
        pullRequest: {
          number: 7,
          url: 'https://github.com/acme/widgets/pull/7',
          title: 'Ship widget export',
          changedFileCount: 2,
          additions: 20,
          deletions: 4,
        },
      }),
      dependencies,
    );

    const container = postMessage.mock.calls[0]?.[0]?.blocks?.[0];
    expect(
      container?.child_blocks?.some(
        (block: { type?: string }) => block.type === 'image',
      ),
    ).toBe(false);
  });

  it('falls back to the pushed commit when no compare URL is available', async () => {
    const { dependencies, postMessage } = createDependencies();

    await handleMergeAnnouncerPush(
      createPayload({ compareUrl: null }),
      dependencies,
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            child_blocks: expect.arrayContaining([
              expect.objectContaining({
                type: 'actions',
                elements: expect.arrayContaining([
                  expect.objectContaining({
                    action_id: 'merge_announcer_view_changes',
                    url: 'https://github.com/acme/widgets/commit/2222222',
                  }),
                ]),
              }),
            ]),
          }),
        ],
      }),
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
      createPayload({
        provider: 'gitea',
        pusher: 'fallback-pusher',
        pullRequest: {
          number: 7,
          url: 'https://gitea.example.com/acme/widgets/pulls/7',
          title: 'Ship widget export',
          changedFileCount: 2,
          additions: 20,
          deletions: 4,
        },
      }),
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
            expect.objectContaining({
              text: 'View changes',
              url: 'https://gitea.example.com/acme/widgets/pulls/7',
            }),
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
          url: 'https://github.com/acme/widgets/pull/7',
          title: 'Ship widget export',
          body: `API_TOKEN=supersecretvalue\n${'supporting context '.repeat(300)}`,
          changedFileCount: 21,
          additions: 231,
          deletions: 210,
          changedFiles,
          imageCandidates: [
            {
              id: 'image-1',
              url: 'https://cdn.example.com/settings.png',
              altText: 'Settings screenshot',
              surroundingText: 'The updated settings screen after save.',
            },
          ],
        },
      }),
      dependencies,
    );

    const prompt = dependencies.generateAnnouncement.mock
      .calls[0]?.[0] as string;
    expect(prompt).toContain('one or two conversational sentences');
    expect(prompt).toContain('Do not use bullets or headings');
    expect(prompt).toContain(
      'engineer quickly messaging a coworker about what shipped',
    );
    expect(prompt).toContain('casual, everyday language');
    expect(prompt).toContain(
      'single main practical user or operational benefit',
    );
    expect(prompt).toContain(
      'do not enumerate every platform, integration, implementation detail, edge case, or internal mechanism',
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
    expect(prompt).toContain('Eligible image candidates');
    expect(prompt).toContain('"id":"image-1"');
    expect(prompt).toContain('The updated settings screen after save.');
    expect(prompt).toContain('set imageCandidateId');
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
    expect(dependencies.generateAnnouncement).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('falls back to commit subjects when helper summary generation fails', async () => {
    const { dependencies, postMessage } = createDependencies();
    dependencies.generateAnnouncement.mockRejectedValue(
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
    dependencies.generateAnnouncement.mockRejectedValue(
      new Error('model unavailable'),
    );

    await handleMergeAnnouncerPush(
      createPayload({
        pullRequest: {
          number: 7,
          url: 'https://github.com/acme/widgets/pull/7',
          title: '<!channel> Ship widget & <export>!',
          body: 'Detailed rationale',
          changedFileCount: 2,
          additions: 20,
          deletions: 4,
          imageCandidates: [
            {
              id: 'image-1',
              url: 'https://cdn.example.com/fallback.png',
              altText: 'Fallback screenshot',
              surroundingText: 'Detailed rationale',
            },
          ],
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
              {
                type: 'image',
                image_url: 'https://cdn.example.com/fallback.png',
                alt_text: 'Fallback screenshot',
              },
            ]),
          }),
        ],
      }),
    );
  });
});
