import { randomUUID } from 'node:crypto';

import { and, desc, eq, gt, inArray, isNull, lte, ne, sql } from 'drizzle-orm';

import {
  activeRunStatuses,
  getFastAgentParentFromPayload,
  RunStatus,
  type SourceControlProvider,
} from '@roomote/types';

import { db, type DatabaseOrTransaction } from '../db';
import {
  fastAgentMessages,
  prReviewAutoPreferences,
  prReviewEvents,
  prReviewNotificationDeliveries,
  prReviewNotificationUnitEvents,
  prReviewNotificationUnits,
  taskPullRequests,
  taskRuns,
  tasks,
} from '../schema';

const CLAIM_LIMIT = 100;
const DELIVERY_LEASE_MS = 10 * 60 * 1000;
const ROOMOTE_CI_COALESCE_WINDOW_MS = 15 * 60 * 1000;

export type CanonicalPrReviewDeliveryState =
  | 'pending'
  | 'claimed'
  | 'prepared'
  | 'prompt_posting'
  | 'awaiting_user_action'
  | 'auto_dispatch_pending'
  | 'completed'
  | 'suppressed'
  | 'dismissed';

export type CanonicalPrReviewDeliveryClaim = {
  ownershipVersion: 'canonical';
  deliveryId: string;
  notificationUnitId: string;
  destinationKey: string;
  deliveryIds: string[];
  leaseToken: string;
  state: CanonicalPrReviewDeliveryState;
  taskId: string;
  sourceControlProvider: SourceControlProvider;
  host: string | null;
  repositoryId: string | null;
  repository: string;
  prNumber: number;
  prUrl: string;
  batchKind: 'human' | 'roomote';
  batchId: string | null;
  deferrals: number;
  events: Record<string, unknown>[];
  followUpPrompt: string | null;
  targetTaskId: string | null;
  actingUserId: string | null;
  routeProvider: 'slack' | 'teams' | 'telegram' | 'discord' | null;
  routeWorkspaceId: string | null;
  routeChannelId: string | null;
  routeThreadId: string | null;
  providerMessageId: string | null;
  dispatchKey: string;
};

type UnitInput = {
  eventKey: string;
  sourceControlProvider: SourceControlProvider;
  repository: string;
  prNumber: number;
  prUrl: string;
  event: Record<string, unknown>;
  batchKind: 'human' | 'roomote';
  batchId: string | null;
  automatedAuthorId?: string;
  dueAt: Date;
  observedAt: Date;
  reviewHeadSha?: string | null;
  roomoteAuthored?: boolean;
  isSummary?: boolean;
};

type PrLinkIdentity = {
  taskId: string;
  host: string | null;
  repositoryId: string | null;
};

function episodeIdentity(input: UnitInput): {
  kind: 'roomote_cycle' | 'human' | 'automated' | 'ci';
  id: string;
} {
  if (input.roomoteAuthored) {
    return {
      kind: 'roomote_cycle',
      id: input.batchId ?? `event:${input.eventKey}`,
    };
  }
  if (input.automatedAuthorId) {
    return {
      kind: 'automated',
      id: input.batchId ?? `event:${input.eventKey}`,
    };
  }
  if (input.event.kind === 'ci_failure') {
    const providerEventId = input.event.providerEventId;
    return {
      kind: 'ci',
      id: `ci:${typeof providerEventId === 'string' ? providerEventId : input.eventKey}`,
    };
  }
  return {
    kind: 'human',
    id: input.batchId ?? `event:${input.eventKey}`,
  };
}

function canonicalRepositoryIdentity(links: PrLinkIdentity[]): {
  host: string | null;
  repositoryId: string | null;
} {
  const repositoryIds = [
    ...new Set(
      links.flatMap(({ repositoryId }) => (repositoryId ? [repositoryId] : [])),
    ),
  ];
  const hosts = [
    ...new Set(links.flatMap(({ host }) => (host ? [host.toLowerCase()] : []))),
  ];
  return {
    repositoryId: repositoryIds.length === 1 ? repositoryIds[0]! : null,
    host: hosts.length === 1 ? hosts[0]! : null,
  };
}

function repositoryIdentityKey(input: {
  repositoryId?: string | null;
  host?: string | null;
  repository: string;
}): string {
  return input.repositoryId
    ? `id:${input.repositoryId}`
    : `name:${input.host?.toLowerCase() ?? ''}:${input.repository.toLowerCase()}`;
}

function unitIdentityWhere(input: {
  sourceControlProvider: SourceControlProvider;
  repositoryIdentityKey: string;
  prNumber: number;
  headIdentityKey: string;
  episodeKind: 'roomote_cycle' | 'human' | 'automated' | 'ci';
  episodeId: string;
}) {
  return and(
    eq(
      prReviewNotificationUnits.sourceControlProvider,
      input.sourceControlProvider,
    ),
    eq(
      prReviewNotificationUnits.repositoryIdentityKey,
      input.repositoryIdentityKey,
    ),
    eq(prReviewNotificationUnits.prNumber, input.prNumber),
    eq(prReviewNotificationUnits.headIdentityKey, input.headIdentityKey),
    eq(prReviewNotificationUnits.episodeKind, input.episodeKind),
    eq(prReviewNotificationUnits.episodeId, input.episodeId),
  );
}

async function findLatestTaskPayload(
  executor: DatabaseOrTransaction,
  taskId: string,
): Promise<unknown> {
  const run = await executor.query.taskRuns.findFirst({
    where: eq(taskRuns.taskId, taskId),
    orderBy: [desc(taskRuns.createdAt)],
    columns: { payload: true },
  });
  return run?.payload;
}

async function isReusableTaskOwner(
  executor: DatabaseOrTransaction,
  taskId: string,
): Promise<boolean> {
  const task = await executor.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), isNull(tasks.deletedAt)),
    columns: { id: true },
  });
  if (!task) return false;
  const run = await executor.query.taskRuns.findFirst({
    where: eq(taskRuns.taskId, taskId),
    orderBy: [desc(taskRuns.createdAt)],
    columns: {
      status: true,
      snapshotId: true,
      snapshotFailedAt: true,
      canceledAt: true,
    },
  });
  if (!run || run.canceledAt) return false;
  return (
    (activeRunStatuses as readonly RunStatus[]).includes(run.status) ||
    ((run.status === RunStatus.Completed || run.status === RunStatus.Idle) &&
      Boolean(run.snapshotId) &&
      !run.snapshotFailedAt)
  );
}

