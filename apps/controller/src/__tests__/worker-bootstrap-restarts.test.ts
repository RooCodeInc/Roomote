import { drizzle } from '@roomote/db/server';

import { buildPersistedWorkerBootstrapRestartsQuery } from '../worker-bootstrap-restarts';

describe('buildPersistedWorkerBootstrapRestartsQuery', () => {
  it('preserves the inner event table and outer run table in correlated SQL', () => {
    const database = drizzle.mock();
    const query = buildPersistedWorkerBootstrapRestartsQuery(database);
    const generated = query.toSQL();

    expect(generated.sql).toContain(
      '"task_run_events"."run_id" = "task_runs"."id"',
    );
    expect(generated.sql).toContain('"task_run_events"."source" = $2');
    expect(generated.sql).toContain(
      '"task_run_events"."details" ->> \'stage\' = \'worker_bootstrap_restart\'',
    );
    expect(generated.sql).not.toContain('"taskRuns"."run_id"');
    expect(generated.params).toEqual(['pending', 'run_lifecycle']);
  });
});
