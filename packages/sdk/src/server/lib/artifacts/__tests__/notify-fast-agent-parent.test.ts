import { randomUUID } from 'node:crypto';
import {
  db,
  and,
  eq,
  sql,
  taskFactory,
  userFactory,
  taskRuns,
  taskArtifacts,
  fastAgentConversations,
  fastAgentParentEvents,
} from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';
import { createTaskArtifactRecord } from '../create-record';
import { notifyFastAgentParentOnArtifact } from '../notify-fast-agent-parent';
import { buildFastAgentDeliveryClaimPredicate } from '../../task-runs/fast-agent-delivery-claim';

vi.mock('../../../../../../../apps/api/src/handlers/artifacts/auth', () => ({
  resolveArtifactRouteAuth: () => ({ ok: true, auth: {} }),
  verifyArtifactRouteTaskBinding: async () => ({ ok: true }),
}));

const mocks = vi.hoisted(() => ({
  wake: vi.fn(),
  deliver: vi.fn(),
  normalize: vi.fn(),
}));
vi.mock('../../fast-agent-parent-event', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../fast-agent-parent-event')>()),
  deliverFastAgentParentEvent: mocks.deliver,
}));
vi.mock('../../fast-agent-parent-event-queue', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../fast-agent-parent-event-queue')
    >();
  mocks.normalize.mockImplementation(actual.normalizeFastAgentParentEvent);
  return {
    ...actual,
    normalizeFastAgentParentEvent: mocks.normalize,
    wakeFastAgentParentEventNow: mocks.wake,
  };
});

async function fixture(parentExists = true) {
  const user = await userFactory.create();
  const task = await taskFactory.create();
  const sessionId = randomUUID();
  if (parentExists)
    await db.insert(fastAgentConversations).values({
      id: sessionId,
      userId: user.id,
      surface: 'web',
      workspaceId: 'test-workspace',
      conversationId: sessionId,
    });
  const parent = {
    sessionId,
    conversation: {
      surface: 'web' as const,
      workspaceId: 'test-workspace',
      conversationId: sessionId,
      replyTarget: { sessionId },
    },
  };
  const [run] = await db
    .insert(taskRuns)
    .values({
      taskId: task.id,
      payloadKind: TaskPayloadKind.GithubPrReviewSync,
      payload: { repo: 'owner/repo', fastAgentParent: parent },
    })
    .returning();
  const artifact = await createTaskArtifactRecord({
    taskId: task.id,
    runId: run!.id,
    path: 'plans/test.md',
    artifactType: 'plan',
    contentType: 'text/markdown',
    size: 10,
  });
  return {
    artifact: { ...artifact!, taskId: task.id, uploaded: true },
    sessionId,
  };
}

