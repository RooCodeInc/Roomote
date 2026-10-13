// Independent controller observer for the persistence regression test.
import { db, eq, taskRuns } from '@roomote/db/server';
import { BaseController } from '../BaseController';

class Observer extends BaseController {
  constructor() {
    super('development');
  }
  protected async spawnFreshWorker(): Promise<void> {
    throw new Error('No provider dispatch expected');
  }
  observe(run: typeof taskRuns.$inferSelect, exitCode: number) {
    return this.handleWorkerExitBeforeStart(run, exitCode);
  }
}

const run = await db.query.taskRuns.findFirst({
  where: eq(taskRuns.id, Number(process.argv[2])),
});
if (!run) throw new Error('Owned fixture run not found');

process.once('message', async (message: { exitCode: number }) => {
  try {
    const result = await new Observer().observe(run, message.exitCode);
    process.send?.({ result }, () => process.exit(0));
  } catch (error) {
    process.send?.({ error: String(error) }, () => process.exit(1));
  }
});
process.send?.({ ready: true });
