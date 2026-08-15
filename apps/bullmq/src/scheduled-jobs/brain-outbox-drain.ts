import {
  db,
  backfillBrainMemoryEvents,
  claimPendingBrainMemoryEvents,
  getBrainSyncState,
  upsertBrainSyncState,
  environments,
  markBrainMemoryEvent,
  releaseBrainMemoryEvents,
  pullRequestFacts,
  taskPullRequests,
  taskRuns,
  eq,
  gt,
} from '@roomote/db/server';
import {
  resolveBrainInferenceProvider,
  resolveBrainConnection,
} from '@roomote/sdk/server';
import { getLinkedEnvironmentIdFromPayload, RunStatus } from '@roomote/types';

import { runBrainCollectors } from './brain-collectors';

const LOG_PREFIX = '[brainOutboxDrain]';
/** Sync-state key for the one-time task-history backfill. */
const TASK_MEMORY_COLLECTOR_ID = 'task-memory';
const CLAIM_BATCH_SIZE = 10;
// Backfill can enqueue a deployment's whole task history at once; drain up
// to this many batches per tick so the backlog clears in minutes, not hours.
const MAX_BATCHES_PER_TICK = 20;
const MAX_ATTEMPTS = 5;

/**
 * In-process watermark for integration-source sync (merged-PR facts). The
 * first tick after process start re-syncs everything, which is harmless:
 * pages are idempotent upserts keyed by slug.
 */
let prFactsSyncedThrough: Date | null = null;

/**
 * Deterministic pre-ingestion redaction. This is a structural boundary, not a
 * prompt: nothing leaves for the brain without passing through it. Patterns
 * mirror the sandbox worker-env scrub list; keep the two in sync when adding
 * a credential shape.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
];

export function redactBrainText(text: string): string {
  let redacted = text;

  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }

  return redacted;
}

type IngestPage = {
  slug: string;
  title: string;
  content: string;
};

/**
 * Backpressure from the Brain, as a typed error rather than a substring match
 * on prose. The upstream body is attacker-adjacent text (page content can echo
 * back in an error), so `message.includes('429')` would let unrelated content
 * masquerade as rate limiting and silently stall ingestion.
 */
export class BrainRateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrainRateLimitedError';
  }
}

/**
 * The Brain rejected a page because it could not embed it. That is a property
 * of the deployment (no provider configured, or the provider is down), not of
 * the page, so it must not consume the page's retry budget: burning through
 * attempts here would bury a perfectly good memory in a terminal state that
 * no later claim picks up, for the duration of an outage.
 */
class BrainNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrainNotReadyError';
  }
}

export function isBrainRateLimited(error: unknown): boolean {
  return error instanceof BrainRateLimitedError;
}

export function isBrainNotReady(error: unknown): boolean {
  return error instanceof BrainNotReadyError;
}

/**
 * Write one memory page via gbrain's MCP `put_page` op with a write-scoped
 * access token. Synchronous and immediately retrievable, so task completion
 * does not wait behind gbrain's background maintenance queue.
 */
export async function postToBrain(
  page: IngestPage,
  connection: { baseUrl: string; token: string },
): Promise<void> {
  const { baseUrl, token } = connection;

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'put_page',
        arguments: { slug: page.slug, content: page.content },
      },
    }),
  });

  const body = await response.text().catch(() => '');

  if (response.status === 429) {
    throw new BrainRateLimitedError(
      `gbrain put_page rate limited: ${body.slice(0, 300)}`,
    );
  }

  const failed = !response.ok || body.includes('"isError":true');

  if (failed && /embed\(|embedding/i.test(body)) {
    throw new BrainNotReadyError(
      `gbrain put_page could not embed: ${body.slice(0, 300)}`,
    );
  }

  if (failed) {
    throw new Error(
      `gbrain put_page failed: ${response.status} ${body.slice(0, 300)}`,
    );
  }
}

/**
 * Build the memory page for a completed run. Deliberately deterministic and
 * conservative: only structured, known-safe fields (title, repos, PRs,
 * timestamps, provenance). LLM distillation of decisions/rationale layers on
 * top of this later; it must never widen what raw data can reach the brain.
 */
