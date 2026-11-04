/** Finite platform defaults; these are safety bounds, not dollar budgets. */
export const AGENT_SAFETY = {
  identicalCompletions: 5,
  pollingCompletions: 20,
  passSteps: 100,
  passTools: 200,
  passTimeoutMs: 20 * 60_000,
  taskRequests: 1_000,
} as const;

export type AgentSafetyReason =
  | 'identical_tool_loop'
  | 'pass_step_limit'
  | 'pass_tool_limit'
  | 'pass_time_limit'
  | 'task_request_limit';

export interface AgentSafetyStopDetails {
  sessionId?: string;
  steps?: number;
  completedTools?: number;
  identicalCompletions?: number;
  elapsedMs?: number;
}

export const AGENT_SAFETY_STOP_CODE = 'roomote_agent_safety_stop';
export const AGENT_SAFETY_STOP_TEXT =
  'Roomote stopped this task at a safety limit. Automatic retries are disabled. Review the partial work and safety notice before starting a new task.';

export function isAgentSafetyStop(error: unknown): boolean {
  // SDK/provider envelopes may stringify nested response bodies.
  const text =
    error instanceof Error
      ? `${error.message} ${JSON.stringify(error.cause ?? '')}`
      : typeof error === 'string'
        ? error
        : JSON.stringify(error ?? '');
  return (
    text.includes(AGENT_SAFETY_STOP_CODE) ||
    text.includes(AGENT_SAFETY_STOP_TEXT)
  );
}

export function canonicalSafetyJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalSafetyJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalSafetyJson(item)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** One execution pass. Only digests and invocation IDs are retained. */
export class AgentSafetyPass {
  readonly startedAtMs: number;
  private readonly completedCalls = new Set<string>();
  private readonly steps = new Set<string>();
  private lastFingerprint?: string;
  private identical = 0;
  private stopped?: AgentSafetyReason;

  constructor(
    private readonly digest: (value: string) => string,
    now = Date.now(),
  ) {
    this.startedAtMs = now;
  }

  checkTime(now = Date.now()): AgentSafetyReason | undefined {
    if (now - this.startedAtMs >= AGENT_SAFETY.passTimeoutMs)
      this.stopped ??= 'pass_time_limit';
    return this.stopped;
  }

  snapshot(now = Date.now()): AgentSafetyStopDetails {
    return {
      steps: this.steps.size,
      completedTools: this.completedCalls.size,
      identicalCompletions: this.identical,
      elapsedMs: Math.max(0, now - this.startedAtMs),
    };
  }

  step(id: string): AgentSafetyReason | undefined {
    if (this.stopped) return this.stopped;
    this.steps.add(id);
    if (this.steps.size >= AGENT_SAFETY.passSteps)
      this.stopped ??= 'pass_step_limit';
    return this.stopped;
  }

  completed(input: {
    id: string;
    name: string;
    args: unknown;
    result: unknown;
  }): AgentSafetyReason | undefined {
    if (this.stopped || this.completedCalls.has(input.id)) return this.stopped;
    this.completedCalls.add(input.id);
    const fingerprint = this.digest(
      canonicalSafetyJson([input.name, input.args, input.result]),
    );
    this.identical =
      fingerprint === this.lastFingerprint ? this.identical + 1 : 1;
    this.lastFingerprint = fingerprint;
    // Only explicit read-only status APIs get a larger, still finite allowance.
    // bash/execute/search are never exempt, even if their text mentions polling.
    const args = input.args as { action?: unknown } | undefined;
    const polling =
      ['roomote_manage_tasks', 'manage_tasks'].some(
        (name) => input.name === name || input.name.endsWith(`_${name}`),
      ) && args?.action === 'get_updates';
    if (
      this.identical >=
      (polling
        ? AGENT_SAFETY.pollingCompletions
        : AGENT_SAFETY.identicalCompletions)
    )
      this.stopped = 'identical_tool_loop';
    if (this.completedCalls.size >= AGENT_SAFETY.passTools)
      this.stopped ??= 'pass_tool_limit';
    return this.stopped;
  }
}

/** In-memory safety state for one runtime's session tree. Transport, persistence
 * and transcript effects stay with the caller. A settled child can only resume
 * through an explicit new spawn unless the runtime opts into activity resumes. */
export class AgentSafetyLifecycle {
  private readonly passes = new Map<string, AgentSafetyPass>();
  private readonly settled = new Set<string>();
  private readonly spawns = new Map<
    string,
    {
      startedAtMs: number;
      sessionId: string;
      childSessionId?: string;
    }
  >();
  private readonly settledSpawns = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private disposed = false;
  private stopClaimed = false;

