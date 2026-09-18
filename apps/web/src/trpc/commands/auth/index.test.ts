import { generateKeyPairSync } from 'node:crypto';
import {
  configureAuthClientEnv,
  MAX_RUN_TOKEN_TIMEOUT_MS,
  validateRunToken,
} from '@roomote/auth';
import {
  automations,
  customAutomations,
  db,
  eq,
  runFactory,
  taskFactory,
  tasks,
  userFactory,
} from '@roomote/db/server';
import type { UserAuthSuccess } from '@/types';
import { canAccessTask } from '@/lib/server/custom-automation-task-access';
import { appRouter } from '@/trpc/routers/_app';

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  configureAuthClientEnv({
    nodeEnv: 'test',
    jobAuthPrivateKey: privateKey,
    jobAuthPublicKey: publicKey,
  });
});

afterAll(() => configureAuthClientEnv(null));

async function fixture() {
  const owner = await userFactory.create();
  const other = await userFactory.create();
  const admin = await userFactory.create({ role: 'admin' });
  const auth = (userId: string, isAdmin = false) =>
    ({
      success: true,
      userType: 'user',
      userId,
      isAdmin,
    }) as UserAuthSuccess;
  await db
    .insert(automations)
    .values({ key: 'custom_automation' })
    .onConflictDoNothing();
  const [automation] = await db
    .insert(customAutomations)
    .values({
      name: `Sandbox token ${owner.id}`,
      prompt: 'Test automation',
      createdByUserId: owner.id,
    })
    .returning();
  const task = await taskFactory.create({
    initiatorKind: 'automation',
    initiatorAutomation: 'custom_automation',
    actorExternalId: automation!.id,
  });
  const run = await runFactory.create({ taskId: task.id });
  return {
    task,
    run,
    automation: automation!,
    ownerAuth: auth(owner.id),
    otherAuth: auth(other.id),
    adminAuth: auth(admin.id, true),
  };
}

// Keep the real router, protected procedure, database and signing path. Return
// verified claims rather than credentials so assertion failures cannot log JWTs.
async function mint(
  auth: UserAuthSuccess,
  input: { runId: number; timeoutMs?: number },
) {
  const token = await appRouter.createCaller({ auth }).auth.sandboxToken(input);
  return token === undefined ? undefined : validateRunToken(token);
}

describe('auth.sandboxToken authorization', () => {
  it('denies a member who cannot access the custom automation task', async () => {
    const { task, run, otherAuth } = await fixture();
    expect(await canAccessTask(otherAuth, task.id)).toBe(false);
    await expect(mint(otherAuth, { runId: run.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Task not found',
    });
  });

  it('allows the automation owner and admin with their own identity', async () => {
    const { run, ownerAuth, adminAuth } = await fixture();
    for (const auth of [ownerAuth, adminAuth]) {
      await expect(mint(auth, { runId: run.id })).resolves.toEqual({
        runId: run.id,
        userId: auth.userId,
        principal: 'user',
        tokenType: 'run',
        version: 1,
      });
    }
  });

  it('preserves ordinary task collaboration', async () => {
    const { ownerAuth, otherAuth } = await fixture();
    const task = await taskFactory.create({
      initiatorKind: 'user',
      initiatorUserId: ownerAuth.userId,
      initiatorAutomation: null,
      actorExternalId: null,
    });
    const run = await runFactory.create({ taskId: task.id });
    await expect(mint(otherAuth, { runId: run.id })).resolves.toMatchObject({
      runId: run.id,
      userId: otherAuth.userId,
    });
  });

  it('returns undefined for a missing run', async () => {
    const { otherAuth } = await fixture();
    await expect(mint(otherAuth, { runId: -1 })).resolves.toBeUndefined();
  });

  it('rejects an unauthenticated caller', async () => {
    const result = appRouter
      .createCaller({ auth: { success: false, error: 'Unauthenticated' } })
      .auth.sandboxToken({ runId: -1 })
      .then(() => 'unexpected success');
    await expect(result).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it.each(['deleted', 'creatorless', 'absent', 'malformed'] as const)(
    'fails closed for %s automation provenance while allowing admins',
    async (provenance) => {
      const { task, run, automation, ownerAuth, adminAuth } = await fixture();
      if (provenance === 'deleted') {
        await db
          .delete(customAutomations)
          .where(eq(customAutomations.id, automation.id));
      } else if (provenance === 'creatorless') {
        await db
          .update(customAutomations)
          .set({ createdByUserId: null })
          .where(eq(customAutomations.id, automation.id));
      } else {
        await db
          .update(tasks)
          .set({ actorExternalId: provenance === 'absent' ? null : 'invalid' })
          .where(eq(tasks.id, task.id));
      }
      await expect(mint(ownerAuth, { runId: run.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(mint(adminAuth, { runId: run.id })).resolves.toMatchObject({
        runId: run.id,
        userId: adminAuth.userId,
      });
    },
  );

  it.each([undefined, 60_000, MAX_RUN_TOKEN_TIMEOUT_MS])(
    'preserves the signed TTL for timeoutMs=%s',
    async (timeoutMs) => {
      const { run, ownerAuth } = await fixture();
      const token = await appRouter
        .createCaller({ auth: ownerAuth })
        .auth.sandboxToken({ runId: run.id, timeoutMs });
      expect(typeof token).toBe('string');
      await validateRunToken(token!);
      const payload = JSON.parse(
        Buffer.from(token!.split('.')[1]!, 'base64url').toString('utf8'),
      ) as { exp: number; iat: number };
      expect(payload.exp - payload.iat).toBe(
        (timeoutMs ?? MAX_RUN_TOKEN_TIMEOUT_MS) / 1000 + 5 * 60,
      );
    },
  );

  it.each([0, -1, MAX_RUN_TOKEN_TIMEOUT_MS + 1])(
    'rejects invalid timeoutMs=%s at the router',
    async (timeoutMs) => {
      const { run, ownerAuth } = await fixture();
      await expect(
        mint(ownerAuth, { runId: run.id, timeoutMs }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    },
  );
});
