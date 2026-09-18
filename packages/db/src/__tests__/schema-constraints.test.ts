/**
 * Real-database coverage for the schema-hardening constraints: the durable
 * task/run classification CHECKs, the provider-scoped webhook delivery key,
 * and the host-aware repository uniqueness. Runs against the real test
 * database so Postgres parses every identifier and enforces the constraints
 * (mocked-db tests cannot prove any of this).
 *
 * The classification loops iterate the exported vocabulary constants from
 * @roomote/types, so adding a value to a constant without extending the
 * matching CHECK constraint (schema.ts + migration) fails here.
 */
import { randomUUID } from 'node:crypto';

import {
  TASK_WORKFLOWS,
  TASK_SURFACES,
  TASK_TRIGGERS,
  TASK_VISIBILITIES,
  TASK_STATES,
  COMMIT_AUTHOR_KINDS,
  RUN_KINDS,
  codingHarnesses,
  requestedWorkKinds,
  requestedWorkKindSources,
  type CodingHarness,
  type RunKind,
} from '@roomote/types';

import {
  db,
  fastAgentConversations,
  inArray,
  repositories,
  repositoryFactory,
  runFactory,
  sessionFactory,
  sessionParticipants,
  sessions,
  sessionTasks,
  taskFactory,
  tasks,
  userFactory,
  users,
  webhooks,
} from '../server';

const createdTaskIds: string[] = [];
const createdUserIds: string[] = [];
const createdRepositoryIds: string[] = [];
const createdWebhookIds: string[] = [];
const createdSessionIds: string[] = [];

afterAll(async () => {
  if (createdWebhookIds.length > 0) {
    await db.delete(webhooks).where(inArray(webhooks.id, createdWebhookIds));
  }

  if (createdRepositoryIds.length > 0) {
    await db
      .delete(repositories)
      .where(inArray(repositories.id, createdRepositoryIds));
  }

  if (createdSessionIds.length > 0) {
    await db.delete(sessions).where(inArray(sessions.id, createdSessionIds));
  }

  if (createdTaskIds.length > 0) {
    // task_runs cascade from tasks.
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }

  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

async function createTask(overrides: Parameters<typeof taskFactory.create>[0]) {
  const task = await taskFactory.create(overrides);
  createdTaskIds.push(task.id);
  return task;
}

async function createSession(
  overrides: Parameters<typeof sessionFactory.create>[0],
) {
  const session = await sessionFactory.create(overrides);
  createdSessionIds.push(session.id);
  return session;
}

/**
 * Asserts the promise rejects with a Postgres violation of the named
 * constraint. Drizzle wraps driver errors in DrizzleQueryError, so the
 * constraint name lives on the cause chain rather than the top-level message.
 */
async function expectConstraintViolation(
  promise: Promise<unknown>,
  constraintName: string,
): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error(
        `Expected a rejection violating "${constraintName}", but the query succeeded`,
      );
    },
    (caught: unknown) => caught,
  );

  const details: string[] = [];
  let current: unknown = error;

  while (current instanceof Error) {
    details.push(current.message);

    const pgError = current as { constraint_name?: unknown };
    if (typeof pgError.constraint_name === 'string') {
      details.push(pgError.constraint_name);
    }

    current = current.cause;
  }

  expect(details.join('\n')).toContain(constraintName);
}

describe('tasks classification CHECK constraints', () => {
  it('accepts every value of every classification vocabulary', async () => {
    for (const workflow of TASK_WORKFLOWS) {
      await createTask({ workflow });
    }

    for (const surface of TASK_SURFACES) {
      await createTask({ surface });
    }

    for (const trigger of TASK_TRIGGERS) {
      await createTask({ trigger });
    }

    for (const visibility of TASK_VISIBILITIES) {
      await createTask({ visibility });
    }

    for (const state of TASK_STATES) {
      await createTask({ state });
    }

    for (const harness of codingHarnesses) {
      await createTask({ harness });
    }

    for (const requestedWorkKind of requestedWorkKinds) {
      await createTask({ requestedWorkKind });
    }

    for (const requestedWorkKindSource of requestedWorkKindSources) {
      await createTask({ requestedWorkKindSource });
    }

    for (const commitAuthorKind of COMMIT_AUTHOR_KINDS) {
      await createTask({ commitAuthorKind });
    }
  });

  it.each([
    ['workflow', 'tasks_workflow_check'],
    ['surface', 'tasks_surface_check'],
    ['trigger', 'tasks_trigger_check'],
    ['visibility', 'tasks_visibility_check'],
    ['state', 'tasks_state_check'],
    ['harness', 'tasks_harness_check'],
    ['requestedWorkKind', 'tasks_requested_work_kind_check'],
    ['requestedWorkKindSource', 'tasks_requested_work_kind_source_check'],
    ['commitAuthorKind', 'tasks_commit_author_kind_check'],
  ] as const)(
    'rejects an unknown %s value via %s',
    async (field, constraintName) => {
      const overrides = {
        [field]: 'not-a-real-vocabulary-value',
      } as unknown as Parameters<typeof taskFactory.create>[0];

      await expectConstraintViolation(createTask(overrides), constraintName);
    },
  );
});

