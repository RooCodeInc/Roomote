import { createHash } from 'node:crypto';
import { AGENT_SAFETY, AgentSafetyLifecycle } from '../agent-safety';

const toolEvent = (id: number, status = 'completed') => ({
  type: 'message.part.updated',
  properties: {
    part: {
      type: 'tool',
      callID: String(id),
      tool: 'grep',
      state: { status, input: { pattern: 'missing' }, output: '' },
    },
  },
});
const stepEvent = (id: number) => ({
  type: 'message.updated',
  properties: { info: { role: 'assistant', id: String(id) } },
});

describe('agent safety lifecycle', () => {
  const owners: AgentSafetyLifecycle[] = [];
  function create(
    options: Partial<
      ConstructorParameters<typeof AgentSafetyLifecycle>[0]
    > = {},
  ) {
    const onDeadline = vi.fn();
    const owner = new AgentSafetyLifecycle({
      digest: (text) => createHash('sha256').update(text).digest('hex'),
      isBounded: (id) => id !== 'root',
      onDeadline,
      ...options,
    });
    owners.push(owner);
    return { owner, onDeadline };
  }
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const owner of owners.splice(0)) owner.dispose();
    vi.useRealTimers();
  });

  it('deduplicates completions per session and claims a tree stop only once', () => {
    const { owner } = create();
    for (let id = 0; id < 4; id++) {
      for (let duplicate = 0; duplicate < 10; duplicate++) {
        expect(owner.observe('child', toolEvent(id))).toBeUndefined();
        expect(owner.observe('sibling', toolEvent(id))).toBeUndefined();
      }
    }
    expect(owner.observe('child', toolEvent(4))).toBe('identical_tool_loop');
    expect(owner.claimStop('child')).toMatchObject({
      sessionId: 'child',
      completedTools: 5,
    });
    expect(owner.claimStop('sibling')).toBeUndefined();
    expect(owner.startSpawn('new', 'root', 'new-child')).toBe(false);
    expect(owner.observe('sibling', toolEvent(4))).toBeUndefined();
    expect(owner.stopped).toBe(true);
  });

  it('keeps the worker root exempt from step and wall limits but counts its tools', async () => {
    const { owner, onDeadline } = create();
    for (let id = 0; id < AGENT_SAFETY.passSteps + 1; id++)
      expect(owner.observe('root', stepEvent(id))).toBeUndefined();
    await vi.advanceTimersByTimeAsync(AGENT_SAFETY.passTimeoutMs);
    expect(onDeadline).not.toHaveBeenCalled();
    for (let id = 0; id < 5; id++)
      expect(owner.observe('root', toolEvent(id))).toBe(
        id === 4 ? 'identical_tool_loop' : undefined,
      );
  });

  it('does not reset an older pending spawn deadline when child metadata or siblings arrive', async () => {
    const { owner, onDeadline } = create();
    owner.startSpawn('spawn', 'root', null);
    await vi.advanceTimersByTimeAsync(AGENT_SAFETY.passTimeoutMs / 2);
    owner.startSpawn('spawn', 'root', 'child');
    owner.startSpawn('sibling-spawn', 'root', 'sibling');
    owner.observe('child', toolEvent(0));
    await vi.advanceTimersByTimeAsync(AGENT_SAFETY.passTimeoutMs / 2);
    expect(onDeadline).toHaveBeenCalledExactlyOnceWith('child');
  });

  it('bounds pending spawns even before a child session exists', async () => {
    const { owner, onDeadline } = create();
    owner.startSpawn('pending', 'root', null);
    await vi.advanceTimersByTimeAsync(AGENT_SAFETY.passTimeoutMs);
    expect(onDeadline).toHaveBeenCalledExactlyOnceWith('root');
  });

  it('keeps a session-only deadline when a sibling or more message updates arrive', async () => {
    const { owner, onDeadline } = create({ isBounded: () => true });
    owner.start('root');
    await vi.advanceTimersByTimeAsync(AGENT_SAFETY.passTimeoutMs / 2);
    owner.start('child');
    owner.observe('root', stepEvent(0));
    owner.observe('child', toolEvent(0));
    await vi.advanceTimersByTimeAsync(AGENT_SAFETY.passTimeoutMs / 2);
    expect(onDeadline).toHaveBeenCalledExactlyOnceWith('root');
  });

  it('ignores settled child events and duplicate spawns but permits an explicit resumed pass', async () => {
    const { owner, onDeadline } = create();
    owner.startSpawn('first', 'root', 'child');
    for (let id = 0; id < 4; id++) owner.observe('child', toolEvent(id));
    owner.settleSpawn('first');
    expect(owner.startSpawn('first', 'root', 'child')).toBe(false);
    owner.start('child'); // late session.created
    for (let id = 4; id < 20; id++)
      expect(owner.observe('child', toolEvent(id))).toBeUndefined();
    await vi.advanceTimersByTimeAsync(AGENT_SAFETY.passTimeoutMs);
    expect(onDeadline).not.toHaveBeenCalled();
    expect(owner.startSpawn('resumed', 'root', 'child')).toBe(true);
    for (let id = 0; id < 5; id++)
      expect(owner.observe('child', toolEvent(id))).toBe(
        id === 4 ? 'identical_tool_loop' : undefined,
      );
  });

  it('allows native activity to resume a settled pass and bounds the native root', () => {
    const { owner } = create({ isBounded: () => true, resumeOnActivity: true });
    for (let id = 0; id < 4; id++) owner.observe('child', toolEvent(id));
    owner.settle('child');
    for (let id = 0; id < 5; id++)
      expect(owner.observe('child', toolEvent(id))).toBe(
        id === 4 ? 'identical_tool_loop' : undefined,
      );
    for (let id = 0; id < AGENT_SAFETY.passSteps; id++) {
      const reason =
        id === AGENT_SAFETY.passSteps - 1 ? 'pass_step_limit' : undefined;
      expect(owner.observe('root', stepEvent(id))).toBe(reason);
      expect(owner.observe('root', stepEvent(id))).toBe(reason);
    }
  });

  it('cleans up deadlines on root completion, child settlement, stop and disposal', async () => {
    const { owner, onDeadline } = create({ isBounded: () => true });
    owner.start('root');
    owner.startSpawn('child-spawn', 'root', 'child');
    owner.settleSpawn('child-spawn');
    owner.finishRoot('root');
    await vi.advanceTimersByTimeAsync(AGENT_SAFETY.passTimeoutMs);
    expect(onDeadline).not.toHaveBeenCalled();
    owner.start('root');
    owner.claimStop('root');
    await vi.advanceTimersByTimeAsync(AGENT_SAFETY.passTimeoutMs);
    expect(onDeadline).not.toHaveBeenCalled();
    const disposed = create();
    disposed.owner.start('child');
    disposed.owner.dispose();
    expect(disposed.owner.observe('child', toolEvent(0))).toBeUndefined();
    await vi.advanceTimersByTimeAsync(AGENT_SAFETY.passTimeoutMs);
    expect(disposed.onDeadline).not.toHaveBeenCalled();
  });
});
