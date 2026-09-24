vi.mock('@roomote/sdk/client', () => ({ sdk: {} }));

import {
  createTaskToolApprovalRelay,
  resolveTaskToolsForAsks,
} from '../opencode-server/tool-approvals';

const ask = {
  requestId: 'per_1',
  sessionId: 'ses_1',
  permission: 'linear_save_issue',
  messageId: 'msg_1',
  callId: 'call_1',
};

function setup(
  statuses: string[] = [],
  request: unknown = { outcome: 'pending', approvalId: 'approval-1' },
  userRequest: string | undefined = 'File the bug.',
) {
  const client = {
    message: vi.fn(async () => ({
      parts: [
        { type: 'text' },
        { type: 'tool', callID: 'call_0', state: { input: { other: true } } },
        { type: 'tool', callID: 'call_1', state: { input: { title: 'Hi' } } },
      ],
    })),
    replyPermission: vi.fn(async () => true),
  };
  const api = {
    request: vi.fn(async () => request),
    status: vi.fn(async () => ({ status: statuses.shift() ?? 'pending' })),
  };
  const pendingCounts: number[] = [];
  const relay = createTaskToolApprovalRelay({
    tools: {
      linear_save_issue: { integrationId: 'linear', toolName: 'save_issue' },
    },
    client: client as never,
    api: api as never,
    logger: { warn: vi.fn() },
    signal: new AbortController().signal,
    getUserRequest: () => userRequest,
    pollMs: 1,
    onPendingCountChange: (pending) => pendingCounts.push(pending),
  });
  return { client, api, relay, pendingCounts };
}

const replied = (client: { replyPermission: ReturnType<typeof vi.fn> }) =>
  vi.waitFor(() => expect(client.replyPermission).toHaveBeenCalled());