async function isExistingTaskOwner(
  executor: DatabaseOrTransaction,
  taskId: string,
): Promise<boolean> {
  return Boolean(
    await executor.query.tasks.findFirst({
      where: and(eq(tasks.id, taskId), isNull(tasks.deletedAt)),
      columns: { id: true },
    }),
  );
}

function fastDestination(
  parent: NonNullable<ReturnType<typeof getFastAgentParentFromPayload>>,
) {
  const conversation = parent.conversation;
  const destinationKey = JSON.stringify([
    conversation.surface,
    conversation.workspaceId,
    conversation.conversationId,
  ]);

  if (conversation.surface === 'automation' || conversation.surface === 'web') {
    // Identity-only surfaces have no reply channel; delivery resolves the
    // Fast conversation itself.
    return {
      destinationKey,
      routeProvider: null,
      routeWorkspaceId: conversation.workspaceId,
      routeChannelId: null,
      routeThreadId: null,
    } as const;
  }

  return {
    destinationKey,
    routeProvider: conversation.surface,
    routeWorkspaceId: conversation.workspaceId,
    routeChannelId: conversation.replyTarget.channelId,
    routeThreadId: conversation.replyTarget.threadId ?? null,
  } as const;
}

async function upsertDestinationDelivery(
  executor: DatabaseOrTransaction,
  input: {
    unitId: string;
    dueAt: Date;
    taskId: string;
    destinationKind: 'fast_conversation' | 'task';
    destinationKey: string;
    routeProvider: 'slack' | 'teams' | 'telegram' | 'discord' | null;
    routeWorkspaceId: string | null;
    routeChannelId: string | null;
    routeThreadId: string | null;
    promoteDueAt: boolean;
  },
): Promise<void> {
  const id = randomUUID();
  await executor
    .insert(prReviewNotificationDeliveries)
    .values({
      id,
      notificationUnitId: input.unitId,
      destinationKind: input.destinationKind,
      destinationKey: input.destinationKey,
      taskId: input.taskId,
      dueAt: input.dueAt,
      dispatchKey: `pr-review-delivery:${id}`,
      routeProvider: input.routeProvider,
      routeWorkspaceId: input.routeWorkspaceId,
      routeChannelId: input.routeChannelId,
      routeThreadId: input.routeThreadId,
    })
    .onConflictDoUpdate({
      target: [
        prReviewNotificationDeliveries.notificationUnitId,
        prReviewNotificationDeliveries.destinationKind,
        prReviewNotificationDeliveries.destinationKey,
      ],
      set: {
        dueAt: input.promoteDueAt
          ? sql`least(${prReviewNotificationDeliveries.dueAt}, ${input.dueAt.toISOString()}::timestamp)`
          : sql`greatest(${prReviewNotificationDeliveries.dueAt}, ${input.dueAt.toISOString()}::timestamp)`,
        updatedAt: new Date(),
      },
      setWhere: eq(prReviewNotificationDeliveries.status, 'pending'),
    });
}

async function projectUnitToLinks(
  executor: DatabaseOrTransaction,
  unitId: string,
  dueAt: Date,
  links: PrLinkIdentity[],
  promoteDueAt: boolean,
): Promise<void> {
  for (const link of links) {
    const parent = getFastAgentParentFromPayload(
      await findLatestTaskPayload(executor, link.taskId),
    );
    if (parent) {
      const destination = fastDestination(parent);
      await upsertDestinationDelivery(executor, {
        unitId,
        dueAt,
        taskId: link.taskId,
        destinationKind: 'fast_conversation',
        promoteDueAt,
        ...destination,
      });
      continue;
    }

    await upsertDestinationDelivery(executor, {
      unitId,
      dueAt,
      taskId: link.taskId,
      destinationKind: 'task',
      destinationKey: link.taskId,
      routeProvider: null,
      routeWorkspaceId: null,
      routeChannelId: null,
      routeThreadId: null,
      promoteDueAt,
    });
  }
}

async function matchingOpenRoomoteUnits(
  executor: DatabaseOrTransaction,
  input: UnitInput,
  repositoryKey: string,
) {
  if (!input.reviewHeadSha) return [];
  const start = new Date(
    input.observedAt.getTime() - ROOMOTE_CI_COALESCE_WINDOW_MS,
  );
  const end = new Date(
    input.observedAt.getTime() + ROOMOTE_CI_COALESCE_WINDOW_MS,
  );
  return executor.query.prReviewNotificationUnits.findMany({
    where: and(
      eq(
        prReviewNotificationUnits.sourceControlProvider,
        input.sourceControlProvider,
      ),
      eq(prReviewNotificationUnits.repositoryIdentityKey, repositoryKey),
      eq(prReviewNotificationUnits.prNumber, input.prNumber),
      eq(prReviewNotificationUnits.headSha, input.reviewHeadSha),
      eq(prReviewNotificationUnits.episodeKind, 'roomote_cycle'),
      isNull(prReviewNotificationUnits.sealedAt),
      gt(prReviewNotificationUnits.lastObservedAt, start),
      lte(prReviewNotificationUnits.firstObservedAt, end),
    ),
    columns: { id: true },
  });
}

