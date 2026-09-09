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
  it('does not authorize recovery after an instruction delivery was lost', async () => {
    const guard = new FastAgentTaskMessageGuard();
    guard.restoreRecoveryHistory(
      [
        action({
          continuation: 'instruction',
          instructionId: 'human-1',
          status: 'unknown',
          result: undefined,
        }),
      ],
      ['task-1'],
    );
    const deliver = vi.fn();
    expect(
      await guard.send('task-1', args, deliver, { kind: 'recovery' }),
    ).toMatchObject({
      success: false,
      delivery: 'not_accepted',
      recovery: 'budget_exhausted',
    });
    expect(deliver).not.toHaveBeenCalled();
  });

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

  const recovery = { kind: 'recovery' } as const;
  const exhausted = {
    success: false,
    delivery: 'not_accepted',
    recovery: 'budget_exhausted',
  };

  it('reconstructs the budget across runs without restoring cross-turn receipts', async () => {
    const events = [
      action({ continuation: 'instruction', instructionId: 'human-1' }),
    ];
    const first = new FastAgentTaskMessageGuard();
    first.restoreRecoveryHistory(events, ['task-1']);
    const deliver = vi.fn().mockResolvedValue({ success: true });
    const receipt = await first.send('task-1', args, deliver, recovery);
    events.push(
      action({ continuation: 'recovery', result: JSON.stringify(receipt) }),
    );
    expect(await first.send('task-1', args, deliver, recovery)).toEqual(
      receipt,
    );
    expect(
      await first.send('task-1', { message: 'Different' }, deliver, recovery),
    ).toMatchObject(exhausted);
    first.clear();
    expect(await first.send('task-1', args, deliver, recovery)).toMatchObject(
      exhausted,
    );

    const second = new FastAgentTaskMessageGuard();
    second.restoreRecoveryHistory(events, ['task-1']);
    expect(await second.send('task-1', args, deliver, recovery)).toMatchObject(
      exhausted,
    );
    expect(deliver).toHaveBeenCalledOnce();
    expect(await second.send('task-2', args, deliver, recovery)).toMatchObject({
      success: true,
    });
  });

  it('combines same-turn restore and history without accepting a second recovery', async () => {
    const event = action({ continuation: 'recovery' });
    const guard = new FastAgentTaskMessageGuard();
    guard.restore([event], ['task-1']);
    guard.restoreRecoveryHistory([event], ['task-1']);
    const deliver = vi.fn();
    expect(await guard.send('task-1', args, deliver, recovery)).toMatchObject({
      success: true,
    });
    expect(
      await guard.send('task-1', { message: 'Different' }, deliver, recovery),
    ).toMatchObject(exhausted);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('resets only for an accepted new explicit instruction ID, even with identical text', async () => {
    const guard = new FastAgentTaskMessageGuard();
    const deliver = vi.fn().mockResolvedValue({ success: true });
    const instruction = {
      kind: 'instruction',
      instructionId: 'human-1',
    } as const;
    await guard.send('task-1', args, deliver, instruction);
    await guard.send('task-1', args, deliver, recovery);
    guard.clear();
    await guard.send('task-1', args, deliver, instruction);
    expect(await guard.send('task-1', args, deliver, recovery)).toMatchObject(
      exhausted,
    );
    await guard.send('task-1', args, deliver, {
      ...instruction,
      instructionId: 'human-2',
    });
    expect(await guard.send('task-1', args, deliver, recovery)).toMatchObject({
      success: true,
    });
    guard.clear();
    await guard.send('task-1', args, deliver, instruction);
    expect(await guard.send('task-1', args, deliver, recovery)).toMatchObject(
      exhausted,
    );
    expect(deliver).toHaveBeenCalledTimes(6);
  });

  it.each([
    { success: false, delivery: 'not_accepted' },
    { success: false },
    { success: true, delivery: 'unknown' },
  ])('does not reset for an instruction with result %j', async (result) => {
    const guard = new FastAgentTaskMessageGuard();
    guard.restoreRecoveryHistory(
      [action({ continuation: 'recovery' })],
      ['task-1'],
    );
    await guard.send('task-1', args, async () => result, {
      kind: 'instruction',
      instructionId: 'new',
    });
    guard.clear();
    const deliver = vi.fn();
    expect(await guard.send('task-1', args, deliver, recovery)).toMatchObject(
      exhausted,
    );
    expect(deliver).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])(
    'does not reset for empty instruction ID %j or default sends',
    async (instructionId) => {
      const guard = new FastAgentTaskMessageGuard();
      guard.restoreRecoveryHistory(
        [action({ continuation: 'recovery' })],
        ['task-1'],
      );
      const deliver = vi.fn().mockResolvedValue({ success: true });
      await guard.send('task-1', args, deliver, {
        kind: 'instruction',
        instructionId,
      });
      await guard.send('task-1', args, deliver);
      expect(await guard.send('task-1', args, deliver, recovery)).toMatchObject(
        exhausted,
      );
    },
  );

  it('reconstructs accepted instruction IDs without letting repeats reset the budget', async () => {
    const initial = action({
      continuation: 'instruction',
      instructionId: 'human-1',
    });
    const recovered = action({ continuation: 'recovery' });
    const guard = new FastAgentTaskMessageGuard();
    guard.restoreRecoveryHistory([initial, recovered, initial], ['task-1']);
    const deliver = vi.fn().mockResolvedValue({ success: true });
    expect(await guard.send('task-1', args, deliver, recovery)).toMatchObject(
      exhausted,
    );
    guard.restoreRecoveryHistory(
      [action({ continuation: 'instruction', instructionId: 'human-2' })],
      ['task-1'],
    );
    expect(await guard.send('task-1', args, deliver, recovery)).toMatchObject({
      success: true,
    });
    expect(deliver).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 'unknown', result: undefined },
    { status: 'completed', result: '{truncated' },
    { status: 'failed', result: JSON.stringify({ success: false }) },
    { status: 'unknown', result: JSON.stringify({ delivery: 'not_accepted' }) },
  ] as const)(
    'conservatively consumes all current tasks for untargeted $status recovery',
    async (event) => {
      const guard = new FastAgentTaskMessageGuard();
      guard.restoreRecoveryHistory(
        [action({ ...event, continuation: 'recovery' })],
        ['task-1', 'task-2'],
      );
      guard.clear();
      const deliver = vi.fn();
      for (const taskId of ['task-1', 'task-2']) {
        expect(await guard.send(taskId, args, deliver, recovery)).toMatchObject(
          exhausted,
        );
      }
      expect(deliver).not.toHaveBeenCalled();
    },
  );

  it('ignores legacy history and definite recovery rejections without resetting prior consumption', async () => {
    const guard = new FastAgentTaskMessageGuard();
    const rejected = action({
      continuation: 'recovery',
      status: 'failed',
      result: JSON.stringify({ delivery: 'not_accepted' }),
    });
    guard.restoreRecoveryHistory(
      [action(), action({ status: 'unknown' }), rejected],
      ['task-1'],
    );
    const deliver = vi.fn().mockResolvedValue({ success: true });
    await guard.send('task-1', args, deliver, recovery);
    guard.clear();
    guard.restoreRecoveryHistory(
      [action({ instructionId: 'legacy' }), rejected],
      ['task-1'],
    );
    expect(await guard.send('task-1', args, deliver, recovery)).toMatchObject(
      exhausted,
    );
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('reserves recovery before await, survives clear in flight, and releases explicit rejection', async () => {
    const guard = new FastAgentTaskMessageGuard();
    let resolve!: (result: Record<string, unknown>) => void;
    const deliver = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((done) => {
          resolve = done;
        }),
    );
    const pending = guard.send('task-1', args, deliver, recovery);
    expect(await guard.send('task-1', args, deliver, recovery)).toMatchObject(
      exhausted,
    );
    guard.clear();
    expect(
      await guard.send('task-1', { message: 'Different' }, deliver, recovery),
    ).toMatchObject(exhausted);
    resolve({ success: false, delivery: 'not_accepted' });
    await pending;
    expect(
      await guard.send(
        'task-1',
        args,
        async () => ({ success: true }),
        recovery,
      ),
    ).toMatchObject({ success: true });
    expect(deliver).toHaveBeenCalledOnce();
  });

  it.each(['failure', 'throw'])(
    'keeps recovery consumed after %s and clear',
    async (mode) => {
      const guard = new FastAgentTaskMessageGuard();
      const deliver = vi.fn(async () => {
        if (mode === 'throw') throw new Error('Lost');
        return { success: false };
      });
      expect(await guard.send('task-1', args, deliver, recovery)).toMatchObject(
        { delivery: 'unknown' },
      );
      guard.clear();
      expect(await guard.send('task-1', args, deliver, recovery)).toMatchObject(
        exhausted,
      );
      expect(deliver).toHaveBeenCalledOnce();
    },
  );
});
