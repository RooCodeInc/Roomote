import { waitForIntegrationToolApproval } from './tool-approval-wait';

describe('waitForIntegrationToolApproval', () => {
  it.each([
    ['rejected'],
    ['cancelled'],
    ['consumed'],
    ['auto_approved'],
    ['auto_rejected'],
    ['not_found'],
    [null],
  ] as const)('treats %s as a rejected terminal state', async (status) => {
    await expect(
      waitForIntegrationToolApproval({
        readStatus: async () => status,
        pollMs: 0,
      }),
    ).resolves.toBe('rejected');
  });

  it('polls pending approvals until they are approved', async () => {
    const statuses: Array<'pending' | 'approved'> = [
      'pending',
      'pending',
      'approved',
    ];
    const readStatus = vi.fn(async () => statuses.shift() ?? 'approved');

    await expect(
      waitForIntegrationToolApproval({ readStatus, pollMs: 0 }),
    ).resolves.toBe('approved');
    expect(readStatus).toHaveBeenCalledTimes(3);
  });

  it('returns expired without trying to claim', async () => {
    const claimApproved = vi.fn(async () => true);
    await expect(
      waitForIntegrationToolApproval({
        readStatus: async () => 'expired',
        claimApproved,
      }),
    ).resolves.toBe('expired');
    expect(claimApproved).not.toHaveBeenCalled();
  });

  it('claims an approved decision exactly once and fails closed if unavailable', async () => {
    const claimed = vi.fn(async () => true);
    await expect(
      waitForIntegrationToolApproval({
        readStatus: async () => 'approved',
        claimApproved: claimed,
      }),
    ).resolves.toBe('approved');
    expect(claimed).toHaveBeenCalledTimes(1);

    await expect(
      waitForIntegrationToolApproval({
        readStatus: async () => 'approved',
        claimApproved: async () => false,
      }),
    ).resolves.toBe('invalid');
  });

  it('expires an approval once its waiting deadline passes', async () => {
    const expire = vi.fn(async () => undefined);
    await expect(
      waitForIntegrationToolApproval({
        readStatus: async () => 'pending',
        deadline: Date.now() - 1,
        expire,
      }),
    ).resolves.toBe('expired');
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('stops before reading or claiming after an abort', async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const unread = vi.fn(async () => 'pending' as const);
    await expect(
      waitForIntegrationToolApproval({
        readStatus: unread,
        signal: alreadyAborted.signal,
      }),
    ).resolves.toBe('aborted');
    expect(unread).not.toHaveBeenCalled();

    const duringRead = new AbortController();
    const claimApproved = vi.fn(async () => true);
    await expect(
      waitForIntegrationToolApproval({
        readStatus: async () => {
          duringRead.abort();
          return 'approved';
        },
        claimApproved,
        signal: duringRead.signal,
      }),
    ).resolves.toBe('aborted');
    expect(claimApproved).not.toHaveBeenCalled();
  });

  it('stays aborted when the caller leaves while an approval is claimed', async () => {
    const controller = new AbortController();
    await expect(
      waitForIntegrationToolApproval({
        readStatus: async () => 'approved',
        claimApproved: async () => {
          controller.abort();
          return true;
        },
        signal: controller.signal,
      }),
    ).resolves.toBe('aborted');
  });

  it('interrupts the polling delay when the caller leaves', async () => {
    const controller = new AbortController();
    const waiting = waitForIntegrationToolApproval({
      readStatus: async () => 'pending',
      signal: controller.signal,
      pollMs: 60_000,
    });

    controller.abort();
    await expect(waiting).resolves.toBe('aborted');
  });
});
