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
  and,
  eq,
  gt,
  gte,
  or,
  renameBrainSyncStateFamilyPrefix,
} from '@roomote/db/server';
import {
  parseBrainToolPayloads,
  postBrainToolCall,
  resolveBrainInferenceProvider,
  resolveBrainConnection,
} from '@roomote/sdk/server';
import {
  BRAIN_COLLECTOR_IDS,
  BRAIN_PAGE_TYPES,
  RunStatus,
  brainNamespacePrefix,
  getLinkedEnvironmentIdFromPayload,
  renderBrainFrontmatter,
} from '@roomote/types';

import { runBrainCollectors } from './brain-collectors';
import {
  runSlackDayPageCensus,
  runSlackDayPageInventoryMaintenance,
} from './brain-collectors/slack-day-page-inventory';
import { slackPublicChannelsCollector } from './brain-collectors/slack-public-channels';

const LOG_PREFIX = '[brainOutboxDrain]';
/** Sync-state key for the one-time task-history backfill. */
const TASK_MEMORY_COLLECTOR_ID = BRAIN_COLLECTOR_IDS.taskMemories;
const CLAIM_BATCH_SIZE = 10;
// Backfill can enqueue a deployment's whole task history at once; drain up
// to this many batches per tick so the backlog clears in minutes, not hours.
const MAX_BATCHES_PER_TICK = 20;
const MAX_ATTEMPTS = 5;
// Versioned when date semantics change so existing pages are replayed and
// corrected instead of retaining stale effective dates forever.
const PR_FACTS_COLLECTOR_ID = BRAIN_COLLECTOR_IDS.pullRequestFacts;
// PR analytics gives every repository in one sync the same timestamp but
// writes repositories sequentially. Re-read a bounded window on each normal
// collector tick so a row committed late with that shared timestamp cannot
// fall behind a tuple cursor saved while the writer was still running.
const PR_FACTS_OVERLAP_MS = 24 * 60 * 60 * 1000;
const BACKFILL_CONTINUATION_DELAY_MS = 1_000;

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

export async function callBrainWriteTool(
  connection: { baseUrl: string; token: string },
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  // Shared transport; the backpressure classification below is this write
  // path's own and deliberately stays here. No timeout: put_page embeds
  // synchronously and a slow embed is backpressure, not a failure.
  const { status, ok, body } = await postBrainToolCall(connection, name, args);

  if (status === 429) {
    throw new BrainRateLimitedError(
      `gbrain ${name} rate limited: ${body.slice(0, 300)}`,
    );
  }

  // Detect tool-level failure through the shared JSON-RPC parser rather than
  // a substring match: the parser owns the envelope shape (including
  // whitespace-tolerant isError detection) and error prose from the page body
  // must never masquerade as failure classification.
  let toolError: string | null = null;

  try {
    parseBrainToolPayloads(body, name);
  } catch (error) {
    toolError = error instanceof Error ? error.message : String(error);
  }

  const failed = !ok || toolError !== null;
  const failureText = `${toolError ?? ''} ${body.slice(0, 300)}`;

  if (failed && /embed\(|embedding/i.test(failureText)) {
    throw new BrainNotReadyError(
      `gbrain ${name} could not embed: ${failureText.slice(0, 300)}`,
    );
  }

  if (failed) {
    throw new Error(`gbrain ${name} failed: ${failureText.slice(0, 300)}`);
  }

  return body;
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
  await callBrainWriteTool(connection, 'put_page', {
    slug: page.slug,
    content: page.content,
  });
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
    ...renderBrainFrontmatter({
      type: BRAIN_PAGE_TYPES.taskMemory,
      title: input.taskTitle,
      // Legacy completed runs can lack a completion time; `completed` is the
      // literal "unknown" then, which is no date at all.
      created: completedAtIso ?? null,
      fields: [
        `roomote_task_id: ${input.taskId}`,
        `roomote_run_id: ${input.runId}`,
        // GBrain derives effective_date from this conventional field. Keep
        // the full timestamp below as provenance, but make backfilled pages
        // sort and filter by when the task completed rather than when it
        // was ingested.
        completedDate && `date: ${completedDate}`,
        `completed_at: ${completed}`,
        // Environment stamp: costs nothing now, enables environment-scoped
        // retrieval (gbrain sources) or admin triage later without
        // re-ingesting.
        input.environmentName && `environment: ${input.environmentName}`,
        'provenance: roomote-task-memory',
      ],
    }),
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
    slug: `${brainNamespacePrefix('tasks')}${input.taskId}/runs/${input.runId}`,
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

  const enqueued = await backfillBrainMemoryEvents(db, {
    requeueCompleted: true,
  });

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

  try {
    // Before any Slack collection: repair pre-canonicalization inventories
    // (re-arming the healing replay where the case mismatch neutered it),
    // then the one-time inventory census the Slack collector holds on.
    // Running these here, ahead of the pass, normally completes them within
    // the first tick after a deploy.
    await runSlackDayPageInventoryMaintenance(slackPublicChannelsCollector.id);
    await runSlackDayPageCensus();
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} slack day-page census failed; slack collection stays held: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    // The GitHub per-repository stream rows were once keyed under a
    // hardcoded superseded version while the collector moved on; move them
    // under the current id so their watermarks and cursors keep counting as
    // the source's live streams. No-op fast once clean.
    await renameBrainSyncStateFamilyPrefix(
      db,
      'github-issues:occurrence-date-v2',
      BRAIN_COLLECTOR_IDS.githubIssues,
    );
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} github stream-row migration failed; retrying next tick: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let includeIncremental = true;

  await drainBrainHistoricalIngestion({
    async runPass() {
      const pullRequestFactsResult = await syncPullRequestFacts(connection, {
        restartFromOverlap: includeIncremental,
      });

      if (pullRequestFactsResult.interrupted) {
        return { progressed: false, interrupted: true };
      }

      const collectorResult = await runBrainCollectors(connection, {
        includeIncremental,
      });
      includeIncremental = false;

      return {
        progressed:
          pullRequestFactsResult.progressed ||
          collectorResult.backfillProgressed,
        interrupted: collectorResult.interrupted,
      };
    },
  });
}

