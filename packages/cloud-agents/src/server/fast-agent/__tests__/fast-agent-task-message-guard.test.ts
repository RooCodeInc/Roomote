import { FastAgentTaskMessageGuard } from '../fast-agent-task-message-guard';
import type { FastAgentTurnAttemptAction } from '../fast-agent-conversation-repository';

const args = { message: 'Run tests', includeAttachments: false };
const action = (
  overrides: Partial<FastAgentTurnAttemptAction> = {},
): FastAgentTurnAttemptAction => ({
  kind: 'action',
  tool: 'send_task_message',
  arguments: args,
  status: 'completed',
  result: JSON.stringify({ success: true, taskId: 'task-1' }),
  ...overrides,
});

describe('FastAgentTaskMessageGuard', () => {
  it('caches accepted retries but allows distinct followups and attachment opt-in', async () => {
    const guard = new FastAgentTaskMessageGuard();
    const deliver = vi.fn().mockResolvedValue({ success: true, queued: true });
    const receipt = await guard.send('task-1', args, deliver);
    expect(await guard.send('task-1', args, deliver)).toEqual(receipt);
    await guard.send('task-1', { message: 'Review tests' }, deliver);
    await guard.send('task-1', { ...args, includeAttachments: true }, deliver);
    expect(await guard.send('task-1', args, deliver)).toEqual(receipt);
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it('releases only explicit definite rejection', async () => {
    const guard = new FastAgentTaskMessageGuard();
    const deliver = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        error: 'Denied',
        delivery: 'not_accepted',
      })
      .mockResolvedValue({ success: true });
    expect(await guard.send('task-1', args, deliver)).toMatchObject({
      error: 'Denied',
      delivery: 'not_accepted',
    });
    expect(await guard.send('task-1', args, deliver)).toMatchObject({
      success: true,
    });
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it.each(['false', 'throw'])(
    'blocks rewording after transport %s and retains the first error',
    async (mode) => {
      const guard = new FastAgentTaskMessageGuard();
      const deliver = vi.fn();
      if (mode === 'throw')
        deliver.mockRejectedValue(new Error('Connection lost'));
      else
        deliver.mockResolvedValue({ success: false, error: 'Connection lost' });
      expect(await guard.send('task-1', args, deliver)).toMatchObject({
        success: false,
        error: 'Connection lost',
        delivery: 'unknown',
        guidance: expect.stringContaining('Do not resend'),
      });
      expect(
        await guard.send(
          'task-1',
          { message: 'Try again differently' },
          deliver,
        ),
      ).toMatchObject({
        success: false,
        delivery: 'unknown',
        error: expect.stringContaining('Check the task'),
      });
      expect(deliver).toHaveBeenCalledOnce();
    },
  );

  it('reserves the whole task synchronously while delivery is in flight', async () => {
    const guard = new FastAgentTaskMessageGuard();
    let resolve!: (result: Record<string, unknown>) => void;
    const deliver = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((done) => {
          resolve = done;
        }),
    );
    const pending = guard.send('task-1', args, deliver);
    expect(await guard.send('task-1', args, deliver)).toMatchObject({
      delivery: 'unknown',
      success: false,
    });
    expect(
      await guard.send('task-1', { message: 'Different' }, deliver),
    ).toMatchObject({ delivery: 'unknown' });
    resolve({ success: true });
    await pending;
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('restores a success receipt with result target taking precedence', async () => {
    const guard = new FastAgentTaskMessageGuard();
    guard.restore(
      [action({ arguments: { ...args, taskId: 'wrong' } })],
      ['other'],
    );
    const deliver = vi.fn().mockResolvedValue({ success: true });
    expect(await guard.send('task-1', args, deliver)).toEqual({
      success: true,
      taskId: 'task-1',
    });
    expect(deliver).not.toHaveBeenCalled();
    await guard.send('task-1', { message: 'Followup' }, deliver);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it.each([
    {
      status: 'failed',
      result: JSON.stringify({ success: false, error: 'Lost' }),
    },
    { status: 'completed', result: JSON.stringify({ success: false }) },
    { status: 'unknown', result: undefined },
    { status: 'completed', result: '{truncated' },
  ] as const)('restores $status as task-wide unknown', async (event) => {
    const guard = new FastAgentTaskMessageGuard();
    guard.restore([action(event)], ['task-1']);
    const deliver = vi.fn();
    expect(
      await guard.send('task-1', { message: 'Reworded' }, deliver),
    ).toMatchObject({ success: false, delivery: 'unknown' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('uses arguments target, and fails closed across current tasks when unresolved', async () => {
    const guard = new FastAgentTaskMessageGuard();
    guard.restore(
      [
        action({
          status: 'unknown',
          arguments: { ...args, taskId: ' task-3 ' },
          result: undefined,
        }),
        action({ status: 'unknown', result: undefined }),
      ],
      ['task-1', 'task-2'],
    );
    const deliver = vi.fn();
    for (const id of ['task-1', 'task-2', 'task-3']) {
      expect(await guard.send(id, args, deliver)).toMatchObject({
        delivery: 'unknown',
      });
    }
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does not reserve replayed definite rejections or clear older uncertainty', async () => {
    const guard = new FastAgentTaskMessageGuard();
    const rejection = action({
      status: 'failed',
      result: JSON.stringify({ success: false, delivery: 'not_accepted' }),
    });
    guard.restore([rejection], ['task-1']);
    const deliver = vi.fn().mockResolvedValue({ success: true });
    await guard.send('task-1', args, deliver);
    expect(deliver).toHaveBeenCalledOnce();
    guard.restore(
      [action({ status: 'unknown' }), rejection, action()],
      ['task-1'],
    );
    expect(await guard.send('task-1', args, deliver)).toMatchObject({
      delivery: 'unknown',
    });
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('clears receipts and unresolved reservations at the human boundary', async () => {
    const guard = new FastAgentTaskMessageGuard();
    guard.restore(
      [
        action(),
        action({
          status: 'unknown',
          arguments: { ...args, taskId: 'task-2' },
          result: undefined,
        }),
      ],
      ['task-1'],
    );
    guard.clear();
    const deliver = vi.fn().mockResolvedValue({ success: true });
    await guard.send('task-1', args, deliver);
    await guard.send('task-2', args, deliver);
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});