describe('createTaskToolApprovalRelay', () => {
  it("records the paused call's own arguments and resumes it once approved", async () => {
    const { client, api, relay, pendingCounts } = setup([
      'pending',
      'approved',
    ]);
    relay.handleAsk(ask);
    // A repeated event for the same native request is one ask.
    relay.handleAsk(ask);
    await replied(client);

    expect(api.request).toHaveBeenCalledTimes(1);
    expect(api.request).toHaveBeenCalledWith({
      integrationId: 'linear',
      toolName: 'save_issue',
      nativeRequestId: 'per_1',
      args: { title: 'Hi' },
      userRequest: 'File the bug.',
    });
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(client.replyPermission).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'per_1', reply: 'once' }),
    );
    await vi.waitFor(() => expect(pendingCounts).toEqual([1, 0]));
  });

  it("sends the prompt's visible request, without injected blocks, bounded", async () => {
    const wrapped = setup(
      [],
      { outcome: 'approved' },
      '<environment-instructions>Use pnpm.</environment-instructions>\n<request>File the bug.</request>',
    );
    wrapped.relay.handleAsk(ask);
    await replied(wrapped.client);
    expect(wrapped.api.request).toHaveBeenCalledWith(
      expect.objectContaining({ userRequest: 'File the bug.' }),
    );

    const long = setup([], { outcome: 'approved' }, 'x'.repeat(25_000));
    long.relay.handleAsk(ask);
    await replied(long.client);
    expect(long.api.request).toHaveBeenCalledWith(
      expect.objectContaining({ userRequest: 'x'.repeat(20_000) }),
    );
  });

  it('sends no request when the harness has none', async () => {
    const { client, api, relay } = setup([], { outcome: 'approved' }, '  ');
    relay.handleAsk(ask);
    await replied(client);
    expect(api.request).toHaveBeenCalledWith(
      expect.not.objectContaining({ userRequest: expect.anything() }),
    );
  });

  it.each([
    ['rejected', 'rejected this tool call'],
    ['cancelled', 'rejected this tool call'],
    ['expired', 'did not answer in time'],
    ['not_found', 'rejected this tool call'],
  ])('rejects the ask when the approval is %s', async (status, message) => {
    const { client, relay } = setup([status]);
    relay.handleAsk(ask);
    await replied(client);
    expect(client.replyPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        reply: 'reject',
        message: expect.stringContaining(message),
      }),
    );
  });

  it.each([['approved'], ['not_required']])(
    'runs the call without a card when the outcome is %s',
    async (outcome) => {
      const { client, api, relay } = setup([], { outcome });
      relay.handleAsk(ask);
      await replied(client);
      expect(api.status).not.toHaveBeenCalled();
      expect(client.replyPermission).toHaveBeenCalledWith(
        expect.objectContaining({ reply: 'once' }),
      );
    },
  );

  it('rejects with the Auto mode tool error when the outcome is denied', async () => {
    const { client, api, relay } = setup([], {
      outcome: 'denied',
      reason: 'it was assessed as risky',
    });
    relay.handleAsk(ask);
    await replied(client);
    expect(api.status).not.toHaveBeenCalled();
    expect(client.replyPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        reply: 'reject',
        message: expect.stringContaining(
          'Auto mode blocked this tool call because it was assessed as risky and the session owner was away',
        ),
      }),
    );
  });

  it('rejects when nobody can approve, the tool is unknown, or the relay fails', async () => {
    const unavailable = setup([], { outcome: 'unavailable' });
    unavailable.relay.handleAsk(ask);
    await replied(unavailable.client);
    expect(unavailable.client.replyPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        reply: 'reject',
        message: expect.stringContaining('nobody who can approve'),
      }),
    );

    const unknown = setup();
    unknown.relay.handleAsk({ ...ask, permission: 'other_tool' });
    await replied(unknown.client);
    expect(unknown.api.request).not.toHaveBeenCalled();
    expect(unknown.client.replyPermission).toHaveBeenCalledWith(
      expect.objectContaining({ reply: 'reject' }),
    );

    const failing = setup();
    failing.api.request.mockRejectedValue(new Error('offline'));
    failing.relay.handleAsk(ask);
    await replied(failing.client);
    expect(failing.client.replyPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        reply: 'reject',
        message: expect.stringContaining('could not be completed'),
      }),
    );
    await vi.waitFor(() => expect(failing.pendingCounts).toEqual([1, 0]));
  });

  it('maps native keys to real tool names, refusing any key two tools share', async () => {
    const warn = vi.fn();
    const tools = await resolveTaskToolsForAsks({
      mcpServers: {
        linear: {
          type: 'streamable-http',
          url: 'https://x/linear',
          headers: {},
        },
        'my.notes': {
          type: 'streamable-http',
          url: 'https://x/notes',
          headers: {},
        },
        a: { type: 'streamable-http', url: 'https://x/a', headers: {} },
        a_b: { type: 'streamable-http', url: 'https://x/a_b', headers: {} },
        local: { type: 'stdio', command: 'x', args: [], env: {} },
        broken: {
          type: 'streamable-http',
          url: 'https://x/broken',
          headers: {},
        },
      },
      approvals: {
        // An explicitly gated tool that collides with a listed one.
        tools: {
          linear_get_issue: { integrationId: 'linear', toolName: 'get.issue' },
        },
        autoServers: ['linear', 'my.notes', 'a', 'a_b', 'local', 'broken'],
      },
      logger: { warn },
      listToolNames: async (server) => {
        if (server.url.endsWith('/broken')) throw new Error('offline');
        if (server.url.endsWith('/notes'))
          return ['run.query', 'run_query', 'list'];
        if (server.url.endsWith('/a')) return ['b_c', 'x'];
        if (server.url.endsWith('/a_b')) return ['c'];
        return ['save_issue', 'get_issue'];
      },
    });
    expect(tools).toEqual({
      linear_save_issue: { integrationId: 'linear', toolName: 'save_issue' },
      my_notes_list: { integrationId: 'my.notes', toolName: 'list' },
      a_x: { integrationId: 'a', toolName: 'x' },
    });
    // Within a server, across servers, and against an explicit rule.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('my_notes_run_query'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('a_b_c'));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('linear_get_issue'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken'));
  });
});
