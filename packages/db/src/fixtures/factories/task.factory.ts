import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { Task, CreateTask } from '../../types';
import { type DatabaseOrTransaction, db } from '../../db';
import { createTaskWithRetry } from '../../lib/tasks';

export const taskFactory = Factory.define<
  CreateTask,
  { db?: DatabaseOrTransaction },
  Task
>(({ params, onCreate, transientParams }) => {
  onCreate(async (values) => {
    const database = transientParams.db || db;

    return createTaskWithRetry(values, { db: database });
  });

  const {
    id,
    harnessSessionId,
    initiatorUserId,
    actorExternalId,
    timestamp,
    activityAt,
    ...rest
  } = params;
  const resolvedTimestamp = timestamp ?? Math.floor(Date.now() / 1000);

  return {
    id,
    harnessSessionId: harnessSessionId || faker.string.uuid(),
    workflow: 'standard',
    surface: 'web',
    trigger: 'manual',
    visibility: 'visible',
    state: 'active',
    initiatorKind: 'user',
    initiatorUserId: initiatorUserId ?? null,
    // The initiator CHECK requires a user FK or a raw external actor id for
    // user-initiated tasks; fall back to a fake external actor when the test
    // did not supply a real user row.
    actorExternalId:
      actorExternalId ?? (initiatorUserId ? null : faker.string.uuid()),
    modelProvider: 'openai',
    model: 'gpt-4',
    timestamp: resolvedTimestamp,
    activityAt: activityAt ?? resolvedTimestamp,
    title: faker.lorem.sentence(),
    mode: faker.helpers.arrayElement(['code', 'architect', 'debug', 'ask']),
    repositoryUrl: null,
    repositoryName: null,
    defaultBranch: null,
    ...rest,
  } satisfies CreateTask;
});