describe('sessions CHECK and uniqueness constraints', () => {
  it.each([
    ['ownerKind', 'sessions_owner_kind_check'],
    ['sourceSurface', 'sessions_source_surface_check'],
    ['sourceTrigger', 'sessions_source_trigger_check'],
    ['visibility', 'sessions_visibility_check'],
    ['cachedStatus', 'sessions_cached_status_check'],
  ] as const)(
    'rejects an unknown %s value via %s',
    async (field, constraintName) => {
      const overrides = {
        [field]: 'not-a-real-vocabulary-value',
      } as unknown as Parameters<typeof sessionFactory.create>[0];

      await expectConstraintViolation(createSession(overrides), constraintName);
    },
  );

  it('enforces the owner shape', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);

    await expectConstraintViolation(
      createSession({ ownerKind: 'system', ownerUserId: user.id }),
      'sessions_owner_shape_check',
    );
  });

  it('allows only one canonical session per task', async () => {
    const task = await createTask({});
    const first = await createSession({});
    const second = await createSession({});

    await db.insert(sessionTasks).values({
      sessionId: first.id,
      taskId: task.id,
      origin: 'direct_launch',
    });
    await expectConstraintViolation(
      db.insert(sessionTasks).values({
        sessionId: second.id,
        taskId: task.id,
        origin: 'follow_up',
      }),
      'session_tasks_task_id_unique',
    );
  });

  it('rejects unknown task-link origins', async () => {
    const task = await createTask({});
    const session = await createSession({});

    await expectConstraintViolation(
      db.insert(sessionTasks).values({
        sessionId: session.id,
        taskId: task.id,
        origin: 'not-a-real-origin' as 'direct_launch',
      }),
      'session_tasks_origin_check',
    );
  });

  it('allows only one participant row per session and user', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);
    const session = await createSession({});

    await db.insert(sessionParticipants).values({
      sessionId: session.id,
      userId: user.id,
      role: 'member',
    });
    await expectConstraintViolation(
      db.insert(sessionParticipants).values({
        sessionId: session.id,
        userId: user.id,
        role: 'owner',
      }),
      'session_participants_session_user_unique',
    );
  });

  it('rejects unknown participant roles', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);
    const session = await createSession({});

    await expectConstraintViolation(
      db.insert(sessionParticipants).values({
        sessionId: session.id,
        userId: user.id,
        role: 'not-a-real-role' as 'member',
      }),
      'session_participants_role_check',
    );
  });

  it('allows only one session per Fast conversation', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: `workspace-${randomUUID()}`,
        conversationId: `conversation-${randomUUID()}`,
      })
      .returning();

    await createSession({ fastConversationId: conversation!.id });
    await expectConstraintViolation(
      createSession({ fastConversationId: conversation!.id }),
      'sessions_fast_conversation_id_unique',
    );
  });
});

describe('Fast conversation owner constraints', () => {
  it('requires exactly one user or automation owner', async () => {
    await expectConstraintViolation(
      db.insert(fastAgentConversations).values({
        userId: null,
        ownerAutomation: null,
        surface: 'automation',
        workspaceId: randomUUID(),
        conversationId: randomUUID(),
      }),
      'fast_agent_conversations_owner_shape_check',
    );

    const user = await userFactory.create();
    createdUserIds.push(user.id);
    await expectConstraintViolation(
      db.insert(fastAgentConversations).values({
        userId: user.id,
        ownerAutomation: 'custom_automation',
        surface: 'automation',
        workspaceId: randomUUID(),
        conversationId: randomUUID(),
      }),
      'fast_agent_conversations_owner_shape_check',
    );
  });
});

