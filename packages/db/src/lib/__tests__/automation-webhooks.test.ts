import { randomUUID } from 'node:crypto';
import { db } from '../../db';
import { userFactory } from '../../fixtures/factories/user.factory';
import { sessionFactory } from '../../fixtures/factories/session.factory';
import { taskFactory } from '../../fixtures/factories/task.factory';
import { runFactory } from '../../fixtures/factories/run.factory';
import { RunStatus } from '@roomote/types';
import {
  automationWebhookDeliveries as deliveries,
  automationWebhookTriggers as triggers,
  customAutomations,
  mcpConnections,
  users,
  sessions,
  sessionTasks,
  tasks,
  taskRuns,
  fastAgentConversations,
  fastAgentParentEvents,
  automationWebhookDailyBudgets as budgets,
} from '../../schema';
import { eq, inArray } from 'drizzle-orm';
import {
  acceptAutomationWebhookDelivery,
  claimAutomationWebhookDelivery,
  markAutomationWebhookDeliveryRunning,
  reserveWebhookAutomationLaunch,
  retryAutomationWebhookDelivery,
  reconcileExhaustedAutomationWebhookDeliveries,
  reconcileRunningAutomationWebhookDeliveries,
  settleRunningAutomationWebhookDeliveryForSession,
  settleAutomationWebhookDelivery,
  cleanupAutomationWebhookDeliveries,
  flagStalledAutomationWebhookDeliveries,
  AUTOMATION_WEBHOOK_RETENTION_MS,
  AUTOMATION_WEBHOOK_GLOBAL_ACTIVE_CAP,
  AUTOMATION_WEBHOOK_GLOBAL_DAILY_CAP,
} from '../automation-webhooks';
import {
  deleteCustomAutomation,
  tryClaimCustomAutomationLaunch,
} from '../custom-automations';

const automationIds: string[] = [];
const connectionIds: string[] = [];
const sessionIds: string[] = [];
const taskIds: string[] = [];

afterEach(async () => {
  if (taskIds.length)
    await db.delete(tasks).where(inArray(tasks.id, taskIds.splice(0)));
  if (sessionIds.length) {
    await db
      .delete(fastAgentConversations)
      .where(inArray(fastAgentConversations.id, sessionIds));
    await db.delete(sessions).where(inArray(sessions.id, sessionIds.splice(0)));
  }
  await db.delete(budgets);
  if (automationIds.length)
    await db
      .delete(customAutomations)
      .where(inArray(customAutomations.id, automationIds.splice(0)));
  if (connectionIds.length)
    await db
      .delete(mcpConnections)
      .where(inArray(mcpConnections.id, connectionIds.splice(0)));
});

async function fixture(maxRunsPerDay = 20) {
  const [automation] = await db
    .insert(customAutomations)
    .values({
      name: `webhook-${randomUUID()}`,
      prompt: 'Test webhook',
      enabled: true,
    })
    .returning();
  automationIds.push(automation!.id);
  const [connection] = await db
    .insert(mcpConnections)
    .values({ mcpId: `webhook-${randomUUID()}` })
    .returning();
  connectionIds.push(connection!.id);
  const [trigger] = await db
    .insert(triggers)
    .values({
      automationId: automation!.id,
      connectionId: connection!.id,
      enabled: true,
      status: 'active',
      events: ['note.generated'],
      maxRunsPerDay,
    })
    .returning();
  return { automation: automation!, trigger: trigger! };
}

function event(triggerId: string, eventId: string = randomUUID()) {
  return {
    triggerId,
    eventId,
    eventType: 'note.generated',
    noteId: 'note-1',
    occurredAt: new Date(),
  };
}

async function readDelivery(id: string) {
  const [row] = await db.select().from(deliveries).where(eq(deliveries.id, id));
  return row!;
}

