import { normalizeAdoCommentWebhookPayload } from '../normalizeCommentWebhook';
import { adoPullRequestCommentWebhookSchema } from '../types';

const mockGetAdoPullRequest = vi.hoisted(() => vi.fn());

vi.mock('@roomote/ado', () => ({
  getAdoPullRequest: mockGetAdoPullRequest,
}));

const pullRequestDetails = {
  pullRequestId: 2,
  title: 'Add usage note to README',
  status: 'active',
  sourceRefName: 'refs/heads/test/webhook-trigger',
  targetRefName: 'refs/heads/main',
  repository: {
    id: '5c210c4f-f090-4f1c-a860-12ed1a7a307a',
    name: 'Test ADO',
    project: { id: '3adb346e', name: 'Test ADO' },
  },
};

// Shape observed from real Azure DevOps deliveries: the comment object is
// the resource itself, with pull request context only present in _links.
const flatCommentPayload = {
  id: 'delivery-1',
  eventType: 'ms.vss-code.git-pullrequest-comment-event',
  resource: {
    id: 1,
    parentCommentId: 0,
    content: '@roomote please summarize this change',
    commentType: 'text',
    author: { id: 'user-1', displayName: 'Dan Riccio' },
    _links: {
      self: {
        href: 'https://dev.azure.com/roomote/_apis/git/repositories/5c210c4f-f090-4f1c-a860-12ed1a7a307a/pullRequests/2/threads/2/comments/1',
      },
      threads: {
        href: 'https://dev.azure.com/roomote/_apis/git/repositories/5c210c4f-f090-4f1c-a860-12ed1a7a307a/pullRequests/2/threads/2',
      },
    },
  },
};

describe('normalizeAdoCommentWebhookPayload', () => {
  afterEach(() => {
    mockGetAdoPullRequest.mockReset();
  });

  it('rehydrates the flat comment delivery into the documented nested shape', async () => {
    mockGetAdoPullRequest.mockResolvedValue(pullRequestDetails);

    const normalized =
      await normalizeAdoCommentWebhookPayload(flatCommentPayload);
    const parsed = adoPullRequestCommentWebhookSchema.parse(normalized);

    expect(mockGetAdoPullRequest).toHaveBeenCalledWith({
      repositoryId: '5c210c4f-f090-4f1c-a860-12ed1a7a307a',
      pullRequestNumber: 2,
    });
    expect(parsed.resource.comment.content).toBe(
      '@roomote please summarize this change',
    );
    expect(parsed.resource.pullRequest.pullRequestId).toBe(2);
    expect(parsed.resource.pullRequest.repository.name).toBe('Test ADO');
  });

  it('leaves the documented nested shape untouched', async () => {
    const nestedPayload = {
      id: 'delivery-2',
      eventType: 'ms.vss-code.git-pullrequest-comment-event',
      resource: {
        comment: { id: 1, content: '@roomote hello' },
        pullRequest: pullRequestDetails,
      },
    };

    await expect(
      normalizeAdoCommentWebhookPayload(nestedPayload),
    ).resolves.toBe(nestedPayload);
    expect(mockGetAdoPullRequest).not.toHaveBeenCalled();
  });

  it('returns the payload unchanged when no pull request link is present', async () => {
    const payload = {
      eventType: 'ms.vss-code.git-pullrequest-comment-event',
      resource: { id: 1, content: 'no links here' },
    };

    await expect(normalizeAdoCommentWebhookPayload(payload)).resolves.toBe(
      payload,
    );
    expect(mockGetAdoPullRequest).not.toHaveBeenCalled();
  });
});