describe('task_runs classification CHECK constraints', () => {
  it('accepts every run kind and harness', async () => {
    for (const kind of RUN_KINDS) {
      const task = await createTask({});
      await runFactory.create({ kind, taskId: task.id });
    }

    for (const harness of codingHarnesses) {
      const task = await createTask({});
      await runFactory.create({ harness, taskId: task.id });
    }
  });

  it('rejects unknown run kinds and harnesses', async () => {
    const task = await createTask({});

    await expectConstraintViolation(
      runFactory.create({ kind: 'bogus' as RunKind, taskId: task.id }),
      'task_runs_kind_check',
    );

    await expectConstraintViolation(
      runFactory.create({
        harness: 'bogus' as CodingHarness,
        taskId: task.id,
      }),
      'task_runs_harness_check',
    );
  });
});

describe('webhooks provider-scoped delivery ids', () => {
  async function insertWebhook(provider: string, deliveryId: string) {
    const [row] = await db
      .insert(webhooks)
      .values({ provider, deliveryId, event: 'test.event', payload: {} })
      .returning({ id: webhooks.id });

    if (row) {
      createdWebhookIds.push(row.id);
    }

    return row;
  }

  it('allows the same delivery id on different providers', async () => {
    const deliveryId = `delivery-${randomUUID()}`;

    await expect(insertWebhook('github', deliveryId)).resolves.toBeDefined();
    await expect(insertWebhook('linear', deliveryId)).resolves.toBeDefined();
  });

  it('rejects a duplicate (provider, delivery id) pair', async () => {
    const deliveryId = `delivery-${randomUUID()}`;

    await insertWebhook('github', deliveryId);
    await expectConstraintViolation(
      insertWebhook('github', deliveryId),
      'webhooks_provider_delivery_id_unique',
    );
  });

  it('dedupes via untargeted ON CONFLICT DO NOTHING like recordWebhook', async () => {
    const deliveryId = `delivery-${randomUUID()}`;
    await insertWebhook('gitlab', deliveryId);

    const conflicted = await db
      .insert(webhooks)
      .values({
        provider: 'gitlab',
        deliveryId,
        event: 'test.event',
        payload: {},
      })
      .onConflictDoNothing()
      .returning({ id: webhooks.id });

    expect(conflicted).toEqual([]);
  });
});

describe('repositories host-aware uniqueness', () => {
  async function createGitLabRepository(overrides: {
    linkedByUserId: string;
    fullName: string;
    externalRepoId: string;
    host: string | null;
  }) {
    const repository = await repositoryFactory.create({
      sourceControlProvider: 'gitlab',
      ...overrides,
    });
    createdRepositoryIds.push(repository.id);
    return repository;
  }

  it('scopes fullName and externalRepoId collisions to the host', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);

    const fullName = `group/app-${randomUUID()}`;
    const externalRepoId = `${Date.now()}`;

    // Identical fullName AND externalRepoId on two self-managed hosts: legal.
    await createGitLabRepository({
      linkedByUserId: user.id,
      fullName,
      externalRepoId,
      host: 'gitlab.alpha.example.com',
    });
    await createGitLabRepository({
      linkedByUserId: user.id,
      fullName,
      externalRepoId,
      host: 'gitlab.beta.example.com',
    });

    // Same host + fullName: still rejected.
    await expectConstraintViolation(
      createGitLabRepository({
        linkedByUserId: user.id,
        fullName,
        externalRepoId: `${externalRepoId}-other`,
        host: 'gitlab.alpha.example.com',
      }),
      'repositories_provider_host_full_name_unique',
    );

    // Same host + externalRepoId: still rejected.
    await expectConstraintViolation(
      createGitLabRepository({
        linkedByUserId: user.id,
        fullName: `${fullName}-other`,
        externalRepoId,
        host: 'gitlab.alpha.example.com',
      }),
      'repositories_provider_host_external_repo_unique',
    );
  });

  it('keeps un-backfilled NULL-host rows colliding with each other', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);

    const fullName = `group/legacy-${randomUUID()}`;

    await createGitLabRepository({
      linkedByUserId: user.id,
      fullName,
      externalRepoId: `${Date.now()}`,
      host: null,
    });

    // NULL hosts are coalesced to '' inside the unique index, so a second
    // NULL-host row with the same fullName must fail exactly like it did
    // before host joined the key.
    await expectConstraintViolation(
      createGitLabRepository({
        linkedByUserId: user.id,
        fullName,
        externalRepoId: `${Date.now()}-other`,
        host: null,
      }),
      'repositories_provider_host_full_name_unique',
    );
  });
});
