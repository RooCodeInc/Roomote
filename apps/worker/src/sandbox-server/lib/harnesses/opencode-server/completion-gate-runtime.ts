import {
  TASK_COMPLETION_GATE_ENV_VAR,
  TASK_COMPLETION_GATE_LIMITS,
  TaskPayloadKind,
  taskCompletionCheckResponseSchema,
  type TaskCompletionCheckRequest,
  type TaskCompletionCheckEvidence,
  type TaskCompletionCheckResponse,
  type TaskCompletionGateTrigger,
} from '@roomote/types';

import {
  buildApiHeaders,
  fetchWithTimeout,
} from '../../../../mcp/roomote-mcp-server/api-client';

import {
  collectShippedDiff,
  UNCHANGED_WORKSPACE_FINGERPRINT,
} from './completion-gate-evidence';

/**
 * The turn is held open while the API answers. The ceiling sits above the
 * server's own decision-model timeout so the server's `skipped` wins the race.
 */
const COMPLETION_CHECK_TIMEOUT_MS = 8_000;

const REPORT_TOOL_NAMES = new Set([
  'report_to_parent_session',
  'send_chat_reply',
  'send_chat_message',
]);
// The source-control tool's shipping actions; getting, commenting on, closing,
// or reopening a pull request are not.
const SHIP_MCP_ACTIONS = new Set([
  'create_or_update_pull_request',
  'update_pull_request',
]);
const SHIP_SHELL_COMMAND =
  /\bgit\b[^|;&\n]*\bpush\b|\bgh\s+pr\s+(create|ready|edit)\b|\bglab\s+mr\s+create\b/;

/**
 * The platform turns the check on per run. PR reviews are themselves the
 * review pass, and automations report through their own result contract
 * rather than a person's request.
 */
export function isCompletionGateEligible(
  env: Record<string, string> | undefined,
): boolean {
  const taskType = env?.ROOMOTE_TASK_TYPE?.trim();

  return Boolean(
    env?.[TASK_COMPLETION_GATE_ENV_VAR] === 'true' &&
    env.ROOMOTE_CLOUD_TOKEN &&
    env.ROOMOTE_PLATFORM_API_URL &&
    env.ROOMOTE_TASK_RUN_ID &&
    env.ROOMOTE_AUTOMATION_TASK !== 'true' &&
    taskType !== TaskPayloadKind.GithubPrReview &&
    taskType !== TaskPayloadKind.GithubPrReviewSync,
  );
}

type CompletionCheckToolTrigger = Exclude<
  TaskCompletionGateTrigger,
  'turn_end'
>;

interface CompletionCheckToolClassification {
  trigger: CompletionCheckToolTrigger;
  report?: string;
}

/**
 * Whether a tool call is a moment to check the work: the agent reporting to
 * a person, or shipping. For a report the tool's own text is the report to
 * hold against the diff. MCP tools arrive flattened (`roomote_send_chat_reply`),
 * so names are matched by suffix.
 */
export function classifyCompletionCheckTool(
  tool: string,
  args: unknown,
): CompletionCheckToolClassification | null {
  const name = tool.trim().toLowerCase();
  const record =
    args && typeof args === 'object' ? (args as Record<string, unknown>) : {};

  for (const reportTool of REPORT_TOOL_NAMES) {
    if (name === reportTool || name.endsWith(`_${reportTool}`)) {
      const report = [record.text, record.message, record.summary, record.body]
        .find((value) => typeof value === 'string' && value.trim())
        ?.toString();

      return { trigger: 'report', ...(report ? { report } : {}) };
    }
  }

  if (name === 'bash' || name === 'shell') {
    const command = typeof record.command === 'string' ? record.command : '';

    return SHIP_SHELL_COMMAND.test(command) ? { trigger: 'ship' } : null;
  }

  if (
    name.endsWith('manage_source_control') &&
    typeof record.action === 'string' &&
    SHIP_MCP_ACTIONS.has(record.action)
  ) {
    return { trigger: 'ship' };
  }

  return null;
}