export function buildMemoryPage(input: {
  runId: number;
  taskId: string;
  taskTitle: string;
  completedAt: Date | null;
  environmentName: string | null;
  agentSummary: string | null;
  pullRequests: Array<{
    repository: string | null;
    prNumber: number | null;
    prTitle: string | null;
    prUrl: string;
  }>;
}): IngestPage {
  const completedAtIso = input.completedAt?.toISOString();
  const completed = completedAtIso ?? 'unknown';
  const completedDate = completedAtIso?.slice(0, 10);
  const prLines = input.pullRequests.map((pr) => {
    const label =
      pr.repository && pr.prNumber
        ? `${pr.repository}#${pr.prNumber}`
        : pr.prUrl;

    return `- ${label}${pr.prTitle ? `: ${pr.prTitle}` : ''} (${pr.prUrl})`;
  });

  const content = [
    '---',
    `roomote_task_id: ${input.taskId}`,
    `roomote_run_id: ${input.runId}`,
    // GBrain derives effective_date from this conventional field. Keep the
    // full timestamp below as provenance, but make backfilled pages sort and
    // filter by when the task completed rather than when it was ingested.
    ...(completedDate ? [`date: ${completedDate}`] : []),
    `completed_at: ${completed}`,
    // Environment stamp: costs nothing now, enables environment-scoped
    // retrieval (gbrain sources) or admin triage later without re-ingesting.
    ...(input.environmentName ? [`environment: ${input.environmentName}`] : []),
    'provenance: roomote-task-memory',
    '---',
    '',
    `# ${input.taskTitle}`,
    '',
    // The agent that did the work writes the substance when it can; the
    // deterministic completion line is the floor, not the ceiling.
    ...(input.agentSummary
      ? [input.agentSummary, '']
      : ['## Outcome', '', `Task completed at ${completed}.`, '']),
    ...(prLines.length > 0 ? ['## Pull requests', '', ...prLines, ''] : []),
  ].join('\n');

  return {
    slug: `tasks/${input.taskId}/runs/${input.runId}`,
    title: input.taskTitle,
    content: redactBrainText(content),
  };
}

/**
 * Drain the brain_memory_events transactional outbox. Runs on the
 * shared scheduler queue; claims use FOR UPDATE SKIP LOCKED so overlapping
 * ticks never double-process. When the brain is enabled, completed tasks
 * feed it deployment-wide (the corpus is company-wide by definition;
 * enabling the integration is the ingestion consent). Skip rules decide
 * whether a claimed event becomes a memory ('done'), is skipped, or retries.
 */
export async function brainOutboxDrainJob(): Promise<void> {
  const connection = await resolveReadyBrain();

  if (!connection) {
    return;
  }

  await backfillTaskHistoryOnce();

  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    const drained = await drainOneBatch(connection);

    if (!drained) {
      break;
    }
  }
}

/**
 * A Brain worth writing to needs both halves: somewhere to put pages, and a
 * model provider to embed them with.
 *
 * The provider half is not optional caution. Every page written to a Brain
 * that cannot embed fails outright — gbrain retries the embed three times and
 * returns an error — so draining ahead of a configured provider would burn
 * each memory through its retry budget into a terminal 'failed' state that no
 * later claim picks up, and would mark the one-shot history backfill complete
 * before a single page landed. Holding here instead is what makes turning the
 * Brain on later actually pick up everything that happened before.
 */
async function resolveReadyBrain(): Promise<{
  baseUrl: string;
  token: string;
} | null> {
  // Provider first, and not in parallel: resolving a connection registers
  // scoped OAuth clients against the Brain as a side effect, which is not
  // worth doing for a Brain that cannot embed yet. This check is cached, so
  // the common unconfigured tick costs nothing.
  const provider = await resolveBrainInferenceProvider();

  if (!provider) {
    return null;
  }

  return resolveBrainConnection('ingest');
}

/**
 * A Brain arrives knowing the deployment's history, not just what happens
 * next: the first tick after activation enqueues every already-completed run
 * into the outbox. Recorded durably so it happens exactly once, even across
 * restarts (there is no connect action to hang this off anymore).
 */
async function backfillTaskHistoryOnce(): Promise<void> {
  const state = await getBrainSyncState(db, TASK_MEMORY_COLLECTOR_ID);

  if (state?.backfillCompletedAt) {
    return;
  }

  const enqueued = await backfillBrainMemoryEvents(db);

  await upsertBrainSyncState(db, TASK_MEMORY_COLLECTOR_ID, {
    backfillCompletedAt: new Date(),
  });

  console.log(
    `${LOG_PREFIX} enqueued ${enqueued} completed runs from task history`,
  );
}

