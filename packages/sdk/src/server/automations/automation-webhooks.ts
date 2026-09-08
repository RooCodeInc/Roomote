import { decrypt } from '@roomote/db/encryption';
import {
  and,
  automationWebhookDeliveries as deliveries,
  automationWebhookTriggers as triggers,
  customAutomations,
  db,
  desc,
  eq,
  inArray,
  isNull,
  mcpConnections,
  recordCustomAutomationRunOutcome,
  users,
} from '@roomote/db/server';
import { Env, areCuratedIntegrationsDisabled } from '@roomote/env';
import {
  automationWebhookConfigSchema,
  isMcpConnectionGranolaConfig,
} from '@roomote/types';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

const endpointSchema = z.object({
  id: z.string().regex(/^whe_[a-zA-Z0-9]{14}$/u),
  url: z.string(),
  enabled: z.boolean(),
  signing_secret: z
    .string()
    .regex(/^whsec_[A-Za-z0-9+/]+=*$/u)
    .optional(),
});
const OPERATION_LEASE_MS = 120_000;
type Trigger = typeof triggers.$inferSelect;

async function requireAutomation(
  actorUserId: string,
  automationId: string,
  admin = false,
) {
  if (!z.string().uuid().safeParse(automationId).success) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Invalid automation ID.',
    });
  }
  const actor = await db.query.users.findFirst({
    where: and(eq(users.id, actorUserId), isNull(users.deletedAt)),
  });
  const automation = await db.query.customAutomations.findFirst({
    where: eq(customAutomations.id, automationId),
  });
  if (
    !actor ||
    (admin && actor.role !== 'admin') ||
    (actor.role !== 'admin' && automation?.createdByUserId !== actor.id)
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: admin
        ? 'An admin must approve and manage shared Granola webhook bindings.'
        : 'You cannot manage this automation.',
    });
  }
  if (!automation)
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Automation not found.',
    });
  return automation;
}

async function connection(id?: string) {
  if (areCuratedIntegrationsDisabled(Env.R_CURATED_INTEGRATIONS_DISABLED)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Curated integrations are disabled.',
    });
  }
  const row = await db.query.mcpConnections.findFirst({
    where: and(
      id ? eq(mcpConnections.id, id) : undefined,
      eq(mcpConnections.mcpId, 'granola'),
      eq(mcpConnections.connectionRole, 'default'),
      isNull(mcpConnections.userId),
      eq(mcpConnections.enabled, true),
      eq(mcpConnections.authStatus, 'authenticated'),
    ),
  });
  if (!row || !isMcpConnectionGranolaConfig(row.authConfig)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'Connect an authenticated shared Granola API key in Settings > Integrations first.',
    });
  }
  return row;
}

