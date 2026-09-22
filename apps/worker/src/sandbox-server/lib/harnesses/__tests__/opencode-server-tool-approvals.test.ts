vi.mock('@roomote/sdk/client', () => ({ sdk: {} }));

import { createTaskToolApprovalRelay } from '../opencode-server/tool-approvals';

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
    getUserRequest: () => 'File the bug.',
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
});
