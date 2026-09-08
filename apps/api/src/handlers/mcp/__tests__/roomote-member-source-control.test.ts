import { z } from 'zod';
import type { McpAuth } from '../middleware';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), write: vi.fn() }));
vi.mock('@roomote/sdk/server', () => ({
  resolveRepositoryRow: mocks.resolve,
  writeSourceControlPullRequestForRepository: mocks.write,
}));
vi.mock('../../environments', () => ({ environmentsRouter: {} }));
vi.mock('../../tasks', () => ({ tasksRouter: {} }));
vi.mock('../../sessions', () => ({ sessionsRouter: {} }));

import { registerRoomoteMemberTools } from '../roomote-member-tools';

const auth: McpAuth = {
  userId: 'member-1',
  authContext: { tokenType: 'auth', userId: 'member-1', version: 1 },
};
const base = {
  sourceControlProvider: 'github',
  repositoryFullName: 'owner/repo',
  prNumber: 17,
};

function register(memberAuth = auth) {
  let tool!: {
    schema: z.ZodTypeAny;
    call: (args: Record<string, unknown>) => Promise<unknown>;
  };
  registerRoomoteMemberTools(
    {
      registerTool(
        name: string,
        config: { inputSchema: z.ZodTypeAny },
        handler: (args: Record<string, unknown>) => Promise<unknown>,
      ) {
        if (name === 'manage_source_control')
          tool = {
            schema: config.inputSchema,
            call: (args) => handler(config.inputSchema.parse(args)),
          };
      },
    } as never,
    memberAuth,
  );
  return tool;
}