/** Never throws: a check that cannot be made is a check that was skipped. */
export async function requestTaskCompletionCheck(
  env: Record<string, string>,
  check: TaskCompletionCheckRequest,
): Promise<TaskCompletionCheckResponse> {
  const skipped: TaskCompletionCheckResponse = { status: 'skipped', flags: [] };

  try {
    const response = await fetchWithTimeout(
      `${env.ROOMOTE_PLATFORM_API_URL!.replace(/\/+$/, '')}/api/mcp/tasks/runs/${env.ROOMOTE_TASK_RUN_ID}/completion_check`,
      {
        method: 'POST',
        headers: buildApiHeaders(
          {
            token: env.ROOMOTE_CLOUD_TOKEN!,
            authBypassHeaderName: env.ROOMOTE_AUTH_BYPASS_HEADER_NAME,
            authBypassHeaderValue: env.ROOMOTE_AUTH_BYPASS_VALUE,
          },
          { 'Content-Type': 'application/json' },
        ),
        body: JSON.stringify(check),
      },
      {
        label: 'Task completion check',
        timeoutMs: COMPLETION_CHECK_TIMEOUT_MS,
      },
    );

    if (!response.ok) {
      return skipped;
    }

    const parsed = taskCompletionCheckResponseSchema.safeParse(
      await response.json(),
    );

    return parsed.success ? parsed.data : skipped;
  } catch {
    return skipped;
  }
}

interface CompletionGateCommandResult {
  sessionId: string;
  command: string;
  exitCode: number | null;
  output: string;
  status: 'completed' | 'failed';
}

interface CompletionGateRuntimeOptions {
  workspacePath: string;
  getCommandEnv: () => Record<string, string> | undefined;
  requestTaskCompletionCheck?: typeof requestTaskCompletionCheck;
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  hasUnsettledToolWork?: (sessionId: string) => Promise<boolean>;
}

/**
 * Worker-owned completion evidence and trigger runtime. The harness supplies
 * turn lifecycle decisions, while this object serializes evidence snapshots,
 * evaluates a diff once, and enforces the one-denial retry rule.
 */
/**
 * Whether a shell command looks like validation: a test, type check, lint,
 * build, or format check. These are the commands the check has to see.
 */
function isValidationCommand(command: string): boolean {
  return /\b(vitest|jest|mocha|pytest|cargo\s+test|go\s+test|tsc|tsgo|check-types|typecheck|eslint|oxlint|lint|knip|build|format:check|prettier\s+--check|oxfmt\s+--check)\b|\b(pnpm|npm|yarn|bun)\s+(run\s+)?test\b/i.test(
    command,
  );
}

export class CompletionGateRuntime {
  private readonly workspacePath: string;
  private readonly getCommandEnv: CompletionGateRuntimeOptions['getCommandEnv'];
  private readonly requestTaskCompletionCheck: typeof requestTaskCompletionCheck;
  private readonly logger: CompletionGateRuntimeOptions['logger'];
  private readonly hasUnsettledToolWork:
    | CompletionGateRuntimeOptions['hasUnsettledToolWork']
    | undefined;
  private requestGeneration = 0;
  private lastCheckedKey: string | null = null;
  private commands: Array<{
    command: string;
    exitCode: number | null;
    output: string;
    fingerprintAfter: Promise<string | null>;
  }> = [];
  private snapshots: Promise<unknown> = Promise.resolve();
  private readonly deniedKeys = new Set<string>();
  private inFlight: Promise<{
    verdict: TaskCompletionCheckResponse;
    checkedKey: string;
  } | null> | null = null;

  constructor(options: CompletionGateRuntimeOptions) {
    this.workspacePath = options.workspacePath;
    this.getCommandEnv = options.getCommandEnv;
    this.requestTaskCompletionCheck =
      options.requestTaskCompletionCheck ?? requestTaskCompletionCheck;
    this.logger = options.logger;
    this.hasUnsettledToolWork = options.hasUnsettledToolWork;
  }

  get currentRequestGeneration(): number {
    return this.requestGeneration;
  }

  isEligible(): boolean {
    return isCompletionGateEligible(this.getCommandEnv());
  }

  reset(): void {
    this.requestGeneration += 1;
    this.lastCheckedKey = null;
    this.commands = [];
    this.snapshots = Promise.resolve();
    this.deniedKeys.clear();
  }

  invalidate(): void {
    this.requestGeneration += 1;
  }

  noteVisibleRequest(): void {
    this.requestGeneration += 1;
  }