/**
 * Keep spending the existing bounded per-pass budgets while historical work
 * advances. The normal scheduler remains at 15 minutes for steady-state API
 * polling; only an active backfill loops quickly, and any Brain backpressure
 * ends the loop until the next scheduled tick.
 */
export async function drainBrainHistoricalIngestion(input: {
  runPass: () => Promise<{ progressed: boolean; interrupted: boolean }>;
  wait?: () => Promise<void>;
}): Promise<void> {
  const wait =
    input.wait ??
    (() =>
      new Promise((resolve) =>
        setTimeout(resolve, BACKFILL_CONTINUATION_DELAY_MS),
      ));

  for (;;) {
    const result = await input.runPass();

    if (result.interrupted || !result.progressed) {
      return;
    }

    console.log(
      `${LOG_PREFIX} historical ingestion advanced; continuing without waiting for the next scheduled tick`,
    );
    await wait();
  }
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

/** Per-pass ceiling on PR fact pages. A durable keyset resumes immediately. */
const PR_FACTS_BATCH_SIZE = 500;

type PullRequestFactsCursor = { updatedAt: string; id: string };

function parsePullRequestFactsCursor(
  raw: string | null,
): PullRequestFactsCursor | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PullRequestFactsCursor>;
    const updatedAt =
      typeof parsed.updatedAt === 'string' ? new Date(parsed.updatedAt) : null;

    if (
      !updatedAt ||
      Number.isNaN(updatedAt.getTime()) ||
      typeof parsed.id !== 'string'
    ) {
      return null;
    }

    return { updatedAt: updatedAt.toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}

export function getPullRequestFactsResumeCursor(
  state: { watermark: Date | null; backfillCursor: string | null } | null,
  restartFromOverlap: boolean,
): { updatedAt: Date; id: string | null } | null {
  const cursor = parsePullRequestFactsCursor(state?.backfillCursor ?? null);
  const updatedAt = cursor
    ? new Date(cursor.updatedAt)
    : (state?.watermark ?? null);

  if (!updatedAt) {
    return null;
  }

  if (restartFromOverlap) {
    return {
      updatedAt: new Date(updatedAt.getTime() - PR_FACTS_OVERLAP_MS),
      id: null,
    };
  }

  return { updatedAt, id: cursor?.id ?? null };
}

export function buildPullRequestFactPage(fact: {
  repositoryFullName: string;
  prNumber: number;
  title: string;
  htmlUrl: string;
  authorLogin: string | null;
  state: string;
  createdAtRemote: Date;
  closedAtRemote: Date | null;
  mergedAtRemote: Date | null;
}): IngestPage {
  const merged = fact.mergedAtRemote?.toISOString();
  const occurredAt =
    fact.mergedAtRemote ?? fact.closedAtRemote ?? fact.createdAtRemote;
  const content = [
    ...renderBrainFrontmatter({
      type: BRAIN_PAGE_TYPES.pullRequest,
      title: `${fact.repositoryFullName}#${fact.prNumber}: ${fact.title}`,
      created: fact.createdAtRemote,
      fields: [
        `event_date: ${occurredAt.toISOString().slice(0, 10)}`,
        `repository: ${fact.repositoryFullName}`,
        `pr_number: ${fact.prNumber}`,
        `state: ${fact.state}`,
        fact.authorLogin && `author: ${fact.authorLogin}`,
        merged && `merged_at: ${merged}`,
        'provenance: roomote-pull-requests',
      ],
    }),
    '',
    `# ${fact.repositoryFullName}#${fact.prNumber}: ${fact.title}`,
    '',
    `${fact.state === 'merged' || merged ? 'Merged' : 'State: ' + fact.state}${merged ? ` at ${merged}` : ''}${fact.authorLogin ? ` by ${fact.authorLogin}` : ''}.`,
    '',
    fact.htmlUrl,
  ].join('\n');

  return {
    slug: `${brainNamespacePrefix('prs')}${fact.repositoryFullName}/${fact.prNumber}`,
    title: `${fact.repositoryFullName}#${fact.prNumber}: ${fact.title}`,
    content: redactBrainText(content),
  };
}

/**
 * First integration-derived memory source: merged pull requests, from the
 * locally mirrored pull_request_facts table (populated by the analytics
 * sync from the deployment's connected source control). The durable
 * timestamp-plus-id keyset is reset with the rest of Brain ingestion state,
 * so a recreated corpus is repopulated without making every deploy re-read
 * the full table.
 */
async function syncPullRequestFacts(
  connection: {
    baseUrl: string;
    token: string;
  },
  options: {
    restartFromOverlap: boolean;
  },
): Promise<{ progressed: boolean; interrupted: boolean }> {
  const state = await getBrainSyncState(db, PR_FACTS_COLLECTOR_ID);
  const cursor = getPullRequestFactsResumeCursor(
    state,
    options.restartFromOverlap,
  );

  const facts = await db
    .select({
      id: pullRequestFacts.id,
      repositoryFullName: pullRequestFacts.repositoryFullName,
      prNumber: pullRequestFacts.prNumber,
      title: pullRequestFacts.title,
      htmlUrl: pullRequestFacts.htmlUrl,
      authorLogin: pullRequestFacts.authorLogin,
      state: pullRequestFacts.state,
      createdAtRemote: pullRequestFacts.createdAtRemote,
      closedAtRemote: pullRequestFacts.closedAtRemote,
      mergedAtRemote: pullRequestFacts.mergedAtRemote,
      updatedAt: pullRequestFacts.updatedAt,
    })
    .from(pullRequestFacts)
    .where(
      cursor
        ? cursor.id
          ? or(
              gt(pullRequestFacts.updatedAt, cursor.updatedAt),
              and(
                eq(pullRequestFacts.updatedAt, cursor.updatedAt),
                gt(pullRequestFacts.id, cursor.id),
              ),
            )
          : gte(pullRequestFacts.updatedAt, cursor.updatedAt)
        : undefined,
    )
    .orderBy(pullRequestFacts.updatedAt, pullRequestFacts.id)
    .limit(PR_FACTS_BATCH_SIZE);

  if (facts.length === 0) {
    return { progressed: false, interrupted: false };
  }

  let ingested = 0;

  for (const fact of facts) {
    try {
      await postToBrain(buildPullRequestFactPage(fact), connection);
      ingested++;
    } catch (error) {
      // Leave the watermark unadvanced past this fact; retry next tick.
      console.warn(
        `${LOG_PREFIX} PR fact sync failed for ${fact.repositoryFullName}#${fact.prNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        progressed: false,
        interrupted: isBrainRateLimited(error) || isBrainNotReady(error),
      };
    }
  }

  const last = facts.at(-1)!;
  await upsertBrainSyncState(db, PR_FACTS_COLLECTOR_ID, {
    watermark: last.updatedAt,
    backfillCursor: JSON.stringify({
      updatedAt: last.updatedAt.toISOString(),
      id: last.id,
    } satisfies PullRequestFactsCursor),
  });

  if (ingested > 0) {
    console.log(
      `${LOG_PREFIX} synced ${ingested} pull request facts into the brain`,
    );
  }

  return {
    progressed: facts.length === PR_FACTS_BATCH_SIZE,
    interrupted: false,
  };
}