/**
 * Integration-source sync on its own slower cadence: an empty tick against
 * external APIs is not free (Slack costs one history call per channel), and
 * the brain is durable memory, not a live cache, so minute-level freshness
 * buys nothing here. Task memories (the outbox above) stay on the fast tick.
 */
export async function brainCollectorsJob(): Promise<void> {
  const connection = await resolveReadyBrain();

  if (!connection) {
    return;
  }

  await syncPullRequestFacts(connection);
  await runBrainCollectors(connection);
}

/** Returns false when no pending events remained to claim. */
async function drainOneBatch(connection: {
  baseUrl: string;
  token: string;
}): Promise<boolean> {
  const events = await claimPendingBrainMemoryEvents(db, CLAIM_BATCH_SIZE);

  if (events.length === 0) {
    return false;
  }

  for (const [index, event] of events.entries()) {
    try {
      const run = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, event.runId),
        with: { task: true },
      });

      if (!run) {
        await markBrainMemoryEvent(
          db,
          event.id,
          'skipped',
          'run no longer exists',
        );
        continue;
      }

      // An agent can save its memory before its run finishes (the tool call
      // is part of wrapping up), which creates this row while the run is
      // still in flight. Only a run that settled somewhere other than
      // Completed is a real skip; anything still moving must stay pending, or
      // a drain tick landing in that window would discard the memory for good.
      if (run.status !== RunStatus.Completed) {
        const settled =
          run.status === RunStatus.Failed || run.status === RunStatus.Canceled;

        await markBrainMemoryEvent(
          db,
          event.id,
          settled ? 'skipped' : 'pending',
          `run status is ${run.status}`,
        );

        if (!settled) {
          // Claiming charged an attempt, but nothing was delivered: the run is
          // simply not finished. Left charged, an agent that saves its memory
          // early on a long task burns the whole retry budget before the first
          // real send, and the next transient failure is terminal.
          await releaseBrainMemoryEvents(db, [event.id]);
        }

        continue;
      }

      const prRows = await db
        .select()
        .from(taskPullRequests)
        .where(eq(taskPullRequests.taskId, run.taskId));

      const environmentId = getLinkedEnvironmentIdFromPayload(run.payload);
      let environmentName: string | null = null;

      if (environmentId) {
        const [environment] = await db
          .select({ name: environments.name })
          .from(environments)
          .where(eq(environments.id, environmentId))
          .limit(1);
        environmentName = environment?.name ?? null;
      }

      const page = buildMemoryPage({
        environmentName,
        agentSummary: event.agentSummary,
        runId: run.id,
        taskId: run.taskId,
        taskTitle: run.task.title,
        completedAt: run.completedAt,
        pullRequests: prRows.map((pr) => ({
          repository: pr.repository,
          prNumber: pr.prNumber,
          prTitle: pr.prTitle,
          prUrl: pr.prUrl,
        })),
      });

      await postToBrain(page, connection);
      await markBrainMemoryEvent(db, event.id, 'done');

      console.log(
        `${LOG_PREFIX} ingested memory for run ${event.runId} (${page.slug})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // A 429 means "slow down", not "this event is bad". Requeue without
      // terminal-failure accounting and end the tick so the next one (60s
      // later) resumes gently. The rest of this batch was already flipped to
      // 'processing' by the claim, so hand it back explicitly rather than
      // leaving it to the stale-claim reclaim fifteen minutes later.
      // Both mean "not this event's fault, and not now": hand the whole
      // remaining batch back and let a later tick retry the same idempotent
      // slugs once the Brain can actually accept them.
      if (isBrainRateLimited(error) || isBrainNotReady(error)) {
        await markBrainMemoryEvent(db, event.id, 'pending', message);
        await releaseBrainMemoryEvents(db, [
          event.id,
          ...events.slice(index + 1).map((pending) => pending.id),
        ]);
        console.log(
          `${LOG_PREFIX} ${
            isBrainRateLimited(error) ? 'rate limited by' : 'cannot embed into'
          } the brain; pausing until next tick`,
        );
        return false;
      }

      const terminal = event.attempts >= MAX_ATTEMPTS;

      await markBrainMemoryEvent(
        db,
        event.id,
        terminal ? 'failed' : 'pending',
        message,
      );

      console.warn(
        `${LOG_PREFIX} ${terminal ? 'permanently failed' : 'will retry'} run ${
          event.runId
        } (attempt ${event.attempts}): ${message}`,
      );
    }
  }

  return true;
}

/** Per-tick ceiling on PR fact pages. See the tie handling in the body. */
const PR_FACTS_BATCH_SIZE = 500;

/**
 * First integration-derived memory source: merged pull requests, from the
 * locally mirrored pull_request_facts table (populated by the analytics
 * sync from the deployment's connected source control). Incremental via an
 * in-process watermark; pages are idempotent upserts keyed by slug, so the
 * full re-sync after a process restart is harmless.
 */
async function syncPullRequestFacts(connection: {
  baseUrl: string;
  token: string;
}): Promise<void> {
  const since = prFactsSyncedThrough;
  const syncStartedAt = new Date();

  const facts = await db
    .select({
      repositoryFullName: pullRequestFacts.repositoryFullName,
      prNumber: pullRequestFacts.prNumber,
      title: pullRequestFacts.title,
      htmlUrl: pullRequestFacts.htmlUrl,
      authorLogin: pullRequestFacts.authorLogin,
      state: pullRequestFacts.state,
      mergedAtRemote: pullRequestFacts.mergedAtRemote,
      updatedAt: pullRequestFacts.updatedAt,
    })
    .from(pullRequestFacts)
    .where(since ? gt(pullRequestFacts.updatedAt, since) : undefined)
    .orderBy(pullRequestFacts.updatedAt)
    .limit(PR_FACTS_BATCH_SIZE);

  if (facts.length === 0) {
    prFactsSyncedThrough = syncStartedAt;
    return;
  }

  // The facts writer stamps one syncedAt across a whole sync batch, so ties on
  // updatedAt are the norm rather than the exception. A strictly-greater
  // watermark parked on a tied timestamp would skip every row sharing it past
  // the batch limit, so drop the trailing tie group and let the next tick
  // re-read it whole. Bail out only if the entire batch is one timestamp,
  // where dropping it would mean never advancing at all.
  const lastUpdatedAt = facts[facts.length - 1]!.updatedAt;
  const batchWasCapped = facts.length === PR_FACTS_BATCH_SIZE;
  const trimmed =
    batchWasCapped && facts[0]!.updatedAt.getTime() !== lastUpdatedAt.getTime()
      ? facts.filter(
          (fact) => fact.updatedAt.getTime() !== lastUpdatedAt.getTime(),
        )
      : facts;

  let ingested = 0;

  for (const fact of trimmed) {
    try {
      const merged = fact.mergedAtRemote?.toISOString();
      const content = [
        '---',
        `repository: ${fact.repositoryFullName}`,
        `pr_number: ${fact.prNumber}`,
        `state: ${fact.state}`,
        ...(fact.authorLogin ? [`author: ${fact.authorLogin}`] : []),
        ...(merged ? [`merged_at: ${merged}`] : []),
        'provenance: roomote-pull-requests',
        '---',
        '',
        `# ${fact.repositoryFullName}#${fact.prNumber}: ${fact.title}`,
        '',
        `${fact.state === 'merged' || merged ? 'Merged' : 'State: ' + fact.state}${merged ? ` at ${merged}` : ''}${fact.authorLogin ? ` by ${fact.authorLogin}` : ''}.`,
        '',
        fact.htmlUrl,
      ].join('\n');

      await postToBrain(
        {
          slug: `prs/${fact.repositoryFullName}/${fact.prNumber}`,
          title: `${fact.repositoryFullName}#${fact.prNumber}: ${fact.title}`,
          content: redactBrainText(content),
        },
        connection,
      );
      ingested++;
    } catch (error) {
      // Leave the watermark unadvanced past this fact; retry next tick.
      console.warn(
        `${LOG_PREFIX} PR fact sync failed for ${fact.repositoryFullName}#${fact.prNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
  }

  prFactsSyncedThrough =
    trimmed[trimmed.length - 1]?.updatedAt ?? prFactsSyncedThrough;

  if (ingested > 0) {
    console.log(
      `${LOG_PREFIX} synced ${ingested} pull request facts into the brain`,
    );
  }
}