describe('member source control adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockResolvedValue({
      id: 42,
      sourceControlProvider: 'github',
      fullName: 'owner/repo',
    });
    mocks.write.mockResolvedValue({ success: true, applied: true });
  });

  it.each(['github', 'gitlab', 'bitbucket'])(
    'uses the shared resolver and writer for %s without task context or provider-account gates',
    async (sourceControlProvider) => {
      const input = {
        ...base,
        sourceControlProvider,
        action: 'update_pull_request_metadata',
        title: 'Title',
        body: '',
        state: 'closed',
      };
      const result = await register().call(input);
      expect(result).not.toHaveProperty('isError', true);
      expect(mocks.resolve).toHaveBeenCalledWith({
        provider: sourceControlProvider,
        repositoryFullName: 'owner/repo',
      });
      expect(mocks.write).toHaveBeenCalledWith({
        repository: await mocks.resolve.mock.results[0]!.value,
        input,
        requirePullRequestScope: true,
      });
    },
  );

  it('forwards Bitbucket thread replies to the existing shared writer', async () => {
    const repository = {
      id: 42,
      sourceControlProvider: 'bitbucket',
      fullName: 'owner/repo',
    };
    mocks.resolve.mockResolvedValueOnce(repository);
    const input = {
      ...base,
      sourceControlProvider: 'bitbucket',
      action: 'reply_to_pull_request_comment',
      body: 'Reply',
      threadId: '12',
    };
    const result = await register().call(input);
    expect(result).not.toHaveProperty('isError', true);
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith({
      repository,
      input,
      requirePullRequestScope: true,
    });
    expect(JSON.stringify(result)).toContain('"applied":true');
  });

  it.each([
    { action: 'update_pull_request_metadata', state: 'open' },
    { action: 'create_pull_request_comment', body: 'Comment' },
    {
      action: 'update_pull_request_comment',
      body: 'Edited',
      commentId: '12',
      threadId: 'thread',
    },
    {
      action: 'reply_to_pull_request_comment',
      body: 'Reply',
      threadId: 'thread',
    },
  ])('accepts bounded $action', async (fields) => {
    await register().call({ ...base, ...fields });
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({ requirePullRequestScope: true }),
    );
  });

  it('surfaces PR scope denials from the shared writer', async () => {
    mocks.write.mockRejectedValueOnce(
      new Error('Comment 12 does not belong to the requested pull request.'),
    );
    const result = await register().call({
      ...base,
      action: 'update_pull_request_comment',
      commentId: '12',
      body: 'Edited',
    });
    expect(result).toHaveProperty('isError', true);
    expect(JSON.stringify(result)).toContain('does not belong');
  });

  it.each([
    { action: 'merge_pull_request' },
    { action: 'create_pull_request_review_comment', body: 'review' },
    { action: 'update_pull_request_metadata', state: 'merged' },
    { action: 'update_pull_request_metadata', state: 'open', base: 'main' },
    { action: 'update_pull_request_metadata', state: 'open', userId: 'other' },
    { action: 'update_pull_request_metadata', state: 'open', taskId: 'fake' },
    { action: 'update_pull_request_metadata', title: '' },
    {
      action: 'update_pull_request_metadata',
      state: 'open',
      sourceControlProvider: undefined,
    },
    {
      action: 'update_pull_request_metadata',
      state: 'open',
      sourceControlProvider: 'ado',
    },
    { action: 'update_pull_request_metadata', state: 'open', prNumber: 0 },
  ])('rejects out-of-scope input %# before lookup', (fields) => {
    expect(() => register().call({ ...base, ...fields })).toThrow();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'update_pull_request_metadata' },
    { action: 'update_pull_request_metadata', state: 'open', commentId: '12' },
    { action: 'create_pull_request_comment', body: ' ' },
    { action: 'create_pull_request_comment', body: 'comment', state: 'closed' },
    { action: 'create_pull_request_comment', body: 'comment', threadId: '12' },
    { action: 'update_pull_request_comment', body: 'comment' },
    { action: 'reply_to_pull_request_comment', body: 'comment' },
    {
      action: 'reply_to_pull_request_comment',
      body: 'comment',
      threadId: '12',
      commentId: '13',
    },
  ])('rejects invalid action fields %# before lookup', async (fields) => {
    expect(await register().call({ ...base, ...fields })).toHaveProperty(
      'isError',
      true,
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([
    {
      userId: undefined,
      authContext: { tokenType: 'auth', userId: '', version: 1 },
    },
    { userId: 'other', authContext: auth.authContext },
    {
      userId: 'member-1',
      authContext: {
        tokenType: 'run',
        userId: 'member-1',
        runId: 1,
        principal: 'user',
        version: 1,
      },
    },
    {
      userId: undefined,
      authContext: {
        tokenType: 'run',
        userId: null,
        runId: 1,
        principal: 'deployment',
        version: 1,
      },
    },
  ] satisfies McpAuth[])(
    'rejects missing, mismatched, and run actors %#',
    async (memberAuth) => {
      expect(
        await register(memberAuth).call({
          ...base,
          action: 'update_pull_request_metadata',
          state: 'closed',
        }),
      ).toHaveProperty('isError', true);
      expect(mocks.resolve).not.toHaveBeenCalled();
    },
  );

  it.each(['Repository inactive', 'Multiple active repositories'])(
    'does not write when shared resolution fails: %s',
    async (message) => {
      mocks.resolve.mockRejectedValueOnce(new Error(message));
      expect(
        await register().call({
          ...base,
          action: 'update_pull_request_metadata',
          state: 'closed',
        }),
      ).toHaveProperty('isError', true);
      expect(mocks.write).not.toHaveBeenCalled();
    },
  );

  it('returns shared-core suspension errors and unsupported provider outcomes honestly', async () => {
    mocks.write.mockRejectedValueOnce(
      new Error('GitHub installation is suspended'),
    );
    expect(
      await register().call({
        ...base,
        action: 'update_pull_request_metadata',
        state: 'closed',
      }),
    ).toHaveProperty('isError', true);
    mocks.write.mockResolvedValueOnce({
      success: true,
      applied: false,
      warnings: ['Unsupported'],
    });
    const result = await register().call({
      ...base,
      action: 'update_pull_request_metadata',
      state: 'open',
    });
    expect(JSON.stringify(result)).toContain('Unsupported');
    expect(JSON.stringify(result)).toContain('false');
  });
});
