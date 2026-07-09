import { Factory } from 'fishery';
import { TaskPayloadKind } from '@roomote/types';

import type { Run, CreateRun } from '../../types';
import { taskRuns } from '../../schema';
import { type DatabaseOrTransaction, db } from '../../db';

import { taskFactory } from './task.factory';

export const runFactory = Factory.define<
  CreateRun,
  { db?: DatabaseOrTransaction },
  Run
>(({ params, onCreate, transientParams }) => {
  onCreate(async (values) => {
    const database = transientParams.db || db;

    // `task_runs.task_id` is a real FK now; create a backing task when the
    // test did not supply one.
    const taskId =
      values.taskId ||
      (await taskFactory.transient({ db: database }).create()).id;

    const [inserted] = await database
      .insert(taskRuns)
      .values({ ...values, taskId })
      .returning();

    if (!inserted) {
      throw new Error('Failed to insert task run');
    }

    return inserted;
  });

  return {
    payloadKind: params.payloadKind || TaskPayloadKind.StandardTask,
    kind: params.kind || 'fresh',
    payload: (params.payload as CreateRun['payload']) || {
      repo: 'test/repo',
      description: 'Factory task run',
    },
    actingUserId: params.actingUserId,
    taskId: params.taskId ?? '',
  } satisfies CreateRun;
});
