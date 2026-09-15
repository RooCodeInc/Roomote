import { randomUUID } from 'node:crypto';

import { db, deploymentSettings, eq } from '@roomote/db/server';

vi.mock('./bootstrap-runtime-env', () => ({ bootstrapWebRuntimeEnv: vi.fn() }));

import { claimPreVerifiedEmailBootstrap } from './setup-bootstrap';

describe('claimPreVerifiedEmailBootstrap', () => {
  it('atomically consumes the claim once while setup is open', async () => {
    const deploymentId = `pre-verified-email-${randomUUID()}`;

    try {
      await expect(claimPreVerifiedEmailBootstrap(deploymentId)).resolves.toBe(
        true,
      );
      await expect(claimPreVerifiedEmailBootstrap(deploymentId)).resolves.toBe(
        false,
      );
    } finally {
      await db
        .delete(deploymentSettings)
        .where(eq(deploymentSettings.id, deploymentId));
    }
  });

  it('rejects an unclaimed token after setup completes', async () => {
    const deploymentId = `pre-verified-email-${randomUUID()}`;
    await db.insert(deploymentSettings).values({
      id: deploymentId,
      setupCompletedAt: new Date(),
    });

    try {
      await expect(claimPreVerifiedEmailBootstrap(deploymentId)).resolves.toBe(
        false,
      );
    } finally {
      await db
        .delete(deploymentSettings)
        .where(eq(deploymentSettings.id, deploymentId));
    }
  });
});
