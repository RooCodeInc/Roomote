/**
 * Offline calibration check for Session task-communication triage.
 *
 * Scores fixtures (a triage state plus the outcome a person would want)
 * through the real judgment questions and policy, then prints each case's
 * signals and, per signal, the highest score among should-stay-quiet cases
 * and the lowest among should-reach-the-Session cases. Use the margins to
 * move `TASK_COMMUNICATION_SIGNAL_THRESHOLDS` or reword a question.
 *
 *   pnpm --filter @roomote/cloud-agents task-communication-triage:eval
 *   pnpm --filter @roomote/cloud-agents task-communication-triage:eval \
 *     --fixtures evals/task-communication-triage/runs.local.json
 *
 * Build fixtures from a local deployment's recent delegated tasks with
 * `--export-runs 480-500 --out evals/task-communication-triage/runs.local.json`,
 * then hand-label each `expected`. Exports carry real task content, so keep
 * them in `*.local.json` (gitignored), never in the checked-in fixtures.
 *
 * Requires the local database and a judgment model key (TypeSafe,
 * OpenRouter, or Vercel AI Gateway) in the environment.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  and,
  asc,
  db,
  desc,
  eq,
  fastAgentMessages,
  fastAgentParentEvents,
  inArray,
  lt,
  sql,
  taskMessages,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  extractAcpMessageText,
  extractVisibleAcpPromptText,
  isSystemInjectedAcpPromptText,
  type TaskMessageContentBlock,
} from '@roomote/types';

import {
  TASK_COMMUNICATION_SIGNAL_THRESHOLDS,
  triageTaskCommunication,
  type TaskCommunicationSignal,
  type TaskCommunicationTriageResult,
  type TaskCommunicationTriageState,
  type TaskCommunicationUpdate,
} from './fast-agent-task-communication-triage';

/** `either` marks a case where both outcomes are acceptable. */
type Expected = 'reaches_session' | 'quiet' | 'either';

type Fixture = {
  name: string;
  expected: Expected;
  note?: string;
  state: TaskCommunicationTriageState;
};

const DEFAULT_FIXTURES = 'evals/task-communication-triage/fixtures.json';
const MAX_INSTRUCTIONS_CHARS = 1_200;
const MAX_CONTEXT_CHARS = 800;
const MAX_CONTEXT_MESSAGES = 6;

function truncate(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars
    ? `${trimmed.slice(0, maxChars - 1).trimEnd()}…`
    : trimmed;
}

function textOf(row: {
  contentBlocks: TaskMessageContentBlock[];
  payload: unknown;
}): string | undefined {
  let text = extractAcpMessageText(
    row.contentBlocks,
    row.payload as Record<string, unknown> | null,
  );
  if (text && isSystemInjectedAcpPromptText(text)) {
    text = extractVisibleAcpPromptText(text);
  }
  return text?.trim() || undefined;
}

function silenceBucket(
  lastHeardAtMs: number | null,
  atMs: number,
): TaskCommunicationTriageState['silenceSinceRequesterLastHeard'] {
  if (lastHeardAtMs === null) return 'never_heard';
  const minutes = (atMs - lastHeardAtMs) / 60_000;
  if (minutes < 5) return 'under_5_minutes';
  if (minutes < 20) return '5_to_20_minutes';
  return 'over_20_minutes';
}

/**
 * Rebuild the triage state each delegated-task event had when it arrived,
 * mirroring the Session-side builder. Presence is not recorded, so exports
 * assume the requester was present. Events production skips without a
 * judgment (activity after a relayed result or after the run settled) are
 * left out.
 */