describe('automation webhook durable inbox', () => {
  async function runningFixture(
    states: ('active' | 'completed' | 'failed' | 'canceled')[] = [],
    notifyTerminal = true,
  ) {
    const { automation, trigger } = await fixture();
    const session = await sessionFactory.create();
    sessionIds.push(session.id);
    await db.insert(fastAgentConversations).values({
      id: session.id,
      ownerAutomation: 'custom_automation',
      surface: 'automation',
      workspaceId: 'webhook-test',
      conversationId: randomUUID(),
    });
    await acceptAutomationWebhookDelivery(event(trigger.id));
    const claim = (await claimAutomationWebhookDelivery())!;
    await reserveWebhookAutomationLaunch(claim.id, claim.leaseToken);
    await markAutomationWebhookDeliveryRunning(
      claim.id,
      claim.leaseToken,
      session.id,
    );
    const [origin] = await db
      .insert(fastAgentParentEvents)
      .values({
        conversationId: session.id,
        eventKey: randomUUID(),
        parent: {
          sessionId: session.id,
          conversation: {
            surface: 'web',
            workspaceId: 'test',
            conversationId: session.id,
          },
        },
        event: { type: 'automation_triggered', webhookDeliveryId: claim.id },
      })
      .returning();
    const children = [];
    const runs = [];
    for (const state of states) {
      const child = await taskFactory.create({ state });
      taskIds.push(child.id);
      // The task factory may attach a default session; canonical ownership is unique.
      await db.delete(sessionTasks).where(eq(sessionTasks.taskId, child.id));
      await db.insert(sessionTasks).values({
        sessionId: session.id,
        taskId: child.id,
        origin: 'fast_delegation',
      });
      children.push(child);
      const run = await runFactory.create({
        taskId: child.id,
        status:
          state === 'active'
            ? RunStatus.Running
            : state === 'completed'
              ? RunStatus.Completed
              : state === 'failed'
                ? RunStatus.Failed
                : RunStatus.Canceled,
      });
      runs.push(run);
      if (notifyTerminal && state !== 'active') {
        await db.insert(fastAgentParentEvents).values({
          conversationId: session.id,
          eventKey: randomUUID(),
          parent: origin!.parent,
          event: { type: 'task_settled', taskId: child.id, runId: run.id },
          deliveredAt: new Date(),
        });
      }
    }
    return { automation, session, claim, origin: origin!, children, runs };
  }

  it('delivers the initial inbox but retains the fence for every active child and pending followup', async () => {
    const { session, claim, origin, children, automation, runs } =
      await runningFixture(['completed', 'active']);
    expect(
      await settleRunningAutomationWebhookDeliveryForSession(session.id, {
        id: origin.id,
        status: 'delivered',
      }),
    ).toBe(true);
    expect((await readDelivery(claim.id)).status).toBe('running');
    expect(
      (
        await db
          .select()
          .from(customAutomations)
          .where(eq(customAutomations.id, automation.id))
      )[0]?.launchClaimedAt,
    ).not.toBeNull();
    expect(
      (
        await db
          .select()
          .from(fastAgentParentEvents)
          .where(eq(fastAgentParentEvents.id, origin.id))
      )[0]?.deliveredAt,
    ).not.toBeNull();
    const [followup] = await db
      .insert(fastAgentParentEvents)
      .values({
        conversationId: session.id,
        eventKey: randomUUID(),
        parent: origin.parent,
        event: {
          type: 'task_settled',
          taskId: children[1]!.id,
          runId: runs[1]!.id,
        },
        retryAt: new Date(Date.now() + 60000),
      })
      .returning();
    await db
      .update(tasks)
      .set({ state: 'completed' })
      .where(eq(tasks.id, children[1]!.id));
    await db
      .update(taskRuns)
      .set({ status: RunStatus.Completed })
      .where(eq(taskRuns.id, runs[1]!.id));
    expect(await reconcileRunningAutomationWebhookDeliveries()).toBe(0);
    await settleRunningAutomationWebhookDeliveryForSession(session.id, {
      id: followup!.id,
      status: 'delivered',
    });
    expect((await readDelivery(claim.id)).status).toBe('succeeded');
    expect(
      (
        await db
          .select()
          .from(customAutomations)
          .where(eq(customAutomations.id, automation.id))
      )[0]?.launchClaimedAt,
    ).toBeNull();
  });

  it.each(['failed', 'canceled'] as const)(
    'does not hide a %s child behind another completed child',
    async (state) => {
      const { session, claim, origin } = await runningFixture([
        state,
        'completed',
      ]);
      await settleRunningAutomationWebhookDeliveryForSession(session.id, {
        id: origin.id,
        status: 'delivered',
      });
      expect(await readDelivery(claim.id)).toMatchObject({
        status: 'failed',
        lastError: expect.stringContaining(state),
      });
    },
  );

  it('persists permanent failure without releasing capacity until children settle', async () => {
    const { session, claim, origin, children, automation, runs } =
      await runningFixture(['active']);
    await settleRunningAutomationWebhookDeliveryForSession(session.id, {
      id: origin.id,
      status: 'discarded',
      error: 'Permanent Fast failure',
    });
    expect(await readDelivery(claim.id)).toMatchObject({
      status: 'running',
      lastError: 'Permanent Fast failure',
    });
    expect(
      (
        await db
          .select()
          .from(customAutomations)
          .where(eq(customAutomations.id, automation.id))
      )[0]?.launchClaimedAt,
    ).not.toBeNull();
    expect(await claimAutomationWebhookDelivery()).toBeNull();
    await db
      .update(tasks)
      .set({ state: 'completed' })
      .where(eq(tasks.id, children[0]!.id));
    await db
      .update(taskRuns)
      .set({ status: RunStatus.Completed })
      .where(eq(taskRuns.id, runs[0]!.id));
    expect(await reconcileRunningAutomationWebhookDeliveries()).toBe(0);
    await db.insert(fastAgentParentEvents).values({
      conversationId: session.id,
      eventKey: randomUUID(),
      parent: origin.parent,
      event: {
        type: 'task_settled',
        taskId: children[0]!.id,
        runId: runs[0]!.id,
      },
      deliveredAt: new Date(),
    });
    expect(await reconcileRunningAutomationWebhookDeliveries()).toBe(1);
    expect(await readDelivery(claim.id)).toMatchObject({
      status: 'failed',
      lastError: 'Permanent Fast failure',
    });
  });

  it.each(['missing', 'pending'] as const)(
    'keeps an unknown %s origin running',
    async (state) => {
      const { claim, origin } = await runningFixture();
      if (state === 'missing')
        await db
          .delete(fastAgentParentEvents)
          .where(eq(fastAgentParentEvents.id, origin.id));
      expect(await reconcileRunningAutomationWebhookDeliveries()).toBe(0);
      expect((await readDelivery(claim.id)).status).toBe('running');
    },
  );

  it.each(['completed', 'failed', 'canceled'] as const)(
    'retains the fence after a child commits %s, until its notification is admitted and delivered',
    async (state) => {
      const { session, claim, origin, children, runs, automation } =
        await runningFixture([state], false);
      await settleRunningAutomationWebhookDeliveryForSession(session.id, {
        id: origin.id,
        status: 'delivered',
      });
      expect(await reconcileRunningAutomationWebhookDeliveries()).toBe(0);
      expect((await readDelivery(claim.id)).status).toBe('running');
      expect(
        (
          await db
            .select()
            .from(customAutomations)
            .where(eq(customAutomations.id, automation.id))
        )[0]?.launchClaimedAt,
      ).not.toBeNull();
      // Missing notification can become visibly stalled, but is never retried or failed automatically.
      await db
        .update(deliveries)
        .set({ updatedAt: new Date(Date.now() - 3_600_001) })
        .where(eq(deliveries.id, claim.id));
      await flagStalledAutomationWebhookDeliveries();
      expect(await reconcileRunningAutomationWebhookDeliveries()).toBe(0);
      expect((await readDelivery(claim.id)).status).toBe('running');
      const [notification] = await db
        .insert(fastAgentParentEvents)
        .values({
          conversationId: session.id,
          eventKey: randomUUID(),
          parent: origin.parent,
          event: {
            type: 'task_settled',
            taskId: children[0]!.id,
            runId: runs[0]!.id,
          },
        })
        .returning();
      expect(await reconcileRunningAutomationWebhookDeliveries()).toBe(0);
      await settleRunningAutomationWebhookDeliveryForSession(session.id, {
        id: notification!.id,
        status: 'delivered',
      });
      expect((await readDelivery(claim.id)).status).toBe(
        state === 'completed' ? 'succeeded' : 'failed',
      );
    },
  );

  it('keeps a terminal child with no run visibly unknown instead of treating it as completed execution', async () => {
    const { session, claim, origin, children } = await runningFixture([
      'completed',
    ]);
    await db.delete(taskRuns).where(eq(taskRuns.taskId, children[0]!.id));
    await settleRunningAutomationWebhookDeliveryForSession(session.id, {
      id: origin.id,
      status: 'delivered',
    });
    expect(await reconcileRunningAutomationWebhookDeliveries()).toBe(0);
    await db
      .update(deliveries)
      .set({ updatedAt: new Date(Date.now() - 3_600_001) })
      .where(eq(deliveries.id, claim.id));
    expect(await flagStalledAutomationWebhookDeliveries()).toBe(1);
    expect(await readDelivery(claim.id)).toMatchObject({
      status: 'running',
      lastError: expect.stringContaining('Manually inspect'),
    });
  });

  it.each(['delivered', 'discarded'] as const)(
    'requires the latest run identity even with a historical task_settled notification, then accepts %s notification',
    async (status) => {
      const { session, claim, origin, children, runs } = await runningFixture([
        'completed',
      ]);
      const latest = await runFactory.create({
        taskId: children[0]!.id,
        status: RunStatus.Completed,
      });
      await db
        .update(taskRuns)
        .set({ createdAt: runs[0]!.createdAt })
        .where(eq(taskRuns.id, latest.id));
      await settleRunningAutomationWebhookDeliveryForSession(session.id, {
        id: origin.id,
        status: 'delivered',
      });
      expect(await reconcileRunningAutomationWebhookDeliveries()).toBe(0);
      expect((await readDelivery(claim.id)).status).toBe('running');
      // A correct run id attached to a different task is not this child's notification.
      await db.insert(fastAgentParentEvents).values({
        conversationId: session.id,
        eventKey: randomUUID(),
        parent: origin.parent,
        event: {
          type: 'task_settled',
          taskId: 'another-child',
          runId: latest.id,
        },
        deliveredAt: new Date(),
      });
      expect(await reconcileRunningAutomationWebhookDeliveries()).toBe(0);
      const [notification] = await db
        .insert(fastAgentParentEvents)
        .values({
          conversationId: session.id,
          eventKey: randomUUID(),
          parent: origin.parent,
          event: {
            type: 'task_settled',
            taskId: children[0]!.id,
            runId: latest.id,
          },
        })
        .returning();
      await settleRunningAutomationWebhookDeliveryForSession(session.id, {
        id: notification!.id,
        status,
        ...(status === 'discarded' ? { error: 'Notification failed' } : {}),
      });
      expect((await readDelivery(claim.id)).status).toBe(
        status === 'delivered' ? 'succeeded' : 'failed',
      );
    },
  );

  it.each(['delivered', 'discarded'] as const)(
    'accepts %s legacy PR feedback only at or after the latest run creation',
    async (status) => {
      const { session, claim, origin, children, runs } = await runningFixture(
        ['completed'],
        false,
      );
      const [feedback] = await db
        .insert(fastAgentParentEvents)
        .values({
          conversationId: session.id,
          eventKey: randomUUID(),
          parent: origin.parent,
          event: { type: 'pull_request_feedback', taskId: children[0]!.id },
          createdAt: new Date(runs[0]!.createdAt.getTime() - 1000),
          ...(status === 'delivered'
            ? { deliveredAt: new Date() }
            : { discardedAt: new Date(), lastError: 'Feedback failed' }),
        })
        .returning();
      await settleRunningAutomationWebhookDeliveryForSession(session.id, {
        id: origin.id,
        status: 'delivered',
      });
      expect(await reconcileRunningAutomationWebhookDeliveries()).toBe(0);
      expect((await readDelivery(claim.id)).status).toBe('running');
      await db
        .update(fastAgentParentEvents)
        .set({ createdAt: runs[0]!.createdAt })
        .where(eq(fastAgentParentEvents.id, feedback!.id));
      expect(await reconcileRunningAutomationWebhookDeliveries()).toBe(1);
      expect((await readDelivery(claim.id)).status).toBe(
        status === 'delivered' ? 'succeeded' : 'failed',
      );
    },
  );

  it('does not accept recent PR feedback explicitly attributed to an old run', async () => {
    const { session, claim, origin, children, runs } = await runningFixture(
      ['completed'],
      false,
    );
    const latest = await runFactory.create({
      taskId: children[0]!.id,
      status: RunStatus.Completed,
    });
    const [feedback] = await db
      .insert(fastAgentParentEvents)
      .values({
        conversationId: session.id,
        eventKey: randomUUID(),
        parent: origin.parent,
        event: {
          type: 'pull_request_feedback',
          taskId: children[0]!.id,
          runId: runs[0]!.id,
        },
        createdAt: new Date(latest.createdAt.getTime() + 1000),
        deliveredAt: new Date(),
      })
      .returning();
    await settleRunningAutomationWebhookDeliveryForSession(session.id, {
      id: origin.id,
      status: 'delivered',
    });
    expect(await reconcileRunningAutomationWebhookDeliveries()).toBe(0);
    expect((await readDelivery(claim.id)).status).toBe('running');
    await db
      .update(fastAgentParentEvents)
      .set({ event: { ...feedback!.event, runId: latest.id } })
      .where(eq(fastAgentParentEvents.id, feedback!.id));
    expect(await reconcileRunningAutomationWebhookDeliveries()).toBe(1);
    expect((await readDelivery(claim.id)).status).toBe('succeeded');
  });

  it('retains discarded followup failure through a later successful turn, including an empty error', async () => {
    const { session, claim, origin } = await runningFixture();
    const followups = await db
      .insert(fastAgentParentEvents)
      .values(
        ['pr_feedback', 'child_message'].map((type) => ({
          conversationId: session.id,
          eventKey: randomUUID(),
          parent: origin.parent,
          event: { type },
        })),
      )
      .returning();
    await settleRunningAutomationWebhookDeliveryForSession(session.id, {
      id: origin.id,
      status: 'delivered',
    });
    await settleRunningAutomationWebhookDeliveryForSession(session.id, {
      id: followups[0]!.id,
      status: 'discarded',
      error: '',
    });
    expect((await readDelivery(claim.id)).status).toBe('running');
    await settleRunningAutomationWebhookDeliveryForSession(session.id, {
      id: followups[1]!.id,
      status: 'delivered',
    });
    expect(await readDelivery(claim.id)).toMatchObject({
      status: 'failed',
      lastError: 'Fast parent event was discarded.',
    });
  });

  it.each(['delivered', 'discarded'] as const)(
    'repairs a crash after %s origin using only durable state, once',
    async (status) => {
      const { claim, origin, session } = await runningFixture(['completed']);
      await db
        .update(fastAgentParentEvents)
        .set(
          status === 'delivered'
            ? { deliveredAt: new Date(), lastError: 'old transient error' }
            : { discardedAt: new Date(), lastError: 'permanent failure' },
        )
        .where(eq(fastAgentParentEvents.id, origin.id));
      const before = await db
        .select()
        .from(fastAgentParentEvents)
        .where(eq(fastAgentParentEvents.conversationId, session.id));
      const results = await Promise.all([
        reconcileRunningAutomationWebhookDeliveries(),
        reconcileRunningAutomationWebhookDeliveries(),
      ]);
      expect(results.reduce((a, b) => a + b, 0)).toBe(1);
      expect((await readDelivery(claim.id)).status).toBe(
        status === 'delivered' ? 'succeeded' : 'failed',
      );
      expect(
        await db
          .select()
          .from(fastAgentParentEvents)
          .where(eq(fastAgentParentEvents.conversationId, session.id)),
      ).toEqual(before);
    },
  );

  it('accepts text approval identities, nulls deleted approvers and protects subscription removal', async () => {
    const { automation, trigger } = await fixture();
    const userId = `webhook-user-${randomUUID()}`;
    await userFactory.create({ id: userId });
    try {
      await db
        .update(triggers)
        .set({ approvedByUserId: userId })
        .where(eq(triggers.id, trigger.id));
      await expect(deleteCustomAutomation(automation.id)).rejects.toThrow(
        'Remove the automation webhook subscription',
      );
      await expect(
        db
          .delete(mcpConnections)
          .where(eq(mcpConnections.id, trigger.connectionId)),
      ).rejects.toThrow();
      await db.delete(users).where(eq(users.id, userId));
      const [saved] = await db
        .select()
        .from(triggers)
        .where(eq(triggers.id, trigger.id));
      expect(saved?.approvedByUserId).toBeNull();
      await db.delete(triggers).where(eq(triggers.id, trigger.id));
      await expect(
        deleteCustomAutomation(automation.id),
      ).resolves.toBeUndefined();
    } finally {
      await db.delete(users).where(eq(users.id, userId));
    }
  });

  it('caps concurrent reservations across many automations, including reserved pending retries', async () => {
    const fixtures = await Promise.all(
      Array.from({ length: 8 }, () => fixture()),
    );
    for (const { trigger } of fixtures)
      await acceptAutomationWebhookDelivery(event(trigger.id));
    const claims = [];
    for (let i = 0; i < fixtures.length; i++)
      claims.push((await claimAutomationWebhookDelivery())!);
    const results = await Promise.all(
      claims.map((claim) =>
        reserveWebhookAutomationLaunch(claim.id, claim.leaseToken),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(
      AUTOMATION_WEBHOOK_GLOBAL_ACTIVE_CAP,
    );
    const index = results.findIndex(Boolean);
    const reserved = claims[index]!;
    await retryAutomationWebhookDelivery(
      reserved.id,
      reserved.leaseToken,
      'busy',
      true,
    );
    const rejected = claims[results.findIndex((value) => !value)]!;
    expect(
      await reserveWebhookAutomationLaunch(rejected.id, rejected.leaseToken),
    ).toBeNull();
    await db
      .update(deliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(deliveries.id, reserved.id));
    const retry = (await claimAutomationWebhookDelivery())!;
    expect(retry.id).toBe(reserved.id);
    expect(
      await reserveWebhookAutomationLaunch(retry.id, retry.leaseToken),
    ).toEqual(results[index]);
    const [budget] = await db.select().from(budgets);
    expect(budget?.reservations).toBe(AUTOMATION_WEBHOOK_GLOBAL_ACTIVE_CAP);
  });

  it('serializes the last daily slot and preserves spend across trigger deletion/recreation', async () => {
    const day = new Date().toISOString().slice(0, 10);
    await db
      .insert(budgets)
      .values({ day, reservations: AUTOMATION_WEBHOOK_GLOBAL_DAILY_CAP - 1 });
    const fixtures = await Promise.all(
      Array.from({ length: 6 }, () => fixture()),
    );
    for (const { trigger } of fixtures)
      await acceptAutomationWebhookDelivery(event(trigger.id));
    const claims = [];
    for (let i = 0; i < fixtures.length; i++)
      claims.push((await claimAutomationWebhookDelivery())!);
    const results = await Promise.all(
      claims.map((claim) =>
        reserveWebhookAutomationLaunch(claim.id, claim.leaseToken),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const charged = claims[results.findIndex(Boolean)]!;
    // Raw fixture deletion is intentionally still possible; it must not refund spend.
    await db
      .delete(customAutomations)
      .where(eq(customAutomations.id, charged.automationId));
    const fresh = await fixture();
    await acceptAutomationWebhookDelivery(event(fresh.trigger.id));
    const next = (await claimAutomationWebhookDelivery())!;
    expect(
      await reserveWebhookAutomationLaunch(next.id, next.leaseToken),
    ).toBeNull();
    expect((await db.select().from(budgets))[0]?.reservations).toBe(
      AUTOMATION_WEBHOOK_GLOBAL_DAILY_CAP,
    );
  });

  it('cleans terminal metadata in batches but retains recent settlement and all live work', async () => {
    const { trigger } = await fixture();
    const old = new Date(Date.now() - AUTOMATION_WEBHOOK_RETENTION_MS - 60_000);
    await db.insert(deliveries).values(
      Array.from({ length: 1001 }, (_, i) => ({
        ...event(trigger.id),
        status: i % 2 ? ('failed' as const) : ('succeeded' as const),
        occurredAt: old,
        createdAt: old,
        updatedAt: old,
      })),
    );
    const [recent] = await db
      .insert(deliveries)
      .values({ ...event(trigger.id), status: 'succeeded', createdAt: old })
      .returning();
    const live = await db
      .insert(deliveries)
      .values(
        (['pending', 'dispatching', 'running'] as const).map((status) => ({
          ...event(trigger.id),
          status,
          createdAt: old,
          updatedAt: old,
        })),
      )
      .returning();
    expect(await cleanupAutomationWebhookDeliveries()).toBe(1000);
    expect(await cleanupAutomationWebhookDeliveries()).toBe(1);
    expect(await cleanupAutomationWebhookDeliveries()).toBe(0);
    expect(await readDelivery(recent!.id)).toBeDefined();
    for (const row of live)
      expect((await readDelivery(row.id)).status).toBe(row.status);
    expect(
      await acceptAutomationWebhookDelivery({
        ...event(trigger.id),
        occurredAt: old,
      }),
    ).toBe('ignored');
    expect(
      await acceptAutomationWebhookDelivery({
        ...event(trigger.id, live[0]!.eventId),
        occurredAt: old,
      }),
    ).toBe('duplicate');
  });

  it('flags stalled running work once without failing, exhausting or replaying it', async () => {
    const { trigger } = await fixture();
    const [running] = await db
      .insert(deliveries)
      .values({
        ...event(trigger.id),
        status: 'running',
        sessionId: randomUUID(),
        attempts: 1,
        launchClaimedAt: new Date(0),
        updatedAt: new Date(Date.now() - 3_600_001),
      })
      .returning();
    expect(await flagStalledAutomationWebhookDeliveries()).toBe(1);
    expect(await flagStalledAutomationWebhookDeliveries()).toBe(0);
    expect(await readDelivery(running!.id)).toMatchObject({
      status: 'running',
      attempts: 1,
      sessionId: running!.sessionId,
      lastError: expect.stringContaining('outcome unknown'),
    });
    expect(await claimAutomationWebhookDelivery()).toBeNull();
    expect(await reconcileExhaustedAutomationWebhookDeliveries()).toBe(0);
  });

  it('rejects new deliveries when the automation is disabled while retaining deduplication', async () => {
    const { automation, trigger } = await fixture();
    const input = event(trigger.id);
    expect(await acceptAutomationWebhookDelivery(input)).toBe('accepted');
    await db
      .update(customAutomations)
      .set({ enabled: false })
      .where(eq(customAutomations.id, automation.id));
    expect(await acceptAutomationWebhookDelivery(input)).toBe('duplicate');
    expect(await acceptAutomationWebhookDelivery(event(trigger.id))).toBe(
      'ignored',
    );
  });
  it('deduplicates concurrent deliveries before capacity and disabled checks', async () => {
    const { trigger } = await fixture();
    const input = event(trigger.id);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => acceptAutomationWebhookDelivery(input)),
    );
    expect(results.filter((result) => result === 'accepted')).toHaveLength(1);
    expect(results.filter((result) => result === 'duplicate')).toHaveLength(11);
    await db
      .update(triggers)
      .set({ enabled: false })
      .where(eq(triggers.id, trigger.id));
    expect(await acceptAutomationWebhookDelivery(input)).toBe('duplicate');
    expect(await acceptAutomationWebhookDelivery(event(trigger.id))).toBe(
      'ignored',
    );
    expect(await claimAutomationWebhookDelivery()).toBeNull();
  });

  it.each(['pending', 'error', 'deleting'] as const)(
    'retries %s management windows before evaluating intermediate filters',
    async (status) => {
      const { automation, trigger } = await fixture();
      const input = event(trigger.id);
      expect(await acceptAutomationWebhookDelivery(input)).toBe('accepted');
      await db
        .update(triggers)
        .set({ status, enabled: false, events: [] })
        .where(eq(triggers.id, trigger.id));
      await db
        .update(customAutomations)
        .set({ enabled: false })
        .where(eq(customAutomations.id, automation.id));
      expect(await acceptAutomationWebhookDelivery(input)).toBe('duplicate');
      const retry = { ...event(trigger.id), occurredAt: new Date(0) };
      expect(await acceptAutomationWebhookDelivery(retry)).toBe('capacity');
      expect(
        await db
          .select()
          .from(deliveries)
          .where(eq(deliveries.eventId, retry.eventId)),
      ).toEqual([]);
    },
  );

  it('ignores configured-out events under lock but deduplicates previously accepted events', async () => {
    const { trigger } = await fixture();
    const input = event(trigger.id);
    expect(await acceptAutomationWebhookDelivery(input)).toBe('accepted');
    await db
      .update(triggers)
      .set({ events: ['note.edited'] })
      .where(eq(triggers.id, trigger.id));
    expect(await acceptAutomationWebhookDelivery(input)).toBe('duplicate');
    const excluded = event(trigger.id);
    expect(await acceptAutomationWebhookDelivery(excluded)).toBe('ignored');
    expect(
      await db
        .select()
        .from(deliveries)
        .where(eq(deliveries.eventId, excluded.eventId)),
    ).toEqual([]);
    expect(
      await acceptAutomationWebhookDelivery({
        ...event(trigger.id),
        eventType: 'note.edited',
      }),
    ).toBe('accepted');
    await db
      .update(triggers)
      .set({ events: [] })
      .where(eq(triggers.id, trigger.id));
    expect(
      await acceptAutomationWebhookDelivery({
        ...event(trigger.id),
        eventType: 'note.edited',
      }),
    ).toBe('ignored');
  });

  it.each([
    { label: 'ancient', offset: -AUTOMATION_WEBHOOK_RETENTION_MS - 1 },
    { label: 'future', offset: 5 * 60 * 1000 + 1 },
    { label: 'invalid', offset: Number.NaN },
  ])(
    'ignores $label occurrence times after deduplication',
    async ({ offset }) => {
      const { trigger } = await fixture();
      const input = event(trigger.id);
      expect(await acceptAutomationWebhookDelivery(input)).toBe('accepted');
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const occurredAt = new Date(now + offset);
        expect(
          await acceptAutomationWebhookDelivery({ ...input, occurredAt }),
        ).toBe('duplicate');
        const excluded = { ...event(trigger.id), occurredAt };
        expect(await acceptAutomationWebhookDelivery(excluded)).toBe('ignored');
        expect(
          await db
            .select()
            .from(deliveries)
            .where(eq(deliveries.eventId, excluded.eventId)),
        ).toEqual([]);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each([-AUTOMATION_WEBHOOK_RETENTION_MS, -60 * 60 * 1000, 5 * 60 * 1000])(
    'accepts occurrence time within retention/future boundaries (%s ms)',
    async (offset) => {
      const { trigger } = await fixture();
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        expect(
          await acceptAutomationWebhookDelivery({
            ...event(trigger.id),
            occurredAt: new Date(now + offset),
          }),
        ).toBe('accepted');
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('ignores a trigger that no longer exists without storing a delivery', async () => {
    const input = event(randomUUID());
    expect(await acceptAutomationWebhookDelivery(input)).toBe('ignored');
    expect(
      await db
        .select()
        .from(deliveries)
        .where(eq(deliveries.eventId, input.eventId)),
    ).toEqual([]);
  });

  it('bounds the outstanding backlog at 100 under concurrent admission', async () => {
    const { trigger } = await fixture();
    await db
      .insert(deliveries)
      .values(Array.from({ length: 99 }, () => event(trigger.id)));
    const inputs = Array.from({ length: 8 }, () => event(trigger.id));
    const results = await Promise.all(
      inputs.map(acceptAutomationWebhookDelivery),
    );
    expect(results.filter((result) => result === 'accepted')).toHaveLength(1);
    expect(results.filter((result) => result === 'capacity')).toHaveLength(7);
    expect(
      await acceptAutomationWebhookDelivery(
        inputs[results.indexOf('accepted')]!,
      ),
    ).toBe('duplicate');
  });

  it('serializes claims per trigger, fences expired workers and never reclaims running', async () => {
    const { trigger } = await fixture();
    await acceptAutomationWebhookDelivery(event(trigger.id));
    await acceptAutomationWebhookDelivery(event(trigger.id));
    const claims = (
      await Promise.all(
        Array.from({ length: 8 }, () => claimAutomationWebhookDelivery()),
      )
    ).filter((value) => value !== null);
    expect(claims).toHaveLength(1);
    const first = claims[0]!;
    await db
      .update(deliveries)
      .set({ leaseUntil: new Date(0) })
      .where(eq(deliveries.id, first.id));
    expect(
      await markAutomationWebhookDeliveryRunning(
        first.id,
        first.leaseToken,
        randomUUID(),
      ),
    ).toBe(false);
    const second = await claimAutomationWebhookDelivery();
    expect(second?.id).toBe(first.id);
    expect(second?.leaseToken).not.toBe(first.leaseToken);
    expect(
      await retryAutomationWebhookDelivery(first.id, first.leaseToken, 'stale'),
    ).toBe(false);
    expect(
      await markAutomationWebhookDeliveryRunning(
        second!.id,
        second!.leaseToken,
        randomUUID(),
      ),
    ).toBe(true);
    await db
      .update(deliveries)
      .set({ leaseUntil: new Date(0) })
      .where(eq(deliveries.id, first.id));
    expect(await claimAutomationWebhookDelivery()).toBeNull();
  });

  it('preserves occurrence identity on retry, charges daily quota once, and blocks scheduled takeover', async () => {
    const { automation, trigger } = await fixture(1);
    await acceptAutomationWebhookDelivery(event(trigger.id));
    await acceptAutomationWebhookDelivery(event(trigger.id));
    const first = (await claimAutomationWebhookDelivery())!;
    const occurrence = await reserveWebhookAutomationLaunch(
      first.id,
      first.leaseToken,
    );
    expect(occurrence).toBeInstanceOf(Date);
    expect(
      await retryAutomationWebhookDelivery(
        first.id,
        first.leaseToken,
        'try again',
      ),
    ).toBe(true);
    expect(await claimAutomationWebhookDelivery()).toBeNull();
    await db
      .update(deliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(deliveries.id, first.id));
    const retry = (await claimAutomationWebhookDelivery())!;
    expect(retry.id).toBe(first.id);
    expect(
      await reserveWebhookAutomationLaunch(retry.id, retry.leaseToken),
    ).toEqual(occurrence);
    expect((await readDelivery(first.id)).firstDispatchedAt).toEqual(
      occurrence,
    );
    // Even a stale automation claim cannot bypass the durable inbox ownership.
    await db
      .update(customAutomations)
      .set({ launchClaimedAt: new Date(0) })
      .where(eq(customAutomations.id, automation.id));
    expect(
      await tryClaimCustomAutomationLaunch(automation.id, null),
    ).toBeNull();
    expect(await settleAutomationWebhookDelivery(first.id, 'succeeded')).toBe(
      true,
    );
    expect(await claimAutomationWebhookDelivery()).toBeNull();
    await db
      .update(deliveries)
      .set({ firstDispatchedAt: new Date(0) })
      .where(eq(deliveries.id, first.id));
    expect(await claimAutomationWebhookDelivery()).not.toBeNull();
  });

  it('does not steal scheduled launch claims and refunds busy attempts', async () => {
    const { automation, trigger } = await fixture();
    expect(
      await tryClaimCustomAutomationLaunch(automation.id, null),
    ).toBeInstanceOf(Date);
    await acceptAutomationWebhookDelivery(event(trigger.id));
    const claim = (await claimAutomationWebhookDelivery())!;
    expect(
      await reserveWebhookAutomationLaunch(claim.id, claim.leaseToken),
    ).toBeNull();
    expect(
      await retryAutomationWebhookDelivery(
        claim.id,
        claim.leaseToken,
        'busy',
        true,
      ),
    ).toBe(true);
    expect(await readDelivery(claim.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      launchClaimedAt: null,
      firstDispatchedAt: null,
    });
    expect(await claimAutomationWebhookDelivery()).toBeNull();
  });

  it('fails exhausted retries and releases the reserved automation fence atomically', async () => {
    const { trigger, automation } = await fixture();
    await acceptAutomationWebhookDelivery(event(trigger.id));
    const claim = (await claimAutomationWebhookDelivery())!;
    await db
      .update(deliveries)
      .set({ attempts: 5 })
      .where(eq(deliveries.id, claim.id));
    expect(
      await retryAutomationWebhookDelivery(claim.id, claim.leaseToken, 'bad'),
    ).toBe(true);
    expect((await readDelivery(claim.id)).status).toBe('failed');
    await acceptAutomationWebhookDelivery(event(trigger.id));
    const reserved = (await claimAutomationWebhookDelivery())!;
    await reserveWebhookAutomationLaunch(reserved.id, reserved.leaseToken);
    await db
      .update(deliveries)
      .set({ attempts: 5 })
      .where(eq(deliveries.id, reserved.id));
    await retryAutomationWebhookDelivery(
      reserved.id,
      reserved.leaseToken,
      'uncertain',
    );
    expect((await readDelivery(reserved.id)).status).toBe('failed');
    const [released] = await db
      .select()
      .from(customAutomations)
      .where(eq(customAutomations.id, automation.id));
    expect(released).toMatchObject({
      launchClaimedAt: null,
      lastError: 'uncertain',
    });
    expect(await claimAutomationWebhookDelivery()).toBeNull();
    expect(
      await settleAutomationWebhookDelivery(reserved.id, 'succeeded'),
    ).toBe(false);
    expect(
      await markAutomationWebhookDeliveryRunning(
        reserved.id,
        reserved.leaseToken,
        randomUUID(),
      ),
    ).toBe(false);
  });

  it('reconciles crashed final attempts once and rejects stale running writers', async () => {
    const { trigger, automation } = await fixture();
    await acceptAutomationWebhookDelivery(event(trigger.id));
    const claim = (await claimAutomationWebhookDelivery())!;
    await reserveWebhookAutomationLaunch(claim.id, claim.leaseToken);
    await db
      .update(deliveries)
      .set({ attempts: 5, leaseUntil: new Date(0) })
      .where(eq(deliveries.id, claim.id));
    const results = await Promise.all([
      reconcileExhaustedAutomationWebhookDeliveries(),
      reconcileExhaustedAutomationWebhookDeliveries(),
    ]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect((await readDelivery(claim.id)).status).toBe('failed');
    const [released] = await db
      .select()
      .from(customAutomations)
      .where(eq(customAutomations.id, automation.id));
    expect(released?.launchClaimedAt).toBeNull();
    expect(
      await db.transaction((tx) =>
        markAutomationWebhookDeliveryRunning(
          claim.id,
          claim.leaseToken,
          randomUUID(),
          tx,
        ),
      ),
    ).toBe(false);
    await acceptAutomationWebhookDelivery(event(trigger.id));
    expect(await claimAutomationWebhookDelivery()).not.toBeNull();
  });

  it('preserves newer automation fences and excludes committed running transitions from reconciliation', async () => {
    const { trigger, automation } = await fixture();
    await acceptAutomationWebhookDelivery(event(trigger.id));
    const claim = (await claimAutomationWebhookDelivery())!;
    await reserveWebhookAutomationLaunch(claim.id, claim.leaseToken);
    const newer = new Date(Date.now() + 60_000);
    await db
      .update(customAutomations)
      .set({ launchClaimedAt: newer })
      .where(eq(customAutomations.id, automation.id));
    await db
      .update(deliveries)
      .set({ attempts: 5, leaseUntil: new Date(0) })
      .where(eq(deliveries.id, claim.id));
    expect(await reconcileExhaustedAutomationWebhookDeliveries()).toBe(1);
    const [preserved] = await db
      .select()
      .from(customAutomations)
      .where(eq(customAutomations.id, automation.id));
    expect(preserved?.launchClaimedAt).toEqual(newer);
    await acceptAutomationWebhookDelivery(event(trigger.id));
    const running = (await claimAutomationWebhookDelivery())!;
    await db.transaction(async (tx) => {
      expect(
        await markAutomationWebhookDeliveryRunning(
          running.id,
          running.leaseToken,
          randomUUID(),
          tx,
        ),
      ).toBe(true);
    });
    await db
      .update(deliveries)
      .set({ attempts: 5, leaseUntil: new Date(0) })
      .where(eq(deliveries.id, running.id));
    expect(await reconcileExhaustedAutomationWebhookDeliveries()).toBe(0);
    expect((await readDelivery(running.id)).status).toBe('running');
  });

  it('settles early or late idempotently, including a reserved pending retry, inside a caller transaction', async () => {
    const { trigger } = await fixture();
    await acceptAutomationWebhookDelivery(event(trigger.id));
    const claim = (await claimAutomationWebhookDelivery())!;
    await reserveWebhookAutomationLaunch(claim.id, claim.leaseToken);
    await retryAutomationWebhookDelivery(
      claim.id,
      claim.leaseToken,
      'ambiguous launch',
    );
    await db.transaction(async (tx) => {
      expect(
        await settleAutomationWebhookDelivery(claim.id, 'succeeded', null, tx),
      ).toBe(true);
    });
    expect(await settleAutomationWebhookDelivery(claim.id, 'succeeded')).toBe(
      true,
    );
    expect(
      await settleAutomationWebhookDelivery(claim.id, 'failed', 'late'),
    ).toBe(false);
    expect(
      await markAutomationWebhookDeliveryRunning(
        claim.id,
        claim.leaseToken,
        randomUUID(),
      ),
    ).toBe(false);
    expect(await readDelivery(claim.id)).toMatchObject({
      status: 'succeeded',
      lastError: null,
      leaseToken: null,
    });
  });

  it('rechecks disabled state and daily quota at launch reservation', async () => {
    const { trigger, automation } = await fixture();
    await acceptAutomationWebhookDelivery(event(trigger.id));
    const claim = (await claimAutomationWebhookDelivery())!;
    await db
      .update(triggers)
      .set({ enabled: false })
      .where(eq(triggers.id, trigger.id));
    expect(
      await reserveWebhookAutomationLaunch(claim.id, claim.leaseToken),
    ).toBeNull();
    await db
      .update(triggers)
      .set({ enabled: true, maxRunsPerDay: 0 })
      .where(eq(triggers.id, trigger.id));
    expect(
      await reserveWebhookAutomationLaunch(claim.id, claim.leaseToken),
    ).toBeNull();
    expect((await readDelivery(claim.id)).firstDispatchedAt).toBeNull();
    await db
      .update(triggers)
      .set({ maxRunsPerDay: 20 })
      .where(eq(triggers.id, trigger.id));
    await db
      .update(customAutomations)
      .set({ enabled: false })
      .where(eq(customAutomations.id, automation.id));
    expect(
      await reserveWebhookAutomationLaunch(claim.id, claim.leaseToken),
    ).toBeNull();
  });
});