async function mergeProvisionalCiUnits(
  executor: DatabaseOrTransaction,
  input: UnitInput,
  roomoteUnitId: string,
  repositoryKey: string,
): Promise<void> {
  if (!input.reviewHeadSha) return;
  const roomoteUnits = await matchingOpenRoomoteUnits(
    executor,
    input,
    repositoryKey,
  );
  if (roomoteUnits.length !== 1 || roomoteUnits[0]?.id !== roomoteUnitId) {
    return;
  }

  const start = new Date(
    input.observedAt.getTime() - ROOMOTE_CI_COALESCE_WINDOW_MS,
  );
  const end = new Date(
    input.observedAt.getTime() + ROOMOTE_CI_COALESCE_WINDOW_MS,
  );
  const ciUnits = await executor.query.prReviewNotificationUnits.findMany({
    where: and(
      eq(
        prReviewNotificationUnits.sourceControlProvider,
        input.sourceControlProvider,
      ),
      eq(prReviewNotificationUnits.repositoryIdentityKey, repositoryKey),
      eq(prReviewNotificationUnits.prNumber, input.prNumber),
      eq(prReviewNotificationUnits.headSha, input.reviewHeadSha),
      eq(prReviewNotificationUnits.episodeKind, 'ci'),
      isNull(prReviewNotificationUnits.sealedAt),
      gt(prReviewNotificationUnits.lastObservedAt, start),
      lte(prReviewNotificationUnits.firstObservedAt, end),
    ),
    columns: { id: true },
  });
  if (ciUnits.length === 0) return;

  const ciUnitIds = ciUnits.map(({ id }) => id);
  await executor
    .update(prReviewNotificationUnitEvents)
    .set({ unitId: roomoteUnitId, attachedAt: new Date() })
    .where(inArray(prReviewNotificationUnitEvents.unitId, ciUnitIds));
  await executor
    .delete(prReviewNotificationUnits)
    .where(inArray(prReviewNotificationUnits.id, ciUnitIds));
}

/** Assigns a newly persisted event to its canonical unsealed feedback unit. */
export async function assignPrReviewNotificationUnit(
  executor: DatabaseOrTransaction,
  input: UnitInput,
  eventId: string,
): Promise<{ unitId: string; projectedTaskCount: number }> {
  const links = await executor.query.taskPullRequests.findMany({
    where: and(
      eq(taskPullRequests.sourceControlProvider, input.sourceControlProvider),
      eq(taskPullRequests.repository, input.repository),
      eq(taskPullRequests.prNumber, input.prNumber),
    ),
    columns: { taskId: true, host: true, repositoryId: true },
  });
  const uniqueLinks = [
    ...new Map(links.map((link) => [link.taskId, link])).values(),
  ];
  const repositoryIdentity = canonicalRepositoryIdentity(uniqueLinks);
  const repositoryKey = repositoryIdentityKey({
    ...repositoryIdentity,
    repository: input.repository,
  });
  const headIdentityKey = input.reviewHeadSha ?? '';
  const baseEpisode = episodeIdentity(input);
  const promoteDueAt =
    input.isSummary === true && baseEpisode.kind === 'roomote_cycle';

  let targetUnit = null;
  if (baseEpisode.kind === 'ci') {
    const candidates = await matchingOpenRoomoteUnits(
      executor,
      input,
      repositoryKey,
    );
    targetUnit = candidates.length === 1 ? candidates[0] : null;
  }

  if (!targetUnit) {
    const identity = {
      sourceControlProvider: input.sourceControlProvider,
      prNumber: input.prNumber,
      repositoryIdentityKey: repositoryKey,
      headIdentityKey,
      episodeKind: baseEpisode.kind,
      episodeId: baseEpisode.id,
    };
    const existing = await executor.query.prReviewNotificationUnits.findFirst({
      where: unitIdentityWhere(identity),
      columns: { id: true, sealedAt: true },
    });
    const episodeId = existing?.sealedAt
      ? `${baseEpisode.id}:late:${input.eventKey}`
      : baseEpisode.id;
    const [inserted] = await executor
      .insert(prReviewNotificationUnits)
      .values({
        sourceControlProvider: input.sourceControlProvider,
        repository: input.repository,
        prNumber: input.prNumber,
        prUrl: input.prUrl,
        ...repositoryIdentity,
        repositoryIdentityKey: repositoryKey,
        headSha: input.reviewHeadSha ?? null,
        headIdentityKey,
        episodeKind: baseEpisode.kind,
        episodeId,
        dueAt: input.dueAt,
        firstObservedAt: input.observedAt,
        lastObservedAt: input.observedAt,
      })
      .onConflictDoUpdate({
        target: [
          prReviewNotificationUnits.sourceControlProvider,
          prReviewNotificationUnits.repositoryIdentityKey,
          prReviewNotificationUnits.prNumber,
          prReviewNotificationUnits.headIdentityKey,
          prReviewNotificationUnits.episodeKind,
          prReviewNotificationUnits.episodeId,
        ],
        set: {
          dueAt: promoteDueAt
            ? sql`least(${prReviewNotificationUnits.dueAt}, ${input.dueAt.toISOString()}::timestamp)`
            : sql`greatest(${prReviewNotificationUnits.dueAt}, ${input.dueAt.toISOString()}::timestamp)`,
          lastObservedAt: sql`greatest(${prReviewNotificationUnits.lastObservedAt}, ${input.observedAt.toISOString()}::timestamp)`,
          updatedAt: new Date(),
        },
        setWhere: isNull(prReviewNotificationUnits.sealedAt),
      })
      .returning({ id: prReviewNotificationUnits.id });
    const fallback = inserted
      ? null
      : await executor.query.prReviewNotificationUnits.findFirst({
          where: unitIdentityWhere({ ...identity, episodeId }),
          columns: { id: true, sealedAt: true },
        });
    if (fallback?.sealedAt && episodeId === baseEpisode.id) {
      const lateEpisodeId = `${baseEpisode.id}:late:${input.eventKey}`;
      const [lateUnit] = await executor
        .insert(prReviewNotificationUnits)
        .values({
          sourceControlProvider: input.sourceControlProvider,
          repository: input.repository,
          prNumber: input.prNumber,
          prUrl: input.prUrl,
          ...repositoryIdentity,
          repositoryIdentityKey: repositoryKey,
          headSha: input.reviewHeadSha ?? null,
          headIdentityKey,
          episodeKind: baseEpisode.kind,
          episodeId: lateEpisodeId,
          dueAt: input.dueAt,
          firstObservedAt: input.observedAt,
          lastObservedAt: input.observedAt,
        })
        .onConflictDoNothing()
        .returning({ id: prReviewNotificationUnits.id });
      targetUnit =
        lateUnit ??
        (await executor.query.prReviewNotificationUnits.findFirst({
          where: unitIdentityWhere({
            ...identity,
            episodeId: lateEpisodeId,
          }),
          columns: { id: true },
        }));
    } else {
      targetUnit = inserted ?? fallback;
    }
  }

  if (!targetUnit) {
    throw new Error('Failed to assign canonical PR review notification unit');
  }

  await executor
    .insert(prReviewNotificationUnitEvents)
    .values({ unitId: targetUnit.id, eventId })
    .onConflictDoNothing();

  if (input.isSummary && baseEpisode.kind === 'roomote_cycle') {
    await mergeProvisionalCiUnits(
      executor,
      input,
      targetUnit.id,
      repositoryKey,
    );
  }

  await projectUnitToLinks(
    executor,
    targetUnit.id,
    input.dueAt,
    uniqueLinks,
    promoteDueAt,
  );
  return { unitId: targetUnit.id, projectedTaskCount: uniqueLinks.length };
}

