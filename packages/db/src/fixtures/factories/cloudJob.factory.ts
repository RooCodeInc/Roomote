import { Factory } from 'fishery';
import { CloudTaskType } from '@roomote/types';

import type { CloudJob, CreateCloudJob } from '../../types';
import { cloudJobs } from '../../schema';
import { type DatabaseOrTransaction, db } from '../../db';
import { generateTaskId } from '../../lib/task-id';

export const cloudJobFactory = Factory.define<
  CreateCloudJob,
  { db?: DatabaseOrTransaction },
  CloudJob
>(({ params, onCreate, transientParams }) => {
  onCreate(async (values) => {
    const database = transientParams.db || db;

    const [inserted] = await database
      .insert(cloudJobs)
      .values(values)
      .returning();

    if (!inserted) {
      throw new Error('Failed to insert cloud job');
    }

    return inserted;
  });

  return {
    type: params.type || CloudTaskType.StandardTask,
    payload: (params.payload as CreateCloudJob['payload']) || {
      repo: 'test/repo',
      description: 'Factory cloud job',
    },
    userId: params.userId,
    taskId: params.taskId || generateTaskId(),
  } satisfies CreateCloudJob;
});