beforeEach(() => {
  mocks.wake.mockReset().mockResolvedValue(undefined);
  mocks.deliver
    .mockReset()
    .mockRejectedValue(new Error('synthetic parent unavailable'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it('publishes once and durably admits one notification across concurrent confirmation retries', async () => {
  const { artifact, sessionId } = await fixture();
  const results = await Promise.all([
    notifyFastAgentParentOnArtifact(artifact),
    notifyFastAgentParentOnArtifact(artifact),
  ]);
  expect(results.every((result) => result === 'queued')).toBe(true);
  const published = await db.query.taskArtifacts.findFirst({
    where: eq(taskArtifacts.id, artifact.id),
  });
  expect(published?.uploaded).toBe(true);
  const rows = await db.query.fastAgentParentEvents.findMany({
    where: eq(fastAgentParentEvents.conversationId, sessionId),
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.event).toMatchObject({
    type: 'artifact_published',
    artifact: { id: artifact.id, version: 1 },
  });
  expect(mocks.deliver).not.toHaveBeenCalled();
});

it('rolls publication back if durable notification admission fails', async () => {
  const { artifact } = await fixture();
  mocks.normalize.mockImplementationOnce(() => {
    throw new Error('synthetic admission failure');
  });
  await expect(notifyFastAgentParentOnArtifact(artifact)).rejects.toThrow();
  const row = await db.query.taskArtifacts.findFirst({
    where: eq(taskArtifacts.id, artifact.id),
  });
  expect(row?.uploaded).toBe(false);
  expect(mocks.wake).not.toHaveBeenCalled();
});

it('publishes without a notification when the parent has been removed', async () => {
  const { artifact } = await fixture(false);
  await expect(notifyFastAgentParentOnArtifact(artifact)).resolves.toBe(
    'skipped',
  );
  expect(
    (
      await db.query.taskArtifacts.findFirst({
        where: eq(taskArtifacts.id, artifact.id),
      })
    )?.uploaded,
  ).toBe(true);
});

it('keeps publication successful when the queue wakeup fails; the event remains recoverable', async () => {
  const { artifact, sessionId } = await fixture();
  mocks.wake.mockRejectedValueOnce(new Error('synthetic queue unavailable'));
  await expect(notifyFastAgentParentOnArtifact(artifact)).resolves.toBe(
    'queued',
  );
  expect(
    await db.query.fastAgentParentEvents.findMany({
      where: eq(fastAgentParentEvents.conversationId, sessionId),
    }),
  ).toHaveLength(1);
});

it('does not re-notify an artifact delivered by the previous inline path', async () => {
  const { artifact, sessionId } = await fixture();
  await db
    .update(taskRuns)
    .set({ result: { [`fastAgentArtifact:${artifact.id}`]: 'delivered' } })
    .where(eq(taskRuns.id, artifact.runId!));
  await expect(notifyFastAgentParentOnArtifact(artifact)).resolves.toBe(
    'already_delivered',
  );
  expect(
    await db.query.fastAgentParentEvents.findMany({
      where: eq(fastAgentParentEvents.conversationId, sessionId),
    }),
  ).toHaveLength(0);
});

it('preserves a live legacy lease without admitting a second artifact notification', async () => {
  const { artifact, sessionId } = await fixture();
  const key = `fastAgentArtifact:${artifact.id}`;
  const marker = `delivering:${Date.now()}`;
  await db
    .update(taskRuns)
    .set({ result: { [key]: marker } })
    .where(eq(taskRuns.id, artifact.runId!));
  await expect(notifyFastAgentParentOnArtifact(artifact)).resolves.toBe(
    'in_progress',
  );
  expect(
    (
      await db.query.taskArtifacts.findFirst({
        where: eq(taskArtifacts.id, artifact.id),
      })
    )?.uploaded,
  ).toBe(true);
  expect(
    await db.query.fastAgentParentEvents.findMany({
      where: eq(fastAgentParentEvents.conversationId, sessionId),
    }),
  ).toHaveLength(0);
  expect(mocks.wake).not.toHaveBeenCalled();
  expect(
    (
      await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, artifact.runId!),
      })
    )?.result,
  ).toMatchObject({ [key]: marker });
});

it('allows queue handoff only after the legacy lease expires', async () => {
  const { artifact, sessionId } = await fixture();
  const key = `fastAgentArtifact:${artifact.id}`;
  await db
    .update(taskRuns)
    .set({ result: { [key]: `delivering:${Date.now() - 16 * 60_000}` } })
    .where(eq(taskRuns.id, artifact.runId!));
  await expect(notifyFastAgentParentOnArtifact(artifact)).resolves.toBe(
    'queued',
  );
  expect(
    await db.query.fastAgentParentEvents.findMany({
      where: eq(fastAgentParentEvents.conversationId, sessionId),
    }),
  ).toHaveLength(1);
});

it('reserves queued delivery against an older inline handler claiming the same artifact', async () => {
  const { artifact } = await fixture();
  const key = `fastAgentArtifact:${artifact.id}`;
  await notifyFastAgentParentOnArtifact(artifact);
  const legacyClaim = await db
    .update(taskRuns)
    .set({
      result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${key}::text, ${`delivering:${Date.now()}`}::text)`,
    })
    .where(
      and(
        eq(taskRuns.id, artifact.runId!),
        buildFastAgentDeliveryClaimPredicate(key),
      ),
    )
    .returning({ id: taskRuns.id });
  expect(legacyClaim).toHaveLength(0);
});

it('publishes standalone artifacts without creating parent events', async () => {
  const { artifact, sessionId } = await fixture();
  await db
    .update(taskRuns)
    .set({ payload: { repo: 'owner/repo' } })
    .where(eq(taskRuns.id, artifact.runId!));
  await expect(notifyFastAgentParentOnArtifact(artifact)).resolves.toBe(
    'not_applicable',
  );
  expect(
    (
      await db.query.taskArtifacts.findFirst({
        where: eq(taskArtifacts.id, artifact.id),
      })
    )?.uploaded,
  ).toBe(true);
  expect(
    await db.query.fastAgentParentEvents.findMany({
      where: eq(fastAgentParentEvents.conversationId, sessionId),
    }),
  ).toHaveLength(0);
});

it('avoids a second creation after parent unavailability in the actual worker/API publication flow', async () => {
  // Load the actual runtime callers without pulling another app into this
  // package's TypeScript build root. Vitest still transforms their source.
  const workerClientPath = new URL(
    '../../../../../../../apps/worker/src/mcp/roomote-mcp-server/api-client.ts',
    import.meta.url,
  ).href;
  const apiHandlerPath = new URL(
    '../../../../../../../apps/api/src/handlers/artifacts/upload-complete.ts',
    import.meta.url,
  ).href;
  const { uploadArtifact } = await import(workerClientPath);
  const { markArtifactUploadComplete } = await import(apiHandlerPath);
  const { artifact, sessionId } = await fixture();
  let creates = 0;
  let confirms = 0;
  let currentArtifact = artifact;
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url, options) => {
      if (String(url).includes('upload_complete')) {
        confirms++;
        return markArtifactUploadComplete({
          get: () => ({}),
          req: {
            param: () => currentArtifact.id,
            query: () => artifact.taskId,
          },
          json: (body: unknown, status: number) =>
            Response.json(body, { status }),
        } as never);
      }
      if (options?.method === 'PUT')
        return new Response(null, { headers: { etag: 'test-etag' } });
      creates++;
      if (creates > 1) {
        const next = await createTaskArtifactRecord({
          taskId: artifact.taskId!,
          runId: artifact.runId,
          path: artifact.path,
          artifactType: 'plan',
          contentType: artifact.contentType,
          size: artifact.size,
        });
        currentArtifact = { ...next!, taskId: artifact.taskId, uploaded: true };
      }
      return Response.json({
        id: currentArtifact.id,
        version: currentArtifact.version,
        uploadUrl: 'https://storage.example/upload',
        viewUrl: 'https://example.test/view',
        artifactType: 'plan',
      });
    });
  try {
    const upload = () =>
      uploadArtifact(
        { token: 'synthetic-token', platformApiUrl: 'https://example.test' },
        {
          taskId: artifact.taskId!,
          path: artifact.path,
          artifactType: 'plan',
          contentType: artifact.contentType,
          content: Buffer.from('# Synthetic plan'),
        },
      );
    let result;
    try {
      result = await upload();
    } catch {
      result = await upload().catch(() => undefined);
    }
    const versions = await db.query.taskArtifacts.findMany({
      where: eq(taskArtifacts.taskId, artifact.taskId!),
    });
    expect({
      creates,
      confirms,
      versions: versions.map((row) => row.version),
    }).toEqual({ creates: 1, confirms: 1, versions: [1] });
    expect(result?.artifactId).toBe(artifact.id);
    expect(
      await db.query.fastAgentParentEvents.findMany({
        where: eq(fastAgentParentEvents.conversationId, sessionId),
      }),
    ).toHaveLength(1);
  } finally {
    fetchMock.mockRestore();
  }
});
