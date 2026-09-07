import { db } from '../db';
import { checkMigrationReadiness } from '../lib/migration-readiness';

// Runs against the real test database, which drizzle-kit pushes directly:
// it has tables but no migration bookkeeping.
describe('migration readiness against the test database', () => {
  it('reports a push-managed schema as unmanaged', async () => {
    await expect(checkMigrationReadiness(db)).resolves.toEqual({
      state: 'unmanaged',
    });
  });
});
