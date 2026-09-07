import {
  db,
  environmentFactory,
  ensureAutomationRows,
  githubInstallationFactory,
  eq,
  repositoryFactory,
  resolveTaskRunWritableRepositories,
  runFactory,
  taskFactory,
  taskRuns,
  userFactory,
  users,
} from '../../server';

async function createEnvironmentRun() {
  const actor = await userFactory.create();
  const task = await taskFactory.create({ initiatorUserId: actor.id });
  const environment = await environmentFactory.create({
    createdByUserId: actor.id,
    config: {
      name: 'Prepared workspace',
      repositories: [{ repository: 'example/prepared' }],
    },
  });
  const run = await runFactory.create({
    taskId: task.id,
    actingUserId: actor.id,
    payload: {
      repo: 'example/prepared',
      environmentId: environment.id,
      selectedRepositories: ['example/prepared'],
      repositoryProviders: { 'example/prepared': 'github' },
    },
  });
  return { actor, run };
}

describe('resolveTaskRunWritableRepositories', () => {
  it('includes cross-environment active repositories for every provider regardless of sync owner', async () => {
    const { run } = await createEnvironmentRun();
    const otherUser = await userFactory.create();
    const installation = await githubInstallationFactory.create({
      installedByUserId: otherUser.id,
    });
    const active = await Promise.all(
      (['github', 'gitlab', 'gitea', 'bitbucket', 'ado'] as const).map(
        (sourceControlProvider) =>
          repositoryFactory.create({
            sourceControlProvider,
            userId: otherUser.id,
            linkedByUserId: otherUser.id,
            installationId:
              sourceControlProvider === 'github' ? installation.id : null,
          }),
      ),
    );
    const inactive = await repositoryFactory.create({
      isActive: false,
      linkedByUserId: otherUser.id,
      installationId: installation.id,
    });
    const result = await resolveTaskRunWritableRepositories(db, run);
    expect(result?.map((row) => row.id)).toEqual(
      expect.arrayContaining(active.map((row) => row.id)),
    );
    expect(result?.some((row) => row.id === inactive.id)).toBe(false);
    expect(result?.every((row) => row.isActive)).toBe(true);
  });

  it('rejects a deleted current actor instead of falling back to the active owner', async () => {
    const { run } = await createEnvironmentRun();
    const deletedActor = await userFactory.create({ deletedAt: new Date() });
    await db
      .update(taskRuns)
      .set({ actingUserId: deletedActor.id })
      .where(eq(taskRuns.id, run.id));
    await expect(resolveTaskRunWritableRepositories(db, run)).rejects.toThrow(
      'not an active deployment member',
    );
  });

  it('uses the persisted current actor instead of a stale deleted actor', async () => {
    const { actor, run } = await createEnvironmentRun();
    const nextActor = await userFactory.create();
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, actor.id));
    await db
      .update(taskRuns)
      .set({ actingUserId: nextActor.id })
      .where(eq(taskRuns.id, run.id));
    await expect(resolveTaskRunWritableRepositories(db, run)).resolves.toEqual(
      expect.any(Array),
    );
  });

  it('rechecks the durable human owner when there is no live actor', async () => {
    const { actor, run } = await createEnvironmentRun();
    await db
      .update(taskRuns)
      .set({ actingUserId: null })
      .where(eq(taskRuns.id, run.id));
    await expect(resolveTaskRunWritableRepositories(db, run)).resolves.toEqual(
      expect.any(Array),
    );
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, actor.id));
    await expect(resolveTaskRunWritableRepositories(db, run)).rejects.toThrow(
      'not an active deployment member',
    );
  });

  it('retains trusted deployment automation runs without a human principal', async () => {
    const { run } = await createEnvironmentRun();
    await ensureAutomationRows(db);
    const task = await taskFactory.create({
      initiatorKind: 'automation',
      initiatorAutomation: 'slack_channel_auto_start',
      initiatorUserId: null,
      actorExternalId: null,
    });
    const automationRun = await runFactory.create({
      taskId: task.id,
      payload: run.payload,
    });
    await expect(
      resolveTaskRunWritableRepositories(db, automationRun),
    ).resolves.toEqual(expect.any(Array));
  });

  it('does not treat an unlinked external human as a trusted automation', async () => {
    const { run } = await createEnvironmentRun();
    const task = await taskFactory.create({
      initiatorKind: 'user',
      initiatorUserId: null,
      actorExternalId: 'unlinked-external-user',
    });
    const externalRun = await runFactory.create({
      taskId: task.id,
      payload: run.payload,
    });
    await expect(
      resolveTaskRunWritableRepositories(db, externalRun),
    ).rejects.toThrow('requires an active deployment member');
  });

  it('rejects missing runs and environments without a fallback', async () => {
    const { run } = await createEnvironmentRun();
    await expect(
      resolveTaskRunWritableRepositories(db, { ...run, id: -1 }),
    ).rejects.toThrow('Task run not found');
    await expect(
      resolveTaskRunWritableRepositories(db, {
        ...run,
        payload: {
          ...run.payload,
          environmentId: '00000000-0000-0000-0000-000000000000',
        },
      }),
    ).rejects.toThrow('Environment not found');
  });

  it.each([
    { repo: 'example/selected' },
    {
      repo: '__all_repositories__',
      selectedRepositories: ['example/selected'],
    },
    { repo: '__all_repositories__' },
  ])('does not expand non-environment scope: %j', async (payload) => {
    await expect(
      resolveTaskRunWritableRepositories(db, { id: -1, payload }),
    ).resolves.toBeNull();
  });
});
