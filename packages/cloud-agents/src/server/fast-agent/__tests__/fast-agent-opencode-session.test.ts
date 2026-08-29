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

  it('rebuilds a warm session when its MCP tool catalog changes', async () => {
    const manager = new FastAgentOpenCodeSessionManager();
    const calls: Array<{
      prompt: string;
      sessionId?: string;
      path: string;
    }> = [];
    const execute = vi.fn(async (session, prompt: string, context) => {
      calls.push({ prompt, sessionId: session.id, path: context.path });
      session.id ??= `opencode-session-${calls.length}`;
      return session.id;
    });
    const run = (toolCatalogKey: string, prompt: string) =>
      manager.run({
        conversationId: 'conversation-1',
        prompt,
        bootstrapPrompt: `bootstrap ${prompt}`,
        toolCatalogKey,
        execute,
      });

    await run('notion:search', 'turn one');
    await run('notion:search', 'turn two');
    await run('linear:get_issue,save_issue|notion:search', 'turn three');

    expect(calls).toEqual([
      {
        prompt: 'bootstrap turn one',
        sessionId: undefined,
        path: 'cold_rebuild',
      },
      {
        prompt: 'turn two',
        sessionId: 'opencode-session-1',
        path: 'warm',
      },
      {
        prompt: 'bootstrap turn three',
        sessionId: undefined,
        path: 'cold_rebuild',
      },
    ]);
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

  it('invalidates a failed session before a queued turn resumes', async () => {
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
    await expect(second).resolves.toBe('bootstrap two with visible error');
    expect(calls).toEqual([
      { prompt: 'bootstrap one', sessionId: undefined },
      {
        prompt: 'bootstrap two with visible error',
        sessionId: undefined,
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

  it('rebuilds an invalidated conversation from compatibility history', async () => {
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
      prompt: 'turn two only',
      bootstrapPrompt: 'visible history including the failure and turn two',
      execute,
    });

    expect(prompts).toEqual([
      { prompt: 'bootstrap turn one', sessionId: undefined },
      {
        prompt: 'visible history including the failure and turn two',
        sessionId: undefined,
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

  it('keeps sessions across the OpenCode server idle timeout by default', async () => {
    let now = 0;
    const manager = new FastAgentOpenCodeSessionManager({ now: () => now });
    const prompts: string[] = [];
    const execute = vi.fn(async (session, prompt: string) => {
      prompts.push(prompt);
      session.id ??= 'session-1';
    });
    const run = () =>
      manager.run({
        conversationId: 'conversation-1',
        prompt: 'delta',
        bootstrapPrompt: 'bootstrap',
        execute,
      });

    await run();
    now = 10 * 60_000;
    await run();

    expect(prompts).toEqual(['bootstrap', 'delta']);
  });

  it('cleans conversation spills on invalidation, eviction, and clear', async () => {
    let now = 0;
    const onConversationEnd = vi.fn();
    const manager = new FastAgentOpenCodeSessionManager({
      idleTtlMs: 10,
      maxEntries: 1,
      now: () => now,
      onConversationEnd,
    });
    const execute = vi.fn(async (session) => {
      session.id ??= 'session';
    });
    const run = (conversationId: string) =>
      manager.run({
        conversationId,
        prompt: 'delta',
        bootstrapPrompt: 'bootstrap',
        execute,
      });

    await run('invalidated');
    manager.invalidate('invalidated');
    expect(onConversationEnd).toHaveBeenCalledWith('invalidated');

    await run('evicted-a');
    await run('evicted-b');
    expect(onConversationEnd).toHaveBeenCalledWith('evicted-a');

    now = 20;
    await run('after-idle');
    expect(onConversationEnd).toHaveBeenCalledWith('evicted-b');

    manager.clear();
    expect(onConversationEnd).toHaveBeenCalledWith('after-idle');
  });

  it('validates and resumes a durable session on matching storage', async () => {
    const manager = new FastAgentOpenCodeSessionManager();
    const execute = vi.fn(async (session, prompt, context) => ({
      sessionId: session.id,
      prompt,
      context,
    }));

    await expect(
      manager.run({
        conversationId: 'durable',
        persistedSessionId: 'persisted-session',
        prompt: 'delta',
        bootstrapPrompt: 'compatibility history',
        execute,
      }),
    ).resolves.toEqual({
      sessionId: 'persisted-session',
      prompt: 'delta',
      context: { path: 'cold_resume', validateSession: true },
    });
  });

  it('falls back before prompting when durable validation fails', async () => {
    const manager = new FastAgentOpenCodeSessionManager();
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new NonTaskOpenCodeSessionNotFoundError())
      .mockImplementationOnce(async (session, prompt, context) => ({
        sessionId: session.id,
        prompt,
        context,
      }));

    await expect(
      manager.run({
        conversationId: 'missing',
        persistedSessionId: 'missing-session',
        prompt: 'delta',
        bootstrapPrompt: 'compatibility history',
        execute,
      }),
    ).resolves.toEqual({
      sessionId: undefined,
      prompt: 'compatibility history',
      context: { path: 'fallback_rebuild', validateSession: false },
    });
  });
});