async function exportRuns(fromRunId: number, toRunId: number) {
  const events = await db
    .select({
      conversationId: fastAgentParentEvents.conversationId,
      event: fastAgentParentEvents.event,
      createdAt: fastAgentParentEvents.createdAt,
    })
    .from(fastAgentParentEvents)
    .where(
      and(
        sql`${fastAgentParentEvents.event} ->> 'type' in ('task_activity', 'child_message', 'task_settled')`,
        sql`(${fastAgentParentEvents.event} ->> 'runId')::integer between ${fromRunId} and ${toRunId}`,
      ),
    )
    .orderBy(asc(fastAgentParentEvents.createdAt));

  const closedRuns = new Set<number>();
  const fixtures: Fixture[] = [];
  for (const row of events) {
    const event = row.event as Record<string, unknown>;
    const runId = Number(event.runId);
    if (event.type === 'task_settled') {
      closedRuns.add(runId);
      continue;
    }
    if (event.type === 'task_activity' && closedRuns.has(runId)) continue;
    if (event.type === 'child_message' && event.purpose === 'closeout') {
      closedRuns.add(runId);
    }

    const atMs = row.createdAt.getTime();
    const [run] = await db
      .select({ taskId: taskRuns.taskId, title: tasks.title })
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .where(eq(taskRuns.id, runId))
      .limit(1);
    const prompt = await db.query.taskMessages.findFirst({
      where: and(
        eq(taskMessages.runId, runId),
        eq(taskMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
      ),
      columns: { contentBlocks: true, payload: true },
      orderBy: [asc(taskMessages.ts)],
    });
    const conversation = await db
      .select({
        ts: fastAgentMessages.ts,
        eventType: fastAgentMessages.eventType,
        contentBlocks: fastAgentMessages.contentBlocks,
        payload: fastAgentMessages.payload,
        metadata: fastAgentMessages.metadata,
      })
      .from(fastAgentMessages)
      .where(
        and(
          eq(fastAgentMessages.conversationId, row.conversationId),
          inArray(fastAgentMessages.eventType, [
            ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
            ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
          ]),
          lt(fastAgentMessages.ts, atMs),
          sql`coalesce(${fastAgentMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'`,
        ),
      )
      .orderBy(desc(fastAgentMessages.ts))
      .limit(40);

    const asked: string[] = [];
    const told: string[] = [];
    let lastHeardAtMs: number | null = null;
    for (const message of [...conversation].reverse()) {
      const text = textOf(message);
      if (!text) continue;
      if (message.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt) {
        const metadata = message.metadata as Record<string, unknown> | null;
        if (metadata?.turnSource === 'human') {
          asked.push(truncate(text, MAX_CONTEXT_CHARS));
        }
      } else {
        told.push(truncate(text, MAX_CONTEXT_CHARS));
        lastHeardAtMs = message.ts;
      }
    }
    const instructions = prompt ? textOf(prompt) : undefined;
    const update: TaskCommunicationUpdate =
      event.type === 'child_message'
        ? {
            kind: 'task_report',
            purpose: event.purpose as Extract<
              TaskCommunicationUpdate,
              { kind: 'task_report' }
            >['purpose'],
            text: String(event.message),
          }
        : {
            kind: 'task_activity',
            items: event.items as Extract<
              TaskCommunicationUpdate,
              { kind: 'task_activity' }
            >['items'],
          };

    fixtures.push({
      name: `run ${runId} ${event.type} ${row.createdAt.toISOString()}`,
      expected: 'either',
      state: {
        surface: 'web',
        requesterIsPresent: true,
        silenceSinceRequesterLastHeard: silenceBucket(lastHeardAtMs, atMs),
        whatTheRequesterAskedFor: [
          ...(instructions
            ? [truncate(instructions, MAX_INSTRUCTIONS_CHARS)]
            : []),
          ...asked.slice(-MAX_CONTEXT_MESSAGES),
        ],
        whatTheRequesterWasAlreadyTold: told.slice(-MAX_CONTEXT_MESSAGES),
        task: { title: run?.title ?? null },
        update,
      },
    });
  }
  return fixtures;
}

/** Whether production would spend a Session turn on this update. */
function reachesSession(
  result: TaskCommunicationTriageResult,
  update: TaskCommunicationUpdate,
): boolean {
  return (
    result.decision === 'relay' ||
    result.decision === 'redirect' ||
    (result.decision === 'uncertain' && update.kind === 'task_report')
  );
}

async function score(fixturesPath: string, concurrency: number) {
  const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as Fixture[];
  const results: Array<{
    fixture: Fixture;
    result: TaskCommunicationTriageResult;
  }> = [];
  for (let index = 0; index < fixtures.length; index += concurrency) {
    const batch = fixtures.slice(index, index + concurrency);
    results.push(
      ...(await Promise.all(
        batch.map(async (fixture) => {
          const result = await triageTaskCommunication(fixture.state, {
            timeoutMs: 15_000,
          });
          if (!result) {
            throw new Error('No judgment model is configured.');
          }
          return { fixture, result };
        }),
      )),
    );
  }

  const signals = Object.keys(
    TASK_COMMUNICATION_SIGNAL_THRESHOLDS,
  ) as TaskCommunicationSignal[];
  let agreed = 0;
  let labeled = 0;
  console.log(
    ['ok', 'expected', 'decision/reason', ...signals, 'name'].join('\t'),
  );
  for (const { fixture, result } of results) {
    const reached = reachesSession(result, fixture.state.update);
    const ok =
      fixture.expected === 'either' ||
      (fixture.expected === 'reaches_session') === reached;
    if (fixture.expected !== 'either') {
      labeled += 1;
      agreed += ok ? 1 : 0;
    }
    console.log(
      [
        ok ? ' ' : 'X',
        fixture.expected,
        `${result.decision}/${result.reason}`,
        ...signals.map((signal) => result.signals[signal].toFixed(2)),
        fixture.name,
      ].join('\t'),
    );
  }

  console.log(`\nAgreement: ${agreed}/${labeled} labeled cases.`);
  console.log(
    '\nsignal\tthreshold\tmax(quiet)\tmin(reaches, >= half threshold)',
  );
  for (const signal of signals) {
    const quiet = results
      .filter(({ fixture }) => fixture.expected === 'quiet')
      .map(({ result }) => result.signals[signal]);
    const fired = results
      .filter(
        ({ fixture, result }) =>
          fixture.expected === 'reaches_session' &&
          result.signals[signal] >=
            TASK_COMMUNICATION_SIGNAL_THRESHOLDS[signal] / 2,
      )
      .map(({ result }) => result.signals[signal]);
    console.log(
      [
        signal,
        TASK_COMMUNICATION_SIGNAL_THRESHOLDS[signal].toFixed(2),
        quiet.length ? Math.max(...quiet).toFixed(2) : '-',
        fired.length ? Math.min(...fired).toFixed(2) : '-',
      ].join('\t'),
    );
  }
}

const { values } = parseArgs({
  options: {
    fixtures: { type: 'string', default: DEFAULT_FIXTURES },
    concurrency: { type: 'string', default: '8' },
    'export-runs': { type: 'string' },
    out: { type: 'string' },
  },
});

if (values['export-runs']) {
  const [from, to] = values['export-runs'].split('-').map(Number);
  if (!values.out || !Number.isInteger(from) || !Number.isInteger(to)) {
    throw new Error('Usage: --export-runs <from>-<to> --out <path>');
  }
  if (!values.out.endsWith('.local.json')) {
    throw new Error('Exports carry real task content; write to *.local.json.');
  }
  const fixtures = await exportRuns(from!, to!);
  writeFileSync(resolve(values.out), `${JSON.stringify(fixtures, null, 2)}\n`);
  console.log(`Exported ${fixtures.length} fixtures to ${values.out}.`);
} else {
  await score(resolve(values.fixtures), Number(values.concurrency));
}
process.exit(0);