export async function projectPrReviewUnitForAssociation(
  executor: DatabaseOrTransaction,
  input: { taskId: string; eventIds: string[] },
): Promise<void> {
  if (input.eventIds.length === 0) return;
  const rows = await executor
    .select({
      unitId: prReviewNotificationUnitEvents.unitId,
      dueAt: prReviewNotificationUnits.dueAt,
    })
    .from(prReviewNotificationUnitEvents)
    .innerJoin(
      prReviewNotificationUnits,
      eq(prReviewNotificationUnits.id, prReviewNotificationUnitEvents.unitId),
    )
    .where(
      and(
        inArray(prReviewNotificationUnitEvents.eventId, input.eventIds),
        isNull(prReviewNotificationUnits.sealedAt),
      ),
    );
  const units = [...new Map(rows.map((row) => [row.unitId, row])).values()];
  for (const unit of units) {
    await projectUnitToLinks(
      executor,
      unit.unitId,
      unit.dueAt,
      [{ taskId: input.taskId, host: null, repositoryId: null }],
      false,
    );
  }
}

async function resolveDeletedFastOwner(
  executor: DatabaseOrTransaction,
  row: {
    delivery_id: string;
    destination_kind: 'fast_conversation' | 'task';
    destination_key: string;
    task_id: string | null;
    source_control_provider: SourceControlProvider;
    repository: string;
    pr_number: number;
  },
): Promise<string | null> {
  if (row.task_id) {
    const originalIsUsable =
      row.destination_kind === 'fast_conversation'
        ? await isReusableTaskOwner(executor, row.task_id)
        : await isExistingTaskOwner(executor, row.task_id);
    if (originalIsUsable) return row.task_id;
  }
  if (row.destination_kind !== 'fast_conversation') {
    return null;
  }
  const links = await executor.query.taskPullRequests.findMany({
    where: and(
      eq(taskPullRequests.sourceControlProvider, row.source_control_provider),
      eq(taskPullRequests.repository, row.repository),
      eq(taskPullRequests.prNumber, row.pr_number),
    ),
    orderBy: [desc(taskPullRequests.updatedAt)],
    columns: { taskId: true },
  });
  for (const link of links) {
    if (!(await isReusableTaskOwner(executor, link.taskId))) continue;
    const parent = getFastAgentParentFromPayload(
      await findLatestTaskPayload(executor, link.taskId),
    );
    if (
      parent &&
      fastDestination(parent).destinationKey === row.destination_key
    ) {
      await executor
        .update(prReviewNotificationDeliveries)
        .set({ taskId: link.taskId, updatedAt: new Date() })
        .where(eq(prReviewNotificationDeliveries.id, row.delivery_id));
      return link.taskId;
    }
  }
  return null;
}

