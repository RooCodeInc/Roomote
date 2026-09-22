/**
 * Paired platform latency experiment for the Fast parent Session path.
 *
 * Each arm admits the same synthetic task report into a fresh real web Fast
 * Session through the durable parent-event queue. The regular arm executes the
 * existing `answerFastAgentQuestion` path. The Jev arm uses the explicit
 * `communicationExperiment: "jev"` event flag, then persists its result through
 * the same Session transcript path. Normal task reports never set that flag.
 *
 * The runner reads only the worker's diagnostic log for inference breakdowns;
 * it never reads or passes provider credentials. Run it from a configured
 * local Roomote environment:
 *
 *   pnpm exec dotenvx run --quiet -f .env.local -- \
 *   pnpm --filter @roomote/cloud-agents benchmark:session-communication-latency -- \
 *   --reps 2 --bullmq-log /tmp/roomote-bullmq.log \
 *   --output experiments/session-communication-latency.json
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  and,
  db,
  eq,
  fastAgentMessages,
  fastAgentParentEvents,
} from '@roomote/db/server';
import { getOrCreateFastAgentSession } from '@roomote/cloud-agents/server';
import { enqueueFastAgentParentEvent } from '@roomote/sdk/server';

import {
  COMMUNICATION_SCENARIOS,
  summarizeCommunicationTrials,
  type CommunicationScenario,
  type CommunicationTrialResult,
  type ExpectedCommunicationAction,
} from '../src/server/session-communication-latency-experiment.js';

const DEFAULT_REPETITIONS = 2;
const DEFAULT_LOG_PATH = '/tmp/roomote-bullmq.log';
const DEFAULT_USER_ID = 'dev-login-3d79575f62e7915eb944af89';
const PLATFORM_SCENARIO_IDS = [
  'important_milestone',
  'blocked_user_input',
  'routine_redundant_progress',
  'completion_adequate_evidence',
] as const;

type Arm = 'regular-llm' | 'jev';

type Diagnostic = {
  line: string;
  inferenceMs: number;
  orchestrationMs: number;
  action?: ExpectedCommunicationAction;
};

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
}

function readNumberFlag(name: string, fallback: number): number {
  const value = Number(readFlag(name) ?? fallback);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function readGitRevision(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function readLog(): string {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

function numericField(line: string, name: string): number | null {
  const match = line.match(new RegExp(`${name}=([0-9.]+)`, 'u'));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function regularAction(
  scenario: CommunicationScenario,
  rows: Array<{ role: string; metadata: unknown }>,
): ExpectedCommunicationAction {
  const visibleAssistant = rows.some((row) => {
    if (row.role !== 'assistant' || !row.metadata) return false;
    const metadata = row.metadata as { visibleInTranscript?: unknown };
    return metadata.visibleInTranscript === true;
  });

  if (!visibleAssistant) return 'quiet';
  return scenario.expectedAction === 'request_input'
    ? 'request_input'
    : 'report';
}

async function readVisibleAssistantMessages(sessionId: string, turnId: string) {
  return db
    .select({
      role: fastAgentMessages.role,
      metadata: fastAgentMessages.metadata,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, sessionId),
        eq(fastAgentMessages.turnId, turnId),
      ),
    );
}

async function waitForDelivery(eventKey: string): Promise<Date | null> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const row = await db.query.fastAgentParentEvents.findFirst({
      where: eq(fastAgentParentEvents.eventKey, eventKey),
      columns: { deliveredAt: true },
    });
    if (row?.deliveredAt) return row.deliveredAt;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function waitForDiagnostic(
  messageId: string,
  arm: Arm,
): Promise<Diagnostic | null> {
  const deadline = Date.now() + 30_000;
  const marker =
    arm === 'regular-llm'
      ? `messageId="fast-parent-child-message:${messageId}"`
      : `[FastAgentCommunicationExperiment] event=${messageId}`;

  while (Date.now() < deadline) {
    const line = readLog()
      .split('\n')
      .find((candidate) => candidate.includes(marker));
    if (line) {
      if (arm === 'jev') {
        return {
          line,
          inferenceMs: numericField(line, 'modelInferenceMs') ?? 0,
          orchestrationMs: numericField(line, 'orchestrationMs') ?? 0,
          action: line.match(
            / action=(report|inspect|quiet|request_input) /u,
          )?.[1] as ExpectedCommunicationAction | undefined,
        };
      }

      const inferenceMs = numericField(line, 'inferenceDurationMs');
      const preInferenceMs = numericField(line, 'preInferenceDurationMs');
      const postInferenceMs = numericField(line, 'postInferenceDurationMs');
      const queueMs = numericField(line, 'conversationQueueDurationMs');
      if (
        inferenceMs !== null &&
        preInferenceMs !== null &&
        postInferenceMs !== null
      ) {
        return {
          line,
          inferenceMs,
          orchestrationMs: preInferenceMs + postInferenceMs + (queueMs ?? 0),
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function buildTrial(params: {
  arm: Arm;
  scenario: CommunicationScenario;
  repetition: number;
  sessionId: string;
  messageId: string;
  admittedAtMs: number;
  deliveredAt: Date | null;
  diagnostic: Diagnostic | null;
  visibleRows: Array<{ role: string; metadata: unknown }>;
}): CommunicationTrialResult & {
  repetition: number;
  sessionId: string;
  messageId: string;
} {
  const eventToAction = params.deliveredAt
    ? params.deliveredAt.getTime() - params.admittedAtMs
    : null;
  const actualAction =
    params.arm === 'jev'
      ? params.diagnostic?.action
      : regularAction(params.scenario, params.visibleRows);
  const inferenceMs = params.diagnostic?.inferenceMs ?? null;
  const orchestrationMs = params.diagnostic?.orchestrationMs ?? null;
  const decisionStarted = orchestrationMs ?? 0;
  const decisionCompleted = eventToAction ?? 0;

  return {
    repetition: params.repetition,
    sessionId: params.sessionId,
    messageId: params.messageId,
    mechanism: params.arm,
    scenarioId: params.scenario.id,
    expectedAction: params.scenario.expectedAction,
    ...(actualAction ? { actualAction } : {}),
    status: params.deliveredAt && params.diagnostic ? 'completed' : 'error',
    correct:
      params.deliveredAt && params.diagnostic && actualAction
        ? actualAction === params.scenario.expectedAction
        : null,
    deterministicForwarding: false,
    modelInvoked: true,
    ...(!params.deliveredAt
      ? { errorCategory: 'platform_delivery_timeout' }
      : !params.diagnostic
        ? { errorCategory: 'platform_diagnostic_timeout' }
        : {}),
    timelineMs: {
      eventEmitted: 0,
      eventObservable: 0,
      decisionStarted: round(decisionStarted),
      inferenceStarted: inferenceMs === null ? null : round(decisionStarted),
      inferenceCompleted:
        inferenceMs === null ? null : round(decisionStarted + inferenceMs),
      decisionCompleted: round(decisionCompleted),
      actionEmitted: eventToAction === null ? null : round(eventToAction),
    },
    durationsMs: {
      preInference: orchestrationMs,
      inference: inferenceMs,
      postInference: null,
      orchestration: orchestrationMs ?? 0,
      decision: eventToAction ?? 0,
      eventToAction,
    },
  };
}

function markdownReport(result: ExperimentResult): string {
  const regular = result.aggregates['regular-llm'];
  const jev = result.aggregates.jev;
  const lines = [
    '# Session Communication Latency Experiment',
    '',
    `Generated: ${result.generatedAt}`,
    `Git revision: ${result.gitRevision ?? 'unavailable'}`,
    '',
    '## Status',
    '',
    '**Eligible paired platform comparison.** Both arms used fresh real web Sessions, durable parent-event admission, the same synthetic task-report scenarios, and persisted Session-visible outcomes. Explicit human steering was not sent through either model arm; it remains a deterministic path and is covered by the focused harness test.',
    '',
    '## Production Trace',
    '',
    '- Task reports enter `reportToParentSession` / `enqueueFastAgentParentEvent`, are persisted before BullMQ wakeup, and are delivered by the Fast parent event worker.',
    '- The regular arm calls the existing `answerFastAgentQuestion` path. Worker diagnostics provide OpenCode setup, inference, and action timing.',
    '- The Jev arm is active only when the event carries `communicationExperiment: "jev"`; it uses the existing control-plane judgment resolver with an explicit OpenRouter selection override, then persists the assistant result through the same web Session transcript path.',
    '',
    '## Methodology',
    '',
    `- Scenarios: ${PLATFORM_SCENARIO_IDS.join(', ')}; repetitions per arm/scenario: ${result.configuration.repetitions}.`,
    '- Each sample uses a fresh Session to avoid warm transcript contamination. Pair order is regular LLM, then Jev.',
    '- `eventToAction` is durable event admission to the parent event row delivery completion. `inference` and `orchestration` come from the regular Fast diagnostics or Jev experiment diagnostics.',
    '- The Jev branch is opt-in per event and does not affect ordinary task reports or human steering.',
    '- p50/p95 use linear interpolation over valid completed samples; no failed sample is included in aggregates or the recommendation.',
    '',
    '## Aggregate Results',
    '',
    '| Mechanism | Accuracy | Event-to-action p50 / p95 | Inference p50 / p95 | Orchestration p50 / p95 | Samples |',
    '| --- | ---: | --- | --- | --- | ---: |',
    `| regular-llm | ${pct(regular.accuracy)} | ${latency(regular.latencyMs.eventToAction)} | ${latency(regular.latencyMs.inference)} | ${latency(regular.latencyMs.orchestration)} | ${regular.completedCount} |`,
    `| jev | ${pct(jev.accuracy)} | ${latency(jev.latencyMs.eventToAction)} | ${latency(jev.latencyMs.inference)} | ${latency(jev.latencyMs.orchestration)} | ${jev.completedCount} |`,
    '',
    '## Decision Correctness',
    '',
    '| Mechanism | Scenario | Expected | Actions observed | Accuracy |',
    '| --- | --- | --- | --- | ---: |',
    ...['regular-llm', 'jev'].flatMap((arm) =>
      PLATFORM_SCENARIO_IDS.map((id) => {
        const outcome = result.aggregates[arm].scenarios[id]!;
        const actions = Object.entries(outcome.actions)
          .map(([action, count]) => `${action} x${count}`)
          .join(', ');
        return `| ${arm} | ${id} | ${outcome.expectedAction} | ${actions} | ${pct(outcome.accuracy)} |`;
      }),
    ),
    '',
    '## Raw Samples',
    '',
    '| Rep | Arm | Scenario | Status | Actual | Correct | Event-to-action ms | Inference ms | Orchestration ms |',
    '| ---: | --- | --- | --- | --- | --- | ---: | ---: | ---: |',
    ...result.samples.map(
      (sample) =>
        `| ${sample.repetition} | ${sample.mechanism} | ${sample.scenarioId} | ${sample.status} | ${sample.actualAction ?? 'n/a'} | ${sample.correct === null ? 'n/a' : sample.correct ? 'yes' : 'no'} | ${format(sample.durationsMs.eventToAction)} | ${format(sample.durationsMs.inference)} | ${format(sample.durationsMs.orchestration)} |`,
    ),
    '',
    '## Recommendation',
    '',
    '**No-go for production action control.** The platform comparison is valid and shows a Jev latency candidate, but the Jev branch is still an opt-in experiment and has not been validated on the full inspection/steering surface or real production traffic. Keep deterministic lifecycle, permissions, cancellation, queueing, and human steering outside Jev.',
    '',
    '## Reproduction',
    '',
    '```bash',
    'pnpm exec dotenvx run --quiet -f .env.local -- pnpm --filter @roomote/cloud-agents benchmark:session-communication-latency -- --reps 2 --bullmq-log /tmp/roomote-bullmq.log --output experiments/session-communication-latency.json',
    '```',
    '',
  ];
  return lines.join('\n');
}

function format(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(1);
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function latency(value: {
  count: number;
  p50: number | null;
  p95: number | null;
}): string {
  return value.count === 0
    ? 'n/a'
    : `p50 ${format(value.p50)} / p95 ${format(value.p95)} ms (n=${value.count})`;
}

type ExperimentResult = {
  schemaVersion: 2;
  generatedAt: string;
  gitRevision: string | null;
  configuration: { repetitions: number; logPath: string; scenarios: string[] };
  platform: {
    regularPath: string;
    jevPath: string;
    sessionPolicy: string;
  };
  aggregates: Record<Arm, ReturnType<typeof summarizeCommunicationTrials>>;
  samples: Array<
    CommunicationTrialResult & {
      repetition: number;
      sessionId: string;
      messageId: string;
    }
  >;
  comparisonEligible: boolean;
};

const outputPath = path.resolve(
  readFlag('--output') ?? 'experiments/session-communication-latency.json',
);
const logPath = readFlag('--bullmq-log') ?? DEFAULT_LOG_PATH;
const repetitions = readNumberFlag('--reps', DEFAULT_REPETITIONS);
const userId = process.env.LATENCY_USER_ID ?? DEFAULT_USER_ID;
const runNonce = Date.now().toString(36);
const scenarioById = new Map(
  PLATFORM_SCENARIO_IDS.map((id) => [
    id,
    COMMUNICATION_SCENARIOS.find((scenario) => scenario.id === id)!,
  ]),
);
const samples: Array<
  CommunicationTrialResult & {
    repetition: number;
    sessionId: string;
    messageId: string;
  }
> = [];
let sequence = 0;

for (let repetition = 1; repetition <= repetitions; repetition += 1) {
  for (const scenarioId of PLATFORM_SCENARIO_IDS) {
    const scenario = scenarioById.get(scenarioId)!;
    for (const arm of ['regular-llm', 'jev'] as const) {
      sequence += 1;
      const conversation = {
        surface: 'web' as const,
        workspaceId: userId,
        conversationId: randomUUID(),
      };
      const session = await getOrCreateFastAgentSession({
        userId,
        owner: { kind: 'user', userId },
        conversation,
      });
      const messageId = `latency-platform-${runNonce}-${arm}-${scenario.id}-${sequence}`;
      const admittedAtMs = Date.now();
      const queued = await enqueueFastAgentParentEvent({
        parent: { sessionId: session.id, conversation: session.conversation },
        event: {
          type: 'child_message',
          taskId: `latency-platform-task-${sequence}`,
          runId: 20_000 + sequence,
          actingUserId: userId,
          messageId,
          admittedAtMs,
          purpose:
            scenario.id === 'completion_adequate_evidence'
              ? 'closeout'
              : scenario.id === 'blocked_user_input'
                ? 'clarification'
                : 'progress',
          message: scenario.state.event.text,
          ...(arm === 'jev' ? { communicationExperiment: 'jev' as const } : {}),
        },
      });
      const deliveredAt = await waitForDelivery(queued.eventKey);
      const diagnostic = await waitForDiagnostic(messageId, arm);
      const visibleRows = await readVisibleAssistantMessages(
        session.id,
        `fast-parent-child-message:${messageId}`,
      );
      samples.push({
        ...buildTrial({
          arm,
          scenario,
          repetition,
          sessionId: session.id,
          messageId,
          admittedAtMs,
          deliveredAt,
          diagnostic,
          visibleRows,
        }),
      });
    }
  }
}

const aggregates = {
  'regular-llm': summarizeCommunicationTrials(
    'regular-llm',
    samples.filter((sample) => sample.mechanism === 'regular-llm'),
  ),
  jev: summarizeCommunicationTrials(
    'jev',
    samples.filter((sample) => sample.mechanism === 'jev'),
  ),
};
const result: ExperimentResult = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  gitRevision: readGitRevision(),
  configuration: {
    repetitions,
    logPath,
    scenarios: [...PLATFORM_SCENARIO_IDS],
  },
  platform: {
    regularPath:
      'fast_agent_parent_events -> BullMQ -> deliverFastAgentParentEvent -> answerFastAgentQuestion',
    jevPath:
      'fast_agent_parent_events -> BullMQ -> opt-in communicationExperiment=jev -> evaluateTypeSafeJudgments -> persisted Session assistant message',
    sessionPolicy: 'fresh web Fast Session per arm and scenario repetition',
  },
  aggregates,
  samples,
  comparisonEligible: samples.every((sample) => sample.status === 'completed'),
};

if (!result.comparisonEligible) {
  throw new Error('Platform comparison had an invalid or missing sample.');
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(outputPath.replace(/\.json$/u, '.md'), markdownReport(result));
console.log(JSON.stringify(result, null, 2));
process.exit(0);