  /**
   * Keeps the parent agent's shell commands for the check, each with a
   * snapshot of what the workspace held once it finished.
   */
  recordCommand(input: CompletionGateCommandResult): void {
    if (!this.isEligible() || !input.command || input.sessionId.length === 0) {
      return;
    }

    // Taken off the event path: the model needs seconds to issue its next
    // tool call, git needs a fraction of one. A failed snapshot is `null`,
    // which never matches, so the run is left out rather than trusted.
    const fingerprintAfter = this.snapshots.then(() =>
      collectShippedDiff(this.workspacePath).then(
        (shipped) => shipped?.fingerprint ?? UNCHANGED_WORKSPACE_FINGERPRINT,
        () => null,
      ),
    );
    this.snapshots = fingerprintAfter;

    this.commands.push({
      command: input.command.slice(
        0,
        TASK_COMPLETION_GATE_LIMITS.commandMaxChars,
      ),
      exitCode:
        Number.isInteger(input.exitCode) && input.exitCode !== null
          ? input.exitCode
          : input.status === 'failed'
            ? 1
            : null,
      output: input.output.slice(
        -TASK_COMPLETION_GATE_LIMITS.commandOutputTailMaxChars,
      ),
      fingerprintAfter,
    });

    if (this.commands.length > TASK_COMPLETION_GATE_LIMITS.commandsMax) {
      // Delivery runs a dozen git and inspection commands after the last
      // test. Evicting oldest-first pushed the test out of the window, and
      // the check then read "tests pass" as unsupported. Drop those first.
      const evict = this.commands.findIndex(
        (entry) => !isValidationCommand(entry.command),
      );
      this.commands.splice(evict === -1 ? 0 : evict, 1);
    }
  }

  /**
   * One evaluation against the current diff, shared by turn-end and tool-time
   * triggers. Returns null when there is nothing new to check.
   */
  async evaluate(input: {
    sessionId: string;
    report: string;
    trigger: TaskCompletionGateTrigger;
    skipWhenToolWorkUnsettled?: boolean;
  }): Promise<{
    verdict: TaskCompletionCheckResponse;
    checkedKey: string;
  } | null> {
    if (this.inFlight) {
      return this.inFlight;
    }

    const run = async () => {
      const generation = this.requestGeneration;
      const shipped = await collectShippedDiff(this.workspacePath);
      const checkedKey = `${generation}:${shipped?.key}`;

      if (!shipped || checkedKey === this.lastCheckedKey) {
        return null;
      }

      if (
        input.skipWhenToolWorkUnsettled &&
        this.hasUnsettledToolWork &&
        (await this.hasUnsettledToolWork(input.sessionId))
      ) {
        return null;
      }

      const env = this.getCommandEnv();

      if (!env || !isCompletionGateEligible(env)) {
        return null;
      }

      this.lastCheckedKey = checkedKey;
      // A run vouches for the code only if the code is still what it was when
      // the run finished. Reformatting alone does not change the fingerprint.
      const commands = await Promise.all(
        this.commands.map(async ({ fingerprintAfter, ...command }) => ({
          command: command.command,
          exitCode: command.exitCode,
          outputTail: command.output,
          ranBeforeLaterEdit: (await fingerprintAfter) !== shipped.fingerprint,
        })),
      );
      const startedAt = Date.now();
      const evidence: TaskCompletionCheckEvidence = {
        report: input.report.slice(-TASK_COMPLETION_GATE_LIMITS.reportMaxChars),
        diff: shipped.diff,
        diffStat: shipped.diffStat,
        diffTruncated: shipped.diffTruncated,
        commands,
      };
      const verdict = await this.requestTaskCompletionCheck(env, {
        ...evidence,
        trigger: input.trigger,
      });

      this.logger.info(
        `OpenCode completion check status=${verdict.status} flags=${
          verdict.flags.map((flag) => flag.id).join(',') || 'none'
        } diffChars=${shipped.diff.length} truncated=${shipped.diffTruncated} elapsedMs=${
          Date.now() - startedAt
        } sessionId=${input.sessionId}`,
      );

      return { verdict, checkedKey };
    };

    this.inFlight = run().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  /**
   * Checks a report or shipping call. A flagged verdict denies one call for a
   * piece of work; the next call goes through so the agent cannot get stuck.
   */
  async checkBeforeTool(input: {
    sessionId: string | undefined;
    fallbackReport: string;
    tool: string;
    args?: unknown;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const classified = classifyCompletionCheckTool(input.tool, input.args);

    if (!classified || !input.sessionId || !this.isEligible()) {
      return { allowed: true };
    }

    try {
      const evaluated = await this.evaluate({
        sessionId: input.sessionId,
        report: classified.report ?? input.fallbackReport,
        trigger: classified.trigger,
      });

      if (
        !evaluated ||
        evaluated.verdict.status !== 'flagged' ||
        !evaluated.verdict.message ||
        this.deniedKeys.has(evaluated.checkedKey)
      ) {
        return { allowed: true };
      }

      this.deniedKeys.add(evaluated.checkedKey);
      this.logger.info(
        `OpenCode completion check held a ${classified.trigger} tool call tool=${input.tool} flags=${evaluated.verdict.flags
          .map((flag) => flag.id)
          .join(',')} sessionId=${input.sessionId}`,
      );

      return { allowed: false, reason: evaluated.verdict.message };
    } catch (error) {
      this.logger.warn(
        `OpenCode completion check before a tool call failed; allowing the call. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { allowed: true };
    }
  }
}