async function granolaRequest(
  connectionId: string,
  path: string,
  method = 'GET',
  body?: unknown,
) {
  const row = await connection(connectionId);
  if (!isMcpConnectionGranolaConfig(row.authConfig))
    throw new Error('Invalid Granola configuration.');
  let apiKey: string;
  try {
    apiKey = decrypt(row.authConfig.encryptedApiKey).trim();
  } catch {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'The stored Granola credential cannot be read. Reconnect Granola.',
    });
  }
  if (!apiKey)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Granola API key is missing.',
    });
  let response: Response;
  try {
    response = await fetch(`https://public-api.granola.ai${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
  } catch {
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message:
        'Granola request did not complete. Retry to reconcile the subscription before creating another.',
    });
  }
  // Never persist upstream response bodies: they may contain meeting data or credentials.
  if (method === 'PATCH' && response.status === 404) return null;
  if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: `Granola returned HTTP ${response.status}. Check API key permissions, plan eligibility, and subscription ownership, then retry.`,
    });
  }
  if (method === 'DELETE') return null;
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: 'Granola returned an invalid response.',
    });
  }
}

function callbackUrl(triggerId: string) {
  const url = new URL(
    `/api/webhooks/automations/${triggerId}`,
    Env.R_PUBLIC_URL ?? Env.R_APP_URL,
  );
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'Configure a publicly reachable HTTPS Roomote URL before registering webhooks.',
    });
  }
  return url.toString();
}

export async function getAutomationWebhook(
  actorUserId: string,
  automationId: string,
) {
  await requireAutomation(actorUserId, automationId);
  const row = await db.query.automationWebhookTriggers.findFirst({
    where: eq(triggers.automationId, automationId),
  });
  if (!row) return null;
  const history = await db
    .select({
      id: deliveries.id,
      eventType: deliveries.eventType,
      noteId: deliveries.noteId,
      status: deliveries.status,
      attempts: deliveries.attempts,
      lastError: deliveries.lastError,
      createdAt: deliveries.createdAt,
      updatedAt: deliveries.updatedAt,
      sessionId: deliveries.sessionId,
    })
    .from(deliveries)
    .where(eq(deliveries.triggerId, row.id))
    .orderBy(desc(deliveries.createdAt))
    .limit(50);
  return {
    id: row.id,
    automationId: row.automationId,
    provider: 'granola' as const,
    enabled: row.enabled,
    status: row.status,
    providerEndpointId: row.providerEndpointId,
    events: row.events,
    folderIds: row.folderIds,
    scopes: row.scopes,
    maxRunsPerDay: row.maxRunsPerDay,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deliveries: history.map(({ sessionId, ...delivery }) => ({
      ...delivery,
      sessionId,
      canRetry: delivery.status === 'failed' && sessionId === null,
    })),
  };
}

/** Fail closed locally before remote mutation; expired operations are reconciled on retry. */
async function claimManagement(
  automationId: string,
  actorUserId: string,
  mode: 'pending' | 'deleting',
  connectionId?: string,
) {
  return db.transaction(async (tx) => {
    const [automation] = await tx
      .select()
      .from(customAutomations)
      .where(eq(customAutomations.id, automationId))
      .for('update');
    if (!automation)
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Automation not found.',
      });
    let [row] = await tx
      .select()
      .from(triggers)
      .where(eq(triggers.automationId, automationId))
      .for('update');
    if (!row && mode === 'deleting') return null;
    if (
      row &&
      ['pending', 'deleting'].includes(row.status) &&
      Date.now() - row.updatedAt.getTime() < OPERATION_LEASE_MS
    ) {
      throw new TRPCError({
        code: 'CONFLICT',
        message:
          'Subscription management is in progress. Retry after two minutes if it was interrupted.',
      });
    }
    if (row && mode === 'deleting') {
      const [live] = await tx
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(
          and(
            eq(deliveries.triggerId, row.id),
            inArray(deliveries.status, ['dispatching', 'running']),
          ),
        )
        .limit(1);
      if (live)
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            'Pause the trigger and wait for active execution to settle before removing it. Unknown outcomes require inspection, not replay.',
        });
      // A pending dispatch retry may still reserve the automation. No Fast
      // inbox exists yet, so removing the binding must release that reservation.
      const pending = await tx
        .select({ launchClaimedAt: deliveries.launchClaimedAt })
        .from(deliveries)
        .where(
          and(
            eq(deliveries.triggerId, row.id),
            eq(deliveries.status, 'pending'),
          ),
        );
      for (const delivery of pending) {
        if (delivery.launchClaimedAt)
          await recordCustomAutomationRunOutcome(tx, {
            id: automationId,
            status: 'failed',
            error: 'Webhook subscription removed before dispatch.',
            launchClaimedAt: delivery.launchClaimedAt,
          });
      }
    }
    const now = new Date();
    if (row) {
      [row] = await tx
        .update(triggers)
        .set({ enabled: false, status: mode, updatedAt: now, lastError: null })
        .where(eq(triggers.id, row.id))
        .returning();
    } else {
      if (!connectionId) throw new Error('Granola connection is required.');
      [row] = await tx
        .insert(triggers)
        .values({
          automationId,
          connectionId,
          approvedByUserId: actorUserId,
          status: mode,
          updatedAt: now,
        })
        .returning();
    }
    return row!;
  });
}

async function failManagement(row: Trigger, error: unknown) {
  const message =
    error instanceof TRPCError
      ? error.message
      : 'Subscription update failed. Retry to reconcile its remote state.';
  await db
    .update(triggers)
    .set({
      enabled: false,
      status: 'error',
      lastError: message,
      updatedAt: new Date(),
    })
    .where(and(eq(triggers.id, row.id), eq(triggers.updatedAt, row.updatedAt)));
}

async function removeRemoteEndpoints(row: Trigger) {
  if (row.providerEndpointId) {
    const id = z
      .string()
      .regex(/^whe_[a-zA-Z0-9]{14}$/u)
      .parse(row.providerEndpointId);
    await granolaRequest(
      row.connectionId,
      `/v1/webhook-endpoints/${id}`,
      'DELETE',
    );
  }
  // A lost create response cannot recover the one-time secret. Find only our exact
  // callback, remove that orphan, then create anew on the next configure operation.
  const response = z
    .object({
      webhook_endpoints: z.array(endpointSchema).max(1000),
      has_more: z.literal(false).optional(),
      hasMore: z.literal(false).optional(),
      next_cursor: z.null().optional(),
      nextCursor: z.null().optional(),
    })
    .safeParse(await granolaRequest(row.connectionId, '/v1/webhook-endpoints'));
  if (!response.success)
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: 'Could not verify Granola subscription cleanup.',
    });
  for (const endpoint of response.data.webhook_endpoints) {
    if (
      new URL(endpoint.url).pathname.replace(/\/+$/u, '') ===
        `/api/webhooks/automations/${row.id}` &&
      endpoint.id !== row.providerEndpointId
    ) {
      await granolaRequest(
        row.connectionId,
        `/v1/webhook-endpoints/${endpoint.id}`,
        'DELETE',
      );
    }
  }
}

export async function configureAutomationWebhook(
  actorUserId: string,
  automationId: string,
  input: z.input<typeof automationWebhookConfigSchema>,
) {
  const automation = await requireAutomation(actorUserId, automationId, true);
  const config = automationWebhookConfigSchema.parse(input);
  if (
    !automation.createdByUserId ||
    !(await db.query.users.findFirst({
      where: and(
        eq(users.id, automation.createdByUserId),
        isNull(users.deletedAt),
      ),
    }))
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'The automation needs an active owner before binding a shared connection.',
    });
  }
  const current = await db.query.automationWebhookTriggers.findFirst({
    where: eq(triggers.automationId, automationId),
  });
  const conn = await connection(current?.connectionId);
  // Reject missing public configuration before persisting any operation.
  callbackUrl(current?.id ?? automationId);
  let row = await claimManagement(
    automationId,
    actorUserId,
    'pending',
    conn.id,
  );
  if (!row) throw new Error('Could not claim subscription management.');
  try {
    const payload = {
      url: callbackUrl(row.id),
      events: [...new Set(config.events)],
      scopes: [...new Set(config.scopes)],
      folder_ids: [...new Set(config.folderIds)],
    };
    let endpointId = row.providerEndpointId;
    let secret = row.encryptedSigningSecret;
    if (endpointId && secret) {
      const id = z
        .string()
        .regex(/^whe_[a-zA-Z0-9]{14}$/u)
        .parse(endpointId);
      const response = await granolaRequest(
        row.connectionId,
        `/v1/webhook-endpoints/${id}`,
        'PATCH',
        { ...payload, enabled: config.enabled },
      );
      const parsed = endpointSchema.safeParse(response);
      if (response === null) {
        endpointId = null;
        secret = null;
      } else {
        if (
          !parsed.success ||
          parsed.data.id !== id ||
          parsed.data.enabled !== config.enabled
        )
          throw new TRPCError({
            code: 'BAD_GATEWAY',
            message: 'Granola did not confirm the subscription update.',
          });
      }
    }
    if (!endpointId || !secret) {
      await removeRemoteEndpoints(row);
      const parsed = endpointSchema.safeParse(
        await granolaRequest(
          row.connectionId,
          '/v1/webhook-endpoints',
          'POST',
          {
            ...payload,
            ...(payload.folder_ids.length ? {} : { folder_ids: undefined }),
          },
        ),
      );
      if (!parsed.success || !parsed.data.signing_secret)
        throw new TRPCError({
          code: 'BAD_GATEWAY',
          message:
            'Granola did not return a signing secret. Retry to reconcile the subscription.',
        });
      endpointId = parsed.data.id;
      secret = parsed.data.signing_secret;
      // Persist the one-time secret before any further network request. If the
      // response itself is lost, the exact callback cleanup above repairs it.
      const [checkpoint] = await db
        .update(triggers)
        .set({
          providerEndpointId: endpointId,
          encryptedSigningSecret: secret,
          updatedAt: new Date(),
        })
        .where(
          and(eq(triggers.id, row.id), eq(triggers.updatedAt, row.updatedAt)),
        )
        .returning();
      if (!checkpoint)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Subscription changed during setup. Inspect and retry.',
        });
      row = checkpoint;
      if (!config.enabled)
        await granolaRequest(
          row.connectionId,
          `/v1/webhook-endpoints/${endpointId}`,
          'PATCH',
          { enabled: false },
        );
    }
    await requireAutomation(actorUserId, automationId, true);
    const [saved] = await db
      .update(triggers)
      .set({
        providerEndpointId: endpointId,
        encryptedSigningSecret: secret,
        enabled: config.enabled,
        status: 'active',
        events: payload.events,
        folderIds: payload.folder_ids,
        scopes: payload.scopes,
        maxRunsPerDay: config.maxRunsPerDay,
        approvedByUserId: actorUserId,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(triggers.id, row.id), eq(triggers.updatedAt, row.updatedAt)),
      )
      .returning({ id: triggers.id });
    if (!saved)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Subscription changed during setup. Inspect and retry.',
      });
    return await getAutomationWebhook(actorUserId, automationId);
  } catch (error) {
    await failManagement(row, error);
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message:
        'Subscription setup failed. Retry to reconcile its remote state.',
    });
  }
}

export async function removeAutomationWebhook(
  actorUserId: string,
  automationId: string,
  forceLocalRemoval = false,
) {
  await requireAutomation(actorUserId, automationId, true);
  const row = await claimManagement(automationId, actorUserId, 'deleting');
  if (!row) return { removed: true };
  try {
    if (!forceLocalRemoval) await removeRemoteEndpoints(row);
    const removed = await db
      .delete(triggers)
      .where(
        and(eq(triggers.id, row.id), eq(triggers.updatedAt, row.updatedAt)),
      )
      .returning({ id: triggers.id });
    if (!removed.length)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Subscription changed during removal. Inspect and retry.',
      });
    return {
      removed: true,
      ...(forceLocalRemoval
        ? {
            remoteCleanupRequired: {
              providerEndpointId: row.providerEndpointId,
              callbackUrl: new URL(
                `/api/webhooks/automations/${row.id}`,
                Env.R_PUBLIC_URL ?? Env.R_APP_URL,
              ).toString(),
            },
          }
        : {}),
    };
  } catch (error) {
    await failManagement(row, error);
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message:
        'Subscription removal failed. The local trigger is paused; retry removal after restoring provider access.',
    });
  }
}

export async function retryAutomationWebhookDelivery(
  actorUserId: string,
  automationId: string,
  deliveryId: string,
) {
  await requireAutomation(actorUserId, automationId);
  if (!z.string().uuid().safeParse(deliveryId).success)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Invalid delivery ID.',
    });
  const trigger = await db.query.automationWebhookTriggers.findFirst({
    where: eq(triggers.automationId, automationId),
  });
  if (!trigger)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Webhook not found.' });
  await assertWebhookTriggerAuthorized(trigger.id);
  // Running/previously executed work must never be replayed by this control.
  const rows = await db
    .update(deliveries)
    .set({
      status: 'pending',
      attempts: 0,
      launchClaimedAt: null,
      leaseToken: null,
      leaseUntil: null,
      nextAttemptAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deliveries.id, deliveryId),
        eq(deliveries.triggerId, trigger.id),
        eq(deliveries.status, 'failed'),
        isNull(deliveries.sessionId),
      ),
    )
    .returning({ id: deliveries.id });
  if (!rows.length)
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        'Only failed deliveries that never started execution can be retried.',
    });
  return { outcome: 'queued' as const };
}

export async function assertWebhookTriggerAuthorized(
  triggerId: string,
): Promise<void> {
  const row = await db.query.automationWebhookTriggers.findFirst({
    where: eq(triggers.id, triggerId),
  });
  if (!row?.enabled || row.status !== 'active' || !row.approvedByUserId)
    throw new Error('Webhook is paused or lacks admin approval.');
  const approver = await db.query.users.findFirst({
    where: and(
      eq(users.id, row.approvedByUserId),
      eq(users.role, 'admin'),
      isNull(users.deletedAt),
    ),
  });
  if (!approver)
    throw new Error(
      'Webhook shared connection approval is no longer valid. An admin must approve it again.',
    );
  const automation = await db.query.customAutomations.findFirst({
    where: eq(customAutomations.id, row.automationId),
  });
  if (!automation?.enabled || !automation.createdByUserId)
    throw new Error('Webhook automation is disabled or has no owner.');
  await requireAutomation(automation.createdByUserId, automation.id);
  await connection(row.connectionId);
}

export async function loadGranolaWebhookNote(
  triggerId: string,
  noteId: string,
): Promise<string> {
  if (!/^not_[a-zA-Z0-9]{14}$/u.test(noteId))
    throw new Error('Invalid Granola note ID.');
  await assertWebhookTriggerAuthorized(triggerId);
  const row = await db.query.automationWebhookTriggers.findFirst({
    where: eq(triggers.id, triggerId),
  });
  if (!row) throw new Error('Webhook no longer exists.');
  const parsed = z
    .object({
      id: z.literal(noteId),
      title: z.string().nullable().optional(),
      summary_text: z.string(),
      summary_markdown: z.string().nullable().optional(),
    })
    .safeParse(await granolaRequest(row.connectionId, `/v1/notes/${noteId}`));
  if (!parsed.success) throw new Error('Granola note summary is unavailable.');
  return JSON.stringify({
    note_id: noteId,
    title: parsed.data.title?.slice(0, 500),
    summary: (parsed.data.summary_markdown ?? parsed.data.summary_text).slice(
      0,
      45_000,
    ),
  });
}