  constructor(
    private readonly options: {
      digest: (value: string) => string;
      isBounded: (sessionId: string) => boolean;
      onDeadline: (sessionId: string) => void;
      resumeOnActivity?: boolean;
      includeFailedTools?: boolean;
    },
  ) {
    this.timer = setInterval(() => {
      if (this.disposed || this.stopped) return;
      for (const spawn of this.spawns.values()) {
        if (Date.now() - spawn.startedAtMs >= AGENT_SAFETY.passTimeoutMs) {
          this.options.onDeadline(spawn.childSessionId ?? spawn.sessionId);
          return;
        }
      }
      for (const [id, pass] of this.passes) {
        if (this.options.isBounded(id) && pass.checkTime()) {
          this.options.onDeadline(id);
          return;
        }
      }
    }, 1_000);
    this.timer.unref?.();
  }

  get stopped(): boolean {
    return this.stopClaimed;
  }

  start(sessionId: string, resume = false): AgentSafetyPass | undefined {
    if (this.disposed || this.stopped) return;
    if (resume) this.settled.delete(sessionId);
    if (this.settled.has(sessionId)) return;
    let pass = this.passes.get(sessionId);
    if (!pass) {
      pass = new AgentSafetyPass(this.options.digest);
      this.passes.set(sessionId, pass);
    }
    return pass;
  }

  settle(sessionId: string): void {
    if (this.disposed) return;
    this.passes.delete(sessionId);
    this.settled.add(sessionId);
  }

  /** Root turns may restart on activity without an explicit child spawn. */
  finishRoot(sessionId: string): void {
    this.passes.delete(sessionId);
  }

  startSpawn(
    key: string,
    sessionId: string,
    childSessionId: string | null,
  ): boolean {
    if (this.disposed || this.stopped || this.settledSpawns.has(key))
      return false;
    const existing = this.spawns.get(key);
    this.spawns.set(key, {
      startedAtMs: existing?.startedAtMs ?? Date.now(),
      sessionId,
      childSessionId: childSessionId ?? existing?.childSessionId,
    });
    if (childSessionId) this.start(childSessionId, true);
    return true;
  }

  settleSpawn(key: string): void {
    if (this.disposed) return;
    this.settledSpawns.add(key);
    const spawn = this.spawns.get(key);
    if (spawn?.childSessionId) this.settle(spawn.childSessionId);
    this.spawns.delete(key);
  }

  /** The caller has already established membership in its session tree. */
  observe(
    sessionId: string,
    event: { type: string; properties?: unknown },
  ): AgentSafetyReason | undefined {
    if (this.disposed || this.stopped) return;
    const properties = safetyRecord(event.properties);
    const status = safetyRecord(properties?.status);
    const activity =
      event.type === 'message.part.updated' ||
      event.type === 'message.updated' ||
      (event.type === 'session.status' &&
        ['busy', 'retry'].includes(String(status?.type)));
    const pass =
      this.passes.get(sessionId) ??
      (activity
        ? this.start(sessionId, this.options.resumeOnActivity)
        : undefined);
    const part = safetyRecord(properties?.part);
    if (event.type === 'message.part.updated' && part?.type === 'tool') {
      const state = safetyRecord(part.state);
      const terminal =
        state?.status === 'completed' ||
        state?.status === 'error' ||
        (this.options.includeFailedTools && state?.status === 'failed');
      if (terminal && typeof part.callID === 'string' && part.callID) {
        return pass?.completed({
          id: part.callID,
          name: typeof part.tool === 'string' ? part.tool : '',
          args: state?.input,
          result: {
            status: state?.status,
            output: state?.output,
            error: state?.error,
          },
        });
      }
    }
    const info = safetyRecord(properties?.info);
    if (
      event.type === 'message.updated' &&
      info?.role === 'assistant' &&
      typeof info.id === 'string' &&
      info.id &&
      this.options.isBounded(sessionId)
    ) {
      return pass?.step(info.id);
    }
  }

  /** Claim before any async effects so concurrent limits cannot stop twice. */
  claimStop(sessionId: string): AgentSafetyStopDetails | undefined {
    if (this.disposed || this.stopped) return;
    this.stopClaimed = true;
    clearInterval(this.timer);
    return { sessionId, ...this.passes.get(sessionId)?.snapshot() };
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.passes.clear();
    this.settled.clear();
    this.spawns.clear();
    this.settledSpawns.clear();
  }
}

function safetyRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
