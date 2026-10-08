import {
  formatPrBodyAttribution,
  INTEGRATION_TOOL_FAST_CONVERSATION_HEADER,
} from '@roomote/types';
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('@roomote/db/server', async (original) => ({
  ...(await original<typeof import('@roomote/db/server')>()),
  getSessionForFastConversation: getSession,
}));
import { normalizeNativeGitHubPrProvenance } from '../github-pr-provenance';

const conversationId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const headers = new Headers({
  [INTEGRATION_TOOL_FAST_CONVERSATION_HEADER]: conversationId,
});
const auth = { tokenType: 'auth' as const, userId: 'actor' };
const request = (body?: string) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'create_pull_request',
    arguments: {
      owner: 'acme',
      repo: 'web',
      title: 'Change',
      head: 'feature',
      base: 'main',
      ...(body === undefined ? {} : { body }),
    },
  },
});
beforeEach(() => {
  getSession.mockReset().mockResolvedValue({
    id: sessionId,
    privacy: 'shared',
    visibility: 'visible',
  });
});

it.each(['interactive', 'automation'])(
  'adds canonical session provenance to %s native PRs without human or Slack attribution',
  async (origin) => {
    getSession.mockResolvedValue({
      id: sessionId,
      privacy: 'shared',
      visibility: origin === 'automation' ? 'hidden' : 'visible',
    });
    const result = (await normalizeNativeGitHubPrProvenance({
      auth,
      headers,
      request: request('## Changes\n\nDone.'),
    })) as ReturnType<typeof request>;
    expect(result.params.arguments.body).toContain(`[View the session](`);
    expect(result.params.arguments.body).toContain(`/sessions/${sessionId}?`);
    expect(result.params.arguments.body).not.toContain(conversationId);
    expect(result.params.arguments.body).toContain('Created by Roomote.');
    expect(result.params.arguments.body).toContain('## Changes\n\nDone.');
    expect(result.params.arguments).toMatchObject({
      owner: 'acme',
      repo: 'web',
      head: 'feature',
      base: 'main',
    });
  },
);

it('canonicalizes duplicate caller provenance and handles an omitted body', async () => {
  const old = formatPrBodyAttribution(
    'Created by Roomote.',
    '[View the task](https://example.com/task/old)',
  );
  for (const body of [undefined, `${old}\n\n${old}\n\nDone.`]) {
    const result = (await normalizeNativeGitHubPrProvenance({
      auth,
      headers,
      request: request(body),
    })) as ReturnType<typeof request>;
    expect(
      result.params.arguments.body?.match(/roomote:pr-attribution:start/g),
    ).toHaveLength(1);
    expect(result.params.arguments.body).not.toContain('/task/old');
  }
});

it.each(['absent header', 'missing session', 'other private owner'])(
  'refuses %s rather than inventing origin provenance',
  async (reason) => {
    if (reason === 'missing session') getSession.mockResolvedValue(null);
    if (reason === 'other private owner')
      getSession.mockResolvedValue({
        id: sessionId,
        privacy: 'private',
        privateOwnerUserId: 'other',
      });
    await expect(
      normalizeNativeGitHubPrProvenance({
        auth,
        headers: reason === 'absent header' ? new Headers() : headers,
        request: request(),
      }),
    ).rejects.toThrow('accessible originating session');
  },
);

it('does not alter unrelated calls', async () => {
  const input = {
    ...request(),
    params: {
      name: 'update_pull_request',
      arguments: { body: 'Authored body' },
    },
  };
  expect(
    await normalizeNativeGitHubPrProvenance({ auth, headers, request: input }),
  ).toBe(input);
  expect(getSession).not.toHaveBeenCalled();
});

it('preserves caller provenance identity while canonicalizing its session link', async () => {
  const body = formatPrBodyAttribution(
    'Opened on behalf of @participant.',
    '[View the task](https://example.com/task/old)',
  );
  const result = (await normalizeNativeGitHubPrProvenance({
    auth,
    headers,
    request: request(body),
  })) as ReturnType<typeof request>;
  expect(result.params.arguments.body).toContain(
    'Opened on behalf of @participant.',
  );
  expect(result.params.arguments.body).toContain(`/sessions/${sessionId}?`);
  expect(result.params.arguments.body).not.toContain('/task/old');
});
