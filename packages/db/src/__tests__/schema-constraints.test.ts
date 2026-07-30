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
  eq,
  getMondayAgentInstallationSecrets,
  inArray,
  mcpConnections,
  mondayAgentInstallations,
  repositories,
  repositoryFactory,
  runFactory,
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

afterAll(async () => {
  if (createdWebhookIds.length > 0) {
    await db.delete(webhooks).where(inArray(webhooks.id, createdWebhookIds));
  }

  if (createdRepositoryIds.length > 0) {
    await db
      .delete(repositories)
      .where(inArray(repositories.id, createdRepositoryIds));
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

describe('monday.com external-agent installation constraints', () => {
  it('encrypts credentials, enforces one installation, and restricts owner deletion', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);
    const [connection] = await db
      .insert(mcpConnections)
      .values({
        userId: user.id,
        mcpId: 'monday',
        connectionRole: 'default',
        enabled: true,
        authStatus: 'authenticated',
        accessToken: 'owner-token',
      })
      .returning();
    if (!connection) throw new Error('Failed to create test MCP connection');

    const [installation] = await db
      .insert(mondayAgentInstallations)
      .values({
        accountId: `account-${randomUUID()}`,
        agentId: `agent-${randomUUID()}`,
        ownerMcpConnectionId: connection.id,
        agentApiToken: 'agent-api-token',
        signingSecret: 'agent-signing-secret',
      })
      .returning();
    if (!installation) throw new Error('Failed to create test installation');

    try {
      expect(installation.agentApiToken).not.toBe('agent-api-token');
      expect(installation.signingSecret).not.toBe('agent-signing-secret');
      await expect(
        getMondayAgentInstallationSecrets(installation.agentId),
      ).resolves.toMatchObject({
        agentApiToken: 'agent-api-token',
        signingSecret: 'agent-signing-secret',
      });

      await expectConstraintViolation(
        db.insert(mondayAgentInstallations).values({
          accountId: `account-${randomUUID()}`,
          agentId: `agent-${randomUUID()}`,
          ownerMcpConnectionId: connection.id,
          agentApiToken: 'another-token',
          signingSecret: 'another-secret',
        }),
        'monday_agent_installations_singleton_unique',
      );

      const [recovery] = await db
        .insert(mondayAgentInstallations)
        .values({
          singletonKey: null,
          accountId: installation.accountId,
          agentId: `recovery-${randomUUID()}`,
          ownerMcpConnectionId: connection.id,
          agentApiToken: 'recovery-token',
          signingSecret: 'recovery-secret',
          status: 'error',
          error: 'provider cleanup failed',
        })
        .returning();
      expect(recovery).toMatchObject({
        singletonKey: null,
        accountId: installation.accountId,
        status: 'error',
      });
      await expect(
        getMondayAgentInstallationSecrets(installation.agentId),
      ).resolves.toMatchObject({ agentApiToken: 'agent-api-token' });

      await expectConstraintViolation(
        db.delete(mcpConnections).where(eq(mcpConnections.id, connection.id)),
        'monday_agent_installations_owner_mcp_connection_id_mcp_connecti',
      );
    } finally {
      await db
        .delete(mondayAgentInstallations)
        .where(
          eq(mondayAgentInstallations.ownerMcpConnectionId, connection.id),
        );
      await db
        .delete(mcpConnections)
        .where(eq(mcpConnections.id, connection.id));
    }
  });
});