export async function claimDueCanonicalPrReviewDeliveries(
  now: Date = new Date(),
  scope: { repository?: string } = {},
): Promise<CanonicalPrReviewDeliveryClaim[]> {
  return db.transaction(async (tx) => {
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + DELIVERY_LEASE_MS);
    const rows = await tx.execute<{
      delivery_id: string;
      notification_unit_id: string;
      destination_kind: 'fast_conversation' | 'task';
      destination_key: string;
      task_id: string | null;
      status: CanonicalPrReviewDeliveryState;
      deferrals: number;
      source_control_provider: SourceControlProvider;
      host: string | null;
      repository_id: string | null;
      repository: string;
      pr_number: number;
      pr_url: string;
      episode_kind: 'roomote_cycle' | 'human' | 'automated' | 'ci';
      episode_id: string;
      event: Record<string, unknown>;
      follow_up_prompt: string | null;
      target_task_id: string | null;
      acting_user_id: string | null;
      route_provider: 'slack' | 'teams' | 'telegram' | 'discord' | null;
      route_workspace_id: string | null;
      route_channel_id: string | null;
      route_thread_id: string | null;
      provider_message_id: string | null;
      dispatch_key: string;
    }>(sql`
      with candidates as (
        select d.id
        from ${prReviewNotificationDeliveries} d
        join ${prReviewNotificationUnits} candidate_unit
          on candidate_unit.id = d.notification_unit_id
        where d.due_at <= ${now.toISOString()}::timestamp
          ${scope.repository ? sql`and candidate_unit.repository = ${scope.repository}` : sql``}
          and d.status in ('pending', 'claimed', 'prepared', 'prompt_posting', 'auto_dispatch_pending')
          and (
            d.status = 'pending'
            or d.lease_expires_at is null
            or d.lease_expires_at <= ${now.toISOString()}::timestamp
          )
          and pg_try_advisory_xact_lock(
            hashtextextended(
              concat(
                candidate_unit.source_control_provider,
                ':',
                lower(candidate_unit.repository),
                '#',
                candidate_unit.pr_number::text
              ),
              0
            )
          )
        order by d.due_at, d.created_at
        for update skip locked
        limit ${CLAIM_LIMIT}
      ), updated as (
        update ${prReviewNotificationDeliveries} d
        set status = case when d.status = 'pending' then 'claimed' else d.status end,
            lease_token = ${leaseToken},
            lease_expires_at = ${leaseExpiresAt.toISOString()}::timestamp,
            attempt = d.attempt + 1,
            updated_at = ${now.toISOString()}::timestamp
        from candidates c
        where d.id = c.id
        returning d.*
      ), sealed as (
        update ${prReviewNotificationUnits} u
        set sealed_at = coalesce(u.sealed_at, ${now.toISOString()}::timestamp),
            updated_at = ${now.toISOString()}::timestamp
        from updated d
        where u.id = d.notification_unit_id
        returning u.id
      ), sealed_events as (
        update ${prReviewEvents} e
        set sealed_at = coalesce(e.sealed_at, ${now.toISOString()}::timestamp)
        from updated d
        join ${prReviewNotificationUnitEvents} m
          on m.unit_id = d.notification_unit_id
        where e.id = m.event_id
        returning e.id
      )
      select d.id as delivery_id,
             d.notification_unit_id,
             d.destination_kind,
             d.destination_key,
             d.task_id,
             d.status,
             d.deferrals,
             u.source_control_provider,
             u.host,
             u.repository_id,
             u.repository,
             u.pr_number,
             u.pr_url,
             u.episode_kind,
             u.episode_id,
             e.event,
             d.follow_up_prompt,
             d.target_task_id,
             d.acting_user_id,
             d.route_provider,
             d.route_workspace_id,
             d.route_channel_id,
             d.route_thread_id,
             d.provider_message_id,
             d.dispatch_key
      from updated d
      join ${prReviewNotificationUnits} u on u.id = d.notification_unit_id
      join ${prReviewNotificationUnitEvents} m on m.unit_id = u.id
      join ${prReviewEvents} e on e.id = m.event_id
      where e.superseded = false
      order by d.id, m.attached_at, e.observed_at, e.id
    `);

    const liveDeliveryIds = new Set(rows.map(({ delivery_id }) => delivery_id));
    const leasedDeliveries = await tx
      .select({ id: prReviewNotificationDeliveries.id })
      .from(prReviewNotificationDeliveries)
      .where(eq(prReviewNotificationDeliveries.leaseToken, leaseToken));
    const emptyDeliveryIds = leasedDeliveries
      .map(({ id }) => id)
      .filter((id) => !liveDeliveryIds.has(id));
    if (emptyDeliveryIds.length > 0) {
      await tx
        .update(prReviewNotificationDeliveries)
        .set({
          status: 'suppressed',
          leaseToken: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(inArray(prReviewNotificationDeliveries.id, emptyDeliveryIds));
    }

    const claims = new Map<string, CanonicalPrReviewDeliveryClaim>();
    for (const row of rows) {
      const taskId = await resolveDeletedFastOwner(tx, row);
      if (!taskId) {
        await tx
          .update(prReviewNotificationDeliveries)
          .set({
            status: 'suppressed',
            leaseToken: null,
            leaseExpiresAt: null,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(prReviewNotificationDeliveries.id, row.delivery_id));
        continue;
      }
      const existing = claims.get(row.delivery_id);
      if (existing) {
        existing.events.push(row.event);
        continue;
      }
      const roomote = row.episode_kind === 'roomote_cycle';
      claims.set(row.delivery_id, {
        ownershipVersion: 'canonical',
        deliveryId: row.delivery_id,
        notificationUnitId: row.notification_unit_id,
        destinationKey: row.destination_key,
        deliveryIds: [row.delivery_id],
        leaseToken,
        state: row.status,
        taskId,
        sourceControlProvider: row.source_control_provider,
        host: row.host,
        repositoryId: row.repository_id,
        repository: row.repository,
        prNumber: row.pr_number,
        prUrl: row.pr_url,
        batchKind: roomote ? 'roomote' : 'human',
        batchId: row.episode_id,
        deferrals: row.deferrals,
        events: [row.event],
        followUpPrompt: row.follow_up_prompt,
        targetTaskId: row.target_task_id,
        actingUserId: row.acting_user_id,
        routeProvider: row.route_provider,
        routeWorkspaceId: row.route_workspace_id,
        routeChannelId: row.route_channel_id,
        routeThreadId: row.route_thread_id,
        providerMessageId: row.provider_message_id,
        dispatchKey: row.dispatch_key,
      });
    }
    return [...claims.values()];
  });
}

function canonicalClaimWhere(input: {
  deliveryId: string;
  leaseToken: string;
}) {
  return and(
    eq(prReviewNotificationDeliveries.id, input.deliveryId),
    eq(prReviewNotificationDeliveries.leaseToken, input.leaseToken),
  );
}

export async function renewCanonicalPrReviewDeliveryClaim(input: {
  deliveryId: string;
  leaseToken: string;
}): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(prReviewNotificationDeliveries)
    .set({
      leaseExpiresAt: new Date(now.getTime() + DELIVERY_LEASE_MS),
      updatedAt: now,
    })
    .where(
      and(
        canonicalClaimWhere(input),
        gt(prReviewNotificationDeliveries.leaseExpiresAt, now),
      ),
    )
    .returning({ id: prReviewNotificationDeliveries.id });
  return rows.length === 1;
}

export async function transitionCanonicalPrReviewDelivery(input: {
  deliveryId: string;
  leaseToken: string;
  expected: CanonicalPrReviewDeliveryState | CanonicalPrReviewDeliveryState[];
  status: CanonicalPrReviewDeliveryState;
  values?: Partial<typeof prReviewNotificationDeliveries.$inferInsert>;
  releaseLease?: boolean;
}): Promise<boolean> {
  const expected = Array.isArray(input.expected)
    ? input.expected
    : [input.expected];
  const now = new Date();
  const rows = await db
    .update(prReviewNotificationDeliveries)
    .set({
      ...input.values,
      status: input.status,
      ...(input.releaseLease ? { leaseToken: null, leaseExpiresAt: null } : {}),
      ...(['completed', 'suppressed', 'dismissed'].includes(input.status)
        ? { completedAt: now, leaseToken: null, leaseExpiresAt: null }
        : {}),
      updatedAt: now,
    })
    .where(
      and(
        canonicalClaimWhere(input),
        inArray(prReviewNotificationDeliveries.status, expected),
      ),
    )
    .returning({ id: prReviewNotificationDeliveries.id });
  return rows.length === 1;
}

export async function deferCanonicalPrReviewDelivery(input: {
  deliveryId: string;
  leaseToken: string;
  dueAt: Date;
  incrementDeferrals?: boolean;
}): Promise<void> {
  await db
    .update(prReviewNotificationDeliveries)
    .set({
      status: sql`case when ${prReviewNotificationDeliveries.status} = 'auto_dispatch_pending' then 'auto_dispatch_pending' else 'pending' end`,
      dueAt: input.dueAt,
      ...(input.incrementDeferrals === false
        ? {}
        : {
            deferrals: sql`${prReviewNotificationDeliveries.deferrals} + 1`,
          }),
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(canonicalClaimWhere(input));
}

export async function releaseCanonicalPrReviewDelivery(input: {
  deliveryId: string;
  leaseToken: string;
}): Promise<void> {
  await db
    .update(prReviewNotificationDeliveries)
    .set({
      status: sql`case when ${prReviewNotificationDeliveries.status} = 'auto_dispatch_pending' then 'auto_dispatch_pending' else 'pending' end`,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(canonicalClaimWhere(input));
}

export async function upsertPrReviewAutoPreference(input: {
  sourceControlProvider: SourceControlProvider;
  host?: string | null;
  repositoryId?: string | null;
  repository: string;
  prNumber: number;
  enabledByUserId: string;
  sourceTaskId: string;
  sourceDestinationKey?: string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const link = await tx.query.taskPullRequests.findFirst({
      where: and(
        eq(taskPullRequests.taskId, input.sourceTaskId),
        eq(taskPullRequests.sourceControlProvider, input.sourceControlProvider),
        eq(taskPullRequests.repository, input.repository),
        eq(taskPullRequests.prNumber, input.prNumber),
      ),
      columns: { id: true },
    });
    if (!link) {
      throw new Error(
        `Cannot enable automatic review handling because the linked pull request was not found for task ${input.sourceTaskId}`,
      );
    }

    await tx
      .insert(prReviewAutoPreferences)
      .values({
        sourceControlProvider: input.sourceControlProvider,
        host: input.host ?? null,
        repositoryId: input.repositoryId ?? null,
        repository: input.repository,
        repositoryIdentityKey: repositoryIdentityKey(input),
        prNumber: input.prNumber,
        enabledByUserId: input.enabledByUserId,
        sourceTaskId: input.sourceTaskId,
        sourceDestinationKey: input.sourceDestinationKey ?? null,
      })
      .onConflictDoUpdate({
        target: [
          prReviewAutoPreferences.sourceControlProvider,
          prReviewAutoPreferences.repositoryIdentityKey,
          prReviewAutoPreferences.prNumber,
        ],
        set: {
          enabledByUserId: input.enabledByUserId,
          enabledAt: new Date(),
          sourceTaskId: input.sourceTaskId,
          sourceDestinationKey: input.sourceDestinationKey ?? null,
          updatedAt: new Date(),
        },
      });

    // N-1 compatibility: older workers still resolve the task-link column.
    await tx
      .update(taskPullRequests)
      .set({
        autoHandleFeedbackByUserId: input.enabledByUserId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(taskPullRequests.taskId, input.sourceTaskId),
          eq(
            taskPullRequests.sourceControlProvider,
            input.sourceControlProvider,
          ),
          eq(taskPullRequests.repository, input.repository),
          eq(taskPullRequests.prNumber, input.prNumber),
        ),
      );
  });
}

export async function findPrReviewAutoPreference(input: {
  sourceControlProvider: SourceControlProvider;
  host?: string | null;
  repositoryId?: string | null;
  repository: string;
  prNumber: number;
}): Promise<{
  taskId: string;
  userId: string;
  destinationKey: string | null;
} | null> {
  const preference = await db.query.prReviewAutoPreferences.findFirst({
    where: and(
      eq(
        prReviewAutoPreferences.sourceControlProvider,
        input.sourceControlProvider,
      ),
      input.repositoryId
        ? eq(prReviewAutoPreferences.repositoryId, input.repositoryId)
        : and(
            isNull(prReviewAutoPreferences.repositoryId),
            input.host
              ? eq(prReviewAutoPreferences.host, input.host)
              : isNull(prReviewAutoPreferences.host),
            sql`lower(${prReviewAutoPreferences.repository}) = lower(${input.repository})`,
          ),
      eq(prReviewAutoPreferences.prNumber, input.prNumber),
    ),
    columns: {
      sourceTaskId: true,
      enabledByUserId: true,
      sourceDestinationKey: true,
    },
  });
  if (preference?.sourceTaskId) {
    if (await isReusableTaskOwner(db, preference.sourceTaskId)) {
      return {
        taskId: preference.sourceTaskId,
        userId: preference.enabledByUserId,
        destinationKey: preference.sourceDestinationKey,
      };
    }
  }
  if (preference?.sourceDestinationKey) {
    const links = await db.query.taskPullRequests.findMany({
      where: and(
        eq(taskPullRequests.sourceControlProvider, input.sourceControlProvider),
        eq(taskPullRequests.repository, input.repository),
        eq(taskPullRequests.prNumber, input.prNumber),
      ),
      orderBy: [desc(taskPullRequests.updatedAt)],
      columns: { taskId: true },
    });
    for (const link of links) {
      if (!(await isReusableTaskOwner(db, link.taskId))) continue;
      const parent = getFastAgentParentFromPayload(
        await findLatestTaskPayload(db, link.taskId),
      );
      if (
        parent &&
        fastDestination(parent).destinationKey ===
          preference.sourceDestinationKey
      ) {
        await db
          .update(prReviewAutoPreferences)
          .set({ sourceTaskId: link.taskId, updatedAt: new Date() })
          .where(
            and(
              eq(
                prReviewAutoPreferences.sourceControlProvider,
                input.sourceControlProvider,
              ),
              eq(prReviewAutoPreferences.repository, input.repository),
              eq(prReviewAutoPreferences.prNumber, input.prNumber),
            ),
          );
        return {
          taskId: link.taskId,
          userId: preference.enabledByUserId,
          destinationKey: preference.sourceDestinationKey,
        };
      }
    }
  }
  if (preference) return null;

  // N-1 compatibility: read legacy task-link preferences for one release.
  const legacy = await db.query.taskPullRequests.findFirst({
    where: and(
      eq(taskPullRequests.sourceControlProvider, input.sourceControlProvider),
      eq(taskPullRequests.repository, input.repository),
      eq(taskPullRequests.prNumber, input.prNumber),
      sql`${taskPullRequests.autoHandleFeedbackByUserId} is not null`,
    ),
    orderBy: [desc(taskPullRequests.updatedAt), desc(taskPullRequests.id)],
    columns: { taskId: true, autoHandleFeedbackByUserId: true },
  });
  return legacy?.autoHandleFeedbackByUserId
    ? {
        taskId: legacy.taskId,
        userId: legacy.autoHandleFeedbackByUserId,
        destinationKey: null,
      }
    : null;
}

export async function getCanonicalPrReviewAction(deliveryId: string): Promise<{
  deliveryId: string;
  destinationKind: 'fast_conversation' | 'task';
  status: CanonicalPrReviewDeliveryState;
  provider: 'slack' | 'teams' | 'discord' | 'telegram' | null;
  slackTeamId: string | null;
  taskId: string | null;
  sourceControlProvider: SourceControlProvider;
  host: string | null;
  repositoryId: string | null;
  repository: string;
  prNumber: number;
  prUrl: string;
  channelId: string | null;
  threadId: string | null;
  followUpPrompt: string | null;
  messageId: string | null;
  destinationKey: string;
} | null> {
  const [row] = await db
    .select({
      deliveryId: prReviewNotificationDeliveries.id,
      destinationKind: prReviewNotificationDeliveries.destinationKind,
      status: prReviewNotificationDeliveries.status,
      provider: prReviewNotificationDeliveries.routeProvider,
      slackTeamId: prReviewNotificationDeliveries.routeWorkspaceId,
      taskId: prReviewNotificationDeliveries.taskId,
      sourceControlProvider: prReviewNotificationUnits.sourceControlProvider,
      host: prReviewNotificationUnits.host,
      repositoryId: prReviewNotificationUnits.repositoryId,
      repository: prReviewNotificationUnits.repository,
      prNumber: prReviewNotificationUnits.prNumber,
      prUrl: prReviewNotificationUnits.prUrl,
      channelId: prReviewNotificationDeliveries.routeChannelId,
      threadId: prReviewNotificationDeliveries.routeThreadId,
      followUpPrompt: prReviewNotificationDeliveries.followUpPrompt,
      messageId: prReviewNotificationDeliveries.providerMessageId,
      destinationKey: prReviewNotificationDeliveries.destinationKey,
    })
    .from(prReviewNotificationDeliveries)
    .innerJoin(
      prReviewNotificationUnits,
      eq(
        prReviewNotificationUnits.id,
        prReviewNotificationDeliveries.notificationUnitId,
      ),
    )
    .where(eq(prReviewNotificationDeliveries.id, deliveryId))
    .limit(1);
  return row ?? null;
}

/**
 * Marks the posted canonical action as awaiting the user and retires every
 * older awaiting offer in the same destination conversation, mirroring the
 * legacy Redis path's claim-older-offers-on-attach semantics. Only the newest
 * offer in a conversation stays actionable; earlier ones would otherwise
 * accumulate as a stack of pending cards. Attach and retirement run in one
 * transaction serialized per destination (claims are only serialized per
 * repository/PR, so concurrent attaches into the same conversation would
 * otherwise dismiss each other), and retired offers' cached transcript
 * payloads are dismissed so already-rendered session cards deactivate.
 */
export async function attachCanonicalPrReviewActionMessage(
  deliveryId: string,
  messageId: string,
  leaseToken: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const delivery = await tx.query.prReviewNotificationDeliveries.findFirst({
      where: eq(prReviewNotificationDeliveries.id, deliveryId),
      columns: { destinationKind: true, destinationKey: true },
    });
    if (!delivery) {
      return false;
    }

    const destination =
      delivery.destinationKind && delivery.destinationKey
        ? {
            kind: delivery.destinationKind,
            key: delivery.destinationKey,
          }
        : null;
    if (destination) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`pr-review-destination:${destination.kind}:${destination.key}`}, 0))`,
      );
    }

    const rows = await tx
      .update(prReviewNotificationDeliveries)
      .set({
        providerMessageId: messageId,
        status: 'awaiting_user_action',
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(prReviewNotificationDeliveries.id, deliveryId),
          eq(prReviewNotificationDeliveries.leaseToken, leaseToken),
          eq(prReviewNotificationDeliveries.status, 'prompt_posting'),
        ),
      )
      .returning({ id: prReviewNotificationDeliveries.id });
    if (rows.length !== 1) {
      return false;
    }

    if (!destination) {
      return true;
    }

    const retired = await tx
      .update(prReviewNotificationDeliveries)
      .set({
        status: 'dismissed',
        actionClaimedAt: new Date(),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(prReviewNotificationDeliveries.status, 'awaiting_user_action'),
          eq(prReviewNotificationDeliveries.destinationKind, destination.kind),
          eq(prReviewNotificationDeliveries.destinationKey, destination.key),
          ne(prReviewNotificationDeliveries.id, deliveryId),
        ),
      )
      .returning({ id: prReviewNotificationDeliveries.id });

    if (retired.length > 0) {
      // Session cards render from the cached message payload, so retiring
      // the delivery rows alone would leave the old cards actionable.
      await tx
        .update(fastAgentMessages)
        .set({
          payload: sql`jsonb_set(coalesce(${fastAgentMessages.payload}, '{}'::jsonb), '{prReviewAction,status}', to_jsonb('dismissed'::text), true)`,
          updatedAt: sql`now()`,
        })
        .where(
          inArray(
            sql<string>`${fastAgentMessages.payload} -> 'prReviewAction' ->> 'deliveryId'`,
            retired.map(({ id }) => id),
          ),
        );
    }

    return true;
  });
}

export async function claimCanonicalPrReviewAction(input: {
  deliveryId: string;
  choice: 'yes' | 'auto' | 'dismiss';
  actingUserId?: string;
  expectedSlackTeamId?: string;
  expectedDestinationKind?: 'fast_conversation' | 'task';
  expectedDestinationKey?: string;
}): Promise<Awaited<ReturnType<typeof getCanonicalPrReviewAction>>> {
  return db.transaction(async (tx) => {
    const action = await getCanonicalPrReviewAction(input.deliveryId);
    if (
      !action ||
      action.status !== 'awaiting_user_action' ||
      !action.taskId ||
      !action.followUpPrompt ||
      (input.expectedDestinationKind &&
        action.destinationKind !== input.expectedDestinationKind) ||
      (input.expectedDestinationKey &&
        action.destinationKey !== input.expectedDestinationKey) ||
      (!input.expectedDestinationKey &&
        (!action.provider ||
          action.provider === 'teams' ||
          !action.channelId)) ||
      (input.expectedSlackTeamId &&
        action.provider === 'slack' &&
        action.slackTeamId !== input.expectedSlackTeamId)
    ) {
      return null;
    }
    const status =
      input.choice === 'dismiss' ? 'dismissed' : 'auto_dispatch_pending';
    const claimed = await tx
      .update(prReviewNotificationDeliveries)
      .set({
        status,
        actionClaimedAt: new Date(),
        actingUserId: input.actingUserId ?? null,
        targetTaskId: input.choice === 'dismiss' ? null : action.taskId,
        dueAt: new Date(),
        completedAt: input.choice === 'dismiss' ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(prReviewNotificationDeliveries.id, input.deliveryId),
          eq(prReviewNotificationDeliveries.status, 'awaiting_user_action'),
        ),
      )
      .returning({ id: prReviewNotificationDeliveries.id });
    if (claimed.length === 0) return null;

    if (input.choice === 'auto' && input.actingUserId) {
      await tx
        .insert(prReviewAutoPreferences)
        .values({
          sourceControlProvider: action.sourceControlProvider,
          host: action.host,
          repositoryId: action.repositoryId,
          repository: action.repository,
          repositoryIdentityKey: repositoryIdentityKey(action),
          prNumber: action.prNumber,
          enabledByUserId: input.actingUserId,
          sourceTaskId: action.taskId,
          sourceDestinationKey: action.destinationKey,
        })
        .onConflictDoUpdate({
          target: [
            prReviewAutoPreferences.sourceControlProvider,
            prReviewAutoPreferences.repositoryIdentityKey,
            prReviewAutoPreferences.prNumber,
          ],
          set: {
            enabledByUserId: input.actingUserId,
            enabledAt: new Date(),
            sourceTaskId: action.taskId,
            sourceDestinationKey: action.destinationKey,
            updatedAt: new Date(),
          },
        });
      await tx
        .update(taskPullRequests)
        .set({
          autoHandleFeedbackByUserId: input.actingUserId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(taskPullRequests.taskId, action.taskId),
            eq(
              taskPullRequests.sourceControlProvider,
              action.sourceControlProvider,
            ),
            eq(taskPullRequests.repository, action.repository),
            eq(taskPullRequests.prNumber, action.prNumber),
          ),
        );
    }
    return action;
  });
}

export async function completeCanonicalPrReviewActionDispatch(input: {
  deliveryId: string;
  runId: number;
}): Promise<boolean> {
  const rows = await db
    .update(prReviewNotificationDeliveries)
    .set({
      status: 'completed',
      dispatchedRunId: input.runId,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(prReviewNotificationDeliveries.id, input.deliveryId),
        eq(prReviewNotificationDeliveries.status, 'auto_dispatch_pending'),
      ),
    )
    .returning({ id: prReviewNotificationDeliveries.id });
  return rows.length === 1;
}

export async function releaseCanonicalPrReviewActionDispatch(
  deliveryId: string,
): Promise<boolean> {
  const rows = await db
    .update(prReviewNotificationDeliveries)
    .set({
      status: 'awaiting_user_action',
      actionClaimedAt: null,
      actingUserId: null,
      targetTaskId: null,
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(prReviewNotificationDeliveries.id, deliveryId),
        eq(prReviewNotificationDeliveries.status, 'auto_dispatch_pending'),
        isNull(prReviewNotificationDeliveries.dispatchedRunId),
      ),
    )
    .returning({ id: prReviewNotificationDeliveries.id });
  return rows.length === 1;
}

export async function retireCanonicalPrReviewActionsForDestination(input: {
  provider: 'slack' | 'discord' | 'telegram';
  slackTeamId?: string;
  channelId: string;
  threadId: string | null;
}) {
  const rows = await db
    .update(prReviewNotificationDeliveries)
    .set({
      status: 'dismissed',
      actionClaimedAt: new Date(),
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(prReviewNotificationDeliveries.status, 'awaiting_user_action'),
        eq(prReviewNotificationDeliveries.routeProvider, input.provider),
        input.provider === 'slack' && input.slackTeamId
          ? eq(
              prReviewNotificationDeliveries.routeWorkspaceId,
              input.slackTeamId,
            )
          : undefined,
        eq(prReviewNotificationDeliveries.routeChannelId, input.channelId),
        input.threadId
          ? eq(prReviewNotificationDeliveries.routeThreadId, input.threadId)
          : isNull(prReviewNotificationDeliveries.routeThreadId),
      ),
    )
    .returning({ id: prReviewNotificationDeliveries.id });
  return Promise.all(rows.map(({ id }) => getCanonicalPrReviewAction(id)));
}

export async function retireCanonicalPrReviewActionsForDestinationKey(input: {
  destinationKind: 'fast_conversation' | 'task';
  destinationKey: string;
}) {
  const rows = await db
    .update(prReviewNotificationDeliveries)
    .set({
      status: 'dismissed',
      actionClaimedAt: new Date(),
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(prReviewNotificationDeliveries.status, 'awaiting_user_action'),
        eq(
          prReviewNotificationDeliveries.destinationKind,
          input.destinationKind,
        ),
        eq(prReviewNotificationDeliveries.destinationKey, input.destinationKey),
      ),
    )
    .returning({ id: prReviewNotificationDeliveries.id });
  return rows.map(({ id }) => id);
}
