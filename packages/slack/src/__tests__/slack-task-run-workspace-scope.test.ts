import {
  and,
  db,
  eq,
  runFactory,
  slackInstallationFactory,
  slackInstallations,
  taskFactory,
  taskRuns,
  userFactory,
} from '@roomote/db/server';
import { RunStatus } from '@roomote/types';

import { getSlackTaskRunWorkspacePredicate } from '../slack-task-run-workspace-scope';

describe('getSlackTaskRunWorkspacePredicate', () => {
  it('admits a legacy run only for the sole active Slack workspace', async () => {
    let assertionsCompleted = false;

    try {
      await db.transaction(async (tx) => {
        await tx.delete(slackInstallations);

        const user = await userFactory.transient({ db: tx }).create();
        const task = await taskFactory
          .transient({ db: tx })
          .create({ slackThreadTs: 'legacy-workspace-scope' });
        const run = await runFactory.transient({ db: tx }).create({
          taskId: task.id,
          kind: 'resume',
          payload: { repo: 'owner/repo' },
          status: RunStatus.Running,
        });

        await slackInstallationFactory.transient({ db: tx }).create({
          teamId: 'TLEGACY1',
          installedByUserId: user.id,
        });

        const soleWorkspaceMatch = await tx
          .select({ id: taskRuns.id })
          .from(taskRuns)
          .where(
            and(
              eq(taskRuns.id, run.id),
              getSlackTaskRunWorkspacePredicate('TLEGACY1'),
            ),
          );

        const secondInstallation = await slackInstallationFactory
          .transient({ db: tx })
          .create({
            teamId: 'TLEGACY2',
            installedByUserId: user.id,
            isActive: false,
          });

        const inactiveWorkspaceMatch = await tx
          .select({ id: taskRuns.id })
          .from(taskRuns)
          .where(
            and(
              eq(taskRuns.id, run.id),
              getSlackTaskRunWorkspacePredicate('TLEGACY1'),
            ),
          );

        await tx
          .update(slackInstallations)
          .set({ isActive: true })
          .where(eq(slackInstallations.id, secondInstallation.id));

        const ambiguousWorkspaceMatch = await tx
          .select({ id: taskRuns.id })
          .from(taskRuns)
          .where(
            and(
              eq(taskRuns.id, run.id),
              getSlackTaskRunWorkspacePredicate('TLEGACY1'),
            ),
          );

        const modernRun = await runFactory.transient({ db: tx }).create({
          taskId: task.id,
          payload: { repo: 'owner/repo', teamId: 'TLEGACY1' },
          status: RunStatus.Running,
        });
        const modernCorrectWorkspaceMatch = await tx
          .select({ id: taskRuns.id })
          .from(taskRuns)
          .where(
            and(
              eq(taskRuns.id, modernRun.id),
              getSlackTaskRunWorkspacePredicate('TLEGACY1'),
            ),
          );
        const modernWrongWorkspaceMatch = await tx
          .select({ id: taskRuns.id })
          .from(taskRuns)
          .where(
            and(
              eq(taskRuns.id, modernRun.id),
              getSlackTaskRunWorkspacePredicate('TLEGACY2'),
            ),
          );

        expect(soleWorkspaceMatch).toHaveLength(1);
        expect(inactiveWorkspaceMatch).toHaveLength(1);
        expect(ambiguousWorkspaceMatch).toHaveLength(0);
        expect(modernCorrectWorkspaceMatch).toHaveLength(1);
        expect(modernWrongWorkspaceMatch).toHaveLength(0);
        assertionsCompleted = true;
        tx.rollback();
      });
    } catch (error) {
      if (!assertionsCompleted) {
        throw error;
      }
    }
  });
});
