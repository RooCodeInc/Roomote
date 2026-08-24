import { NonTaskOpenCodeSessionNotFoundError } from '../../non-task-provider-usage';
import { FastAgentOpenCodeSessionManager } from '../fast-agent-opencode-session';

describe('FastAgentOpenCodeSessionManager', () => {
  it('bootstraps once and then sends only prompt deltas to the same session', async () => {
    const manager = new FastAgentOpenCodeSessionManager({ idleTtlMs: 10_000 });
    const calls: Array<{ prompt: string; sessionId?: string }> = [];
    const execute = vi.fn(async (session, prompt: string) => {
      calls.push({ prompt, sessionId: session.id });
      session.id ??= 'opencode-session-1';
      return session.id;
    });

    await manager.run({
      conversationId: 'conversation-1',
      prompt: 'turn one',
      bootstrapPrompt: 'thread context plus turn one',
      execute,
    });
    await manager.run({
      conversationId: 'conversation-1',
      prompt: 'turn two only',
      bootstrapPrompt: 'full fallback context',
      execute,
    });

    expect(calls).toEqual([
      { prompt: 'thread context plus turn one', sessionId: undefined },
      { prompt: 'turn two only', sessionId: 'opencode-session-1' },
    ]);
  });

  it('validates and resumes a persisted session with only the new turn', async () => {
    const manager = new FastAgentOpenCodeSessionManager();
    const execute = vi.fn(async (_session, prompt, context) => ({
      prompt,
      context,
    }));

    await expect(
      manager.run({
        conversationId: 'conversation-1',
        persistedSessionId: 'persisted-session',
        prompt: 'turn delta',
        bootstrapPrompt: 'flattened compatibility history',
        execute,
      }),
    ).resolves.toEqual({
      prompt: 'turn delta',
      context: { path: 'cold_resume', validateSession: true },
    });
    expect(execute.mock.calls[0]?.[0]).toEqual({ id: 'persisted-session' });
  });

  it('rebuilds from compatibility history when persisted session validation fails', async () => {
    const manager = new FastAgentOpenCodeSessionManager();
    const paths: string[] = [];
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new NonTaskOpenCodeSessionNotFoundError())
      .mockImplementationOnce(async (session, prompt, context) => {
        expect(session.id).toBeUndefined();
        return { prompt, context };
      });

    await expect(
      manager.run({
        conversationId: 'conversation-1',
        persistedSessionId: 'missing-session',
        prompt: 'turn delta',
        bootstrapPrompt: 'flattened compatibility history',
        execute,
        onPathSelected: (path) => paths.push(path),
      }),
    ).resolves.toEqual({
      prompt: 'flattened compatibility history',
      context: { path: 'fallback_rebuild', validateSession: false },
    });
    expect(paths).toEqual(['cold_resume', 'fallback_rebuild']);
  });

  it('adopts a newer durable session instead of reusing stale process-local state', async () => {
    const manager = new FastAgentOpenCodeSessionManager();
    const execute = vi.fn(async (session, prompt, context) => {
      session.id ??= 'stale-local-session';
      return { sessionId: session.id, prompt, context };
    });

    await manager.run({
      conversationId: 'conversation-1',
      prompt: 'first turn',
      bootstrapPrompt: 'first bootstrap',
      execute,
    });

    await expect(
      manager.run({
        conversationId: 'conversation-1',
        persistedSessionId: 'newer-durable-session',
        prompt: 'next turn',
        bootstrapPrompt: 'flattened compatibility history',
        execute,
      }),
    ).resolves.toEqual({
      sessionId: 'newer-durable-session',
      prompt: 'next turn',
      context: { path: 'cold_resume', validateSession: true },
    });
  });

  it('serializes concurrent prompts for one conversation', async () => {
    const manager = new FastAgentOpenCodeSessionManager();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const execute = vi.fn(async (session, prompt: string) => {
      started.push(prompt);
      session.id ??= 'opencode-session-1';
      if (prompt === 'bootstrap one') {
        await firstBlocked;
      }
      return prompt;
    });

    const first = manager.run({
      conversationId: 'conversation-1',
      prompt: 'delta one',
      bootstrapPrompt: 'bootstrap one',
      execute,
    });
    await vi.waitFor(() => expect(started).toEqual(['bootstrap one']));
    const second = manager.run({
      conversationId: 'conversation-1',
      prompt: 'delta two',
      bootstrapPrompt: 'bootstrap two',
      execute,
    });

    await Promise.resolve();
    expect(started).toEqual(['bootstrap one']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(started).toEqual(['bootstrap one', 'delta two']);
  });

  it('keeps a failed native session available for a queued turn', async () => {
    const manager = new FastAgentOpenCodeSessionManager();
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const calls: Array<{ prompt: string; sessionId?: string }> = [];
    const execute = vi.fn(async (session, prompt: string) => {
      calls.push({ prompt, sessionId: session.id });
      if (prompt === 'bootstrap one') {
        session.id = 'failed-session';
        await failureGate;
        throw new Error('provider failed');
      }
      session.id ??= 'replacement-session';
      return prompt;
    });

    const first = manager.run({
      conversationId: 'conversation-1',
      prompt: 'delta one',
      bootstrapPrompt: 'bootstrap one',
      execute,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = manager.run({
      conversationId: 'conversation-1',
      prompt: 'delta two',
      bootstrapPrompt: 'bootstrap two with visible error',
      execute,
    });
    const firstFailure = expect(first).rejects.toThrow('provider failed');

    releaseFailure();

    await firstFailure;
    await expect(second).resolves.toBe('delta two');
    expect(calls).toEqual([
      { prompt: 'bootstrap one', sessionId: undefined },
      {
        prompt: 'delta two',
        sessionId: 'failed-session',
      },
    ]);
  });

  it('recreates a missing OpenCode session from the bootstrap prompt once', async () => {
    const manager = new FastAgentOpenCodeSessionManager();
    const execute = vi
      .fn()
      .mockImplementationOnce(async (session) => {
        session.id = 'stale-session';
        return 'created';
      })
      .mockRejectedValueOnce(new NonTaskOpenCodeSessionNotFoundError())
      .mockImplementationOnce(async (session, prompt) => {
        expect(session.id).toBeUndefined();
        session.id = 'replacement-session';
        return prompt;
      });

    await manager.run({
      conversationId: 'conversation-1',
      prompt: 'first',
      bootstrapPrompt: 'bootstrap first',
      execute,
    });
    await expect(
      manager.run({
        conversationId: 'conversation-1',
        prompt: 'delta after loss',
        bootstrapPrompt: 'surface context after loss',
        execute,
      }),
    ).resolves.toBe('surface context after loss');
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('revalidates durable state after process-local invalidation', async () => {
    const manager = new FastAgentOpenCodeSessionManager();
    const prompts: Array<{ prompt: string; sessionId?: string }> = [];
    const execute = vi.fn(async (session, prompt: string) => {
      prompts.push({ prompt, sessionId: session.id });
      session.id ??= `session-${prompts.length}`;
      return prompt;
    });

    await manager.run({
      conversationId: 'conversation-1',
      prompt: 'turn one',
      bootstrapPrompt: 'bootstrap turn one',
      execute,
    });
    manager.invalidate('conversation-1');
    await manager.run({
      conversationId: 'conversation-1',
      persistedSessionId: 'session-1',
      prompt: 'turn two only',
      bootstrapPrompt: 'visible history including the failure and turn two',
      execute,
    });

    expect(prompts).toEqual([
      { prompt: 'bootstrap turn one', sessionId: undefined },
      {
        prompt: 'turn two only',
        sessionId: 'session-1',
      },
    ]);
  });

  it('forgets idle and least-recently-used sessions', async () => {
    let now = 0;
    const manager = new FastAgentOpenCodeSessionManager({
      idleTtlMs: 10,
      maxEntries: 2,
      now: () => now,
    });
    const prompts: string[] = [];
    const execute = vi.fn(async (session, prompt: string) => {
      prompts.push(prompt);
      session.id ??= `session-${prompt}`;
    });
    const run = (conversationId: string, delta: string) =>
      manager.run({
        conversationId,
        prompt: delta,
        bootstrapPrompt: `bootstrap ${delta}`,
        execute,
      });

    await run('a', 'a1');
    now = 1;
    await run('b', 'b1');
    now = 2;
    await run('c', 'c1');
    expect(manager.size).toBe(2);
    await run('a', 'a2');
    expect(prompts.at(-1)).toBe('bootstrap a2');

    now = 20;
    await run('a', 'a3');
    expect(prompts.at(-1)).toBe('bootstrap a3');
  });
});
