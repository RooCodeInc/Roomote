import {
  normalizeAdoPush,
  normalizeBitbucketPush,
  normalizeGiteaPush,
  normalizeGitHubPush,
  normalizeGitLabPush,
} from '../merge-announcer-push';
import { adoPushWebhookSchema } from '../ado/types';
import { bitbucketPushWebhookSchema } from '../bitbucket/types';
import { giteaPushWebhookSchema } from '../gitea/types';
import { gitLabPushWebhookSchema } from '../gitlab/types';

describe('Merge announcer push normalization', () => {
  it('normalizes GitHub commit and pusher metadata', () => {
    expect(
      normalizeGitHubPush({
        ref: 'refs/heads/main',
        compare: 'https://github.com/acme/widgets/compare/a...b',
        size: 1,
        pusher: { name: 'alice' },
        sender: { login: 'alice-fallback' },
        repository: {
          id: 1,
          full_name: 'acme/widgets',
          html_url: 'https://github.com/acme/widgets',
        },
        commits: [
          {
            id: 'abc',
            message: 'Ship widget',
            author: { name: 'Bob', username: 'bob' },
          },
        ],
      }),
    ).toMatchObject({
      provider: 'github',
      ref: 'refs/heads/main',
      pusher: 'alice',
      repository: { externalId: '1', host: 'github.com' },
      commits: [{ id: 'abc', author: { username: 'bob' } }],
    });
  });

  it('normalizes GitLab pushes and branch deletion', () => {
    const payload = gitLabPushWebhookSchema.parse({
      object_kind: 'push',
      ref: 'refs/heads/main',
      after: '0000000000000000000000000000000000000000',
      user_username: 'gitlab-user',
      project: {
        id: 2,
        path_with_namespace: 'acme/widgets',
        web_url: 'https://gitlab.example.com/acme/widgets',
      },
      commits: [
        {
          id: 'def',
          message: 'Update widget',
          author: { name: 'Dana', email: 'dana@example.com' },
        },
      ],
    });

    expect(normalizeGitLabPush(payload)).toMatchObject({
      provider: 'gitlab',
      deleted: true,
      pusher: 'gitlab-user',
      repository: { externalId: '2', host: 'gitlab.example.com' },
      commits: [{ author: { email: 'dana@example.com' } }],
    });
  });

  it('normalizes Gitea pusher and author usernames', () => {
    const payload = giteaPushWebhookSchema.parse({
      ref: 'refs/heads/main',
      pusher: { username: 'gitea-user' },
      repository: {
        id: 3,
        full_name: 'acme/widgets',
        html_url: 'https://gitea.example.com/acme/widgets',
      },
      commits: [
        {
          id: 'ghi',
          message: 'Refine widget',
          author: { username: 'erin', name: 'Erin' },
        },
      ],
    });

    expect(normalizeGiteaPush(payload)).toMatchObject({
      provider: 'gitea',
      pusher: 'gitea-user',
      repository: { externalId: '3', host: 'gitea.example.com' },
      commits: [{ author: { username: 'erin' } }],
    });
  });

  it('normalizes Bitbucket branch changes and excludes tag changes', () => {
    const payload = bitbucketPushWebhookSchema.parse({
      actor: { nickname: 'bitbucket-user' },
      repository: {
        uuid: '{repo-4}',
        full_name: 'acme/widgets',
        links: { html: { href: 'https://bitbucket.org/acme/widgets' } },
      },
      push: {
        changes: [
          {
            new: { name: 'main', type: 'branch' },
            commits: [
              {
                hash: 'jkl',
                message: 'Polish widget',
                author: {
                  raw: 'Frank <frank@example.com>',
                  user: { nickname: 'frank' },
                },
              },
            ],
          },
          { new: { name: 'v1.0.0', type: 'tag' }, commits: [] },
        ],
      },
    });

    expect(normalizeBitbucketPush(payload)).toEqual([
      expect.objectContaining({
        provider: 'bitbucket',
        ref: 'refs/heads/main',
        pusher: 'bitbucket-user',
        repository: {
          externalId: '{repo-4}',
          fullName: 'acme/widgets',
          host: 'bitbucket.org',
          htmlUrl: 'https://bitbucket.org/acme/widgets',
        },
        commits: [
          expect.objectContaining({
            author: expect.objectContaining({ username: 'frank' }),
          }),
        ],
      }),
    ]);
  });

  it('normalizes Azure DevOps ref updates and pushed-by attribution', () => {
    const payload = adoPushWebhookSchema.parse({
      id: 'delivery-5',
      eventType: 'git.push',
      resourceContainers: {
        account: { baseUrl: 'https://dev.azure.com/acme/' },
      },
      resource: {
        repository: {
          id: 'repo-5',
          name: 'widgets',
          project: { id: 'project-1', name: 'platform' },
          webUrl: 'https://dev.azure.com/acme/platform/_git/widgets',
        },
        refUpdates: [{ name: 'refs/heads/main' }],
        pushedBy: { displayName: 'Grace Hopper' },
        commits: [
          {
            commitId: 'mno',
            comment: 'Document widget',
            author: { name: 'Heidi', email: 'heidi@example.com' },
          },
        ],
      },
    });

    expect(normalizeAdoPush(payload)).toEqual([
      expect.objectContaining({
        provider: 'ado',
        ref: 'refs/heads/main',
        pusher: 'Grace Hopper',
        repository: expect.objectContaining({
          externalId: 'repo-5',
          host: 'dev.azure.com',
        }),
        commits: [
          expect.objectContaining({
            author: expect.objectContaining({
              name: 'Heidi',
              email: 'heidi@example.com',
            }),
          }),
        ],
      }),
    ]);
  });
});
