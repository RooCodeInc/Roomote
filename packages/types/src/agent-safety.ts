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
