const mocks = vi.hoisted(() => ({
  request: vi.fn(
    async (_input: unknown) => ({ outcome: 'approved' }) as unknown,
  ),
  status: vi.fn(async (_input: unknown) => 'pending' as string),
  claim: vi.fn(async (_input: unknown) => true),
}));

vi.mock('@roomote/sdk/server/task-tool-approvals', () => ({
  requestTaskToolApproval: mocks.request,
  getTaskToolApprovalStatus: mocks.status,
}));
vi.mock('@roomote/db/server', () => ({
  fingerprintIntegrationToolCall: (input: unknown) => JSON.stringify(input),
}));
vi.mock('../tool-approval-enforcement', () => ({
  claimProxyTaskToolCall: mocks.claim,
  describeProxyToolApprovalBlock: (toolName: string, block: string) =>
    `${toolName}:${block}`,
}));

import { decideUnaskedTaskToolCall } from '../unasked-task-tool-call';

const call = {
  runId: 7,
  taskId: 'task-1',
  integrationId: 'linear',
  policyScope: 'deployment' as const,
  toolName: 'save_issue',
  args: { title: 'Hi' },
  resolveActingUserId: async () => 'user-1',
  endpoint: {
    url: 'https://roomote.example/api/mcp/linear',
    authorization: 'Bearer run-token',
  },
  pollMs: 1,
};
const refused = { allowed: false, message: 'save_issue:needs_approval' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.request.mockResolvedValue({ outcome: 'approved' });
  mocks.status.mockResolvedValue('pending');
  mocks.claim.mockResolvedValue(true);
});

describe('decideUnaskedTaskToolCall', () => {
  it('asks on the task’s behalf, as its own agent would have', async () => {
    await expect(decideUnaskedTaskToolCall(call)).resolves.toEqual({
      allowed: true,
    });
    const request = mocks.request.mock.calls[0]![0] as {
      resolveServers: () => Promise<unknown>;
    };
    expect(request).toEqual(
      expect.objectContaining({
        runId: 7,
        integrationId: 'linear',
        toolName: 'save_issue',
        args: { title: 'Hi' },
        actingUserId: 'user-1',
        // The same call asked again finds the card that is already open.
        nativeRequestId: `proxy:${JSON.stringify({
          integrationId: 'linear',
          toolName: 'save_issue',
          args: { title: 'Hi' },
        })}`,
        integrationProxy: {
          origin: 'https://roomote.example',
          authorization: 'Bearer run-token',
        },
      }),
    );
    await expect(request.resolveServers()).resolves.toEqual({
      linear: {
        url: 'https://roomote.example/api/mcp/linear',
        headers: {},
        toolApprovalPolicyScope: 'deployment',
      },
    });
    // The approval decided for this call is consumed.
    expect(mocks.claim).toHaveBeenCalledWith({
      taskId: 'task-1',
      integrationId: 'linear',
      toolName: 'save_issue',
      args: { title: 'Hi' },
    });
  });

  it('refuses without asking when the call belongs to no task run', async () => {
    await expect(
      decideUnaskedTaskToolCall({ ...call, runId: undefined }),
    ).resolves.toEqual(refused);
    await expect(
      decideUnaskedTaskToolCall({ ...call, taskId: null }),
    ).resolves.toEqual(refused);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('sends the caller’s token nowhere when the request carried none', async () => {
    await decideUnaskedTaskToolCall({
      ...call,
      endpoint: { url: call.endpoint.url, authorization: null },
    });
    expect(mocks.request.mock.calls[0]![0]).not.toHaveProperty(
      'integrationProxy',
    );
  });

  it('lets a call run when nothing gates it any more', async () => {
    mocks.request.mockResolvedValue({ outcome: 'not_required' });
    await expect(decideUnaskedTaskToolCall(call)).resolves.toEqual({
      allowed: true,
    });
  });

  it('tells the agent why a call was not run', async () => {
    mocks.request.mockResolvedValue({
      outcome: 'denied',
      reason: 'it was assessed as risky',
    });
    await expect(decideUnaskedTaskToolCall(call)).resolves.toEqual({
      allowed: false,
      message: expect.stringContaining(
        'because it was assessed as risky and the session owner was away',
      ),
    });
    mocks.request.mockResolvedValue({ outcome: 'paused' });
    await expect(decideUnaskedTaskToolCall(call)).resolves.toEqual({
      allowed: false,
      message: expect.stringContaining('Auto approvals are paused'),
    });
    mocks.request.mockResolvedValue({ outcome: 'unavailable' });
    await expect(decideUnaskedTaskToolCall(call)).resolves.toEqual({
      allowed: false,
      message: expect.stringContaining('nobody who can approve it'),
    });
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('holds the call while the owner decides, then runs it once', async () => {
    mocks.request.mockResolvedValue({ outcome: 'pending', approvalId: 'a-1' });
    mocks.status
      .mockResolvedValueOnce('pending')
      .mockResolvedValueOnce('pending')
      .mockResolvedValueOnce('approved');
    await expect(decideUnaskedTaskToolCall(call)).resolves.toEqual({
      allowed: true,
    });
    expect(mocks.status).toHaveBeenCalledTimes(3);
    expect(mocks.status).toHaveBeenCalledWith({ runId: 7, approvalId: 'a-1' });
    expect(mocks.claim).toHaveBeenCalledTimes(1);

    // An approval another call already used does not run a second one.
    mocks.status.mockResolvedValue('approved');
    mocks.claim.mockResolvedValue(false);
    await expect(decideUnaskedTaskToolCall(call)).resolves.toEqual(refused);
  });

  it('refuses when the owner rejects, does not answer, or the caller leaves', async () => {
    mocks.request.mockResolvedValue({ outcome: 'pending', approvalId: 'a-1' });
    mocks.status.mockResolvedValue('rejected');
    await expect(decideUnaskedTaskToolCall(call)).resolves.toEqual({
      allowed: false,
      message: 'The requester rejected this tool call.',
    });
    mocks.status.mockResolvedValue('expired');
    await expect(decideUnaskedTaskToolCall(call)).resolves.toEqual({
      allowed: false,
      message:
        'The requester did not answer in time; the tool call was not run.',
    });
    expect(mocks.claim).not.toHaveBeenCalled();

    mocks.status.mockClear();
    mocks.status.mockResolvedValue('pending');
    const gone = new AbortController();
    gone.abort();
    await expect(
      decideUnaskedTaskToolCall({ ...call, signal: gone.signal }),
    ).resolves.toEqual(refused);
    expect(mocks.status).not.toHaveBeenCalled();
  });
});
